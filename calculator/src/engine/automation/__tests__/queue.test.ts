/**
 * Automated path end to end: frozen snapshot → shared calculator → shared ranker → final safety gate → ticket.
 * Covers spec parts 53–59 plus batching, duplicates, capital priority, correlation, replacement and data gates.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, releasedIds, ticketString, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue, type QueueInput } from '../liveQueue';
import { inputsFromRecord } from '../autoCandidate';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import type { Candidate, ManualPosition } from '../../ranker/opportunityTypes';
import { RB_V1_DEFAULTS } from '../../settings';
import { evaluateTrade } from '../../tradeCalculator';
import { recordWith } from './fixtures';

const ALERT = '2026-10-30T10:15:04-04:00';
const T0 = Date.parse(ALERT);
const NOW = T0 + 60_000;
const quote = (price: number, now = NOW, ageMs = 500): LiveQuote => ({ price, tradeIso: new Date(now - 1000).toISOString(), fetchedIso: new Date(now - ageMs).toISOString(), receivedMs: now - ageMs });
const SECTORS: Record<string, string> = { NVDA: 'Semis', AVGO: 'Semis', GM: 'Autos', IBM: 'IT Services', FIS: 'Fintech', AAA: 'S-A', BBB: 'S-B', CCC: 'S-C', XYZ: 'S-X' };

function run(records: AutoAlertRecord[], o: Partial<QueueInput> & { prices?: Record<string, number> } = {}) {
  const quotes: Record<string, LiveQuote> = {};
  for (const r of records) quotes[r.alert.symbol] = quote(o.prices?.[r.alert.symbol] ?? r.initialQuote!.price, o.now ?? NOW);
  return buildQueue({
    records,
    candidates: [],
    positions: [],
    quotes: { ...quotes, ...(o.quotes ?? {}) },
    now: NOW,
    cfg: DEFAULT_AUTOMATION,
    rb: RB_V1_DEFAULTS,
    rk: cloneRankerDefaults(),
    classify: (s) => (SECTORS[s] ? { sector: SECTORS[s], industry: SECTORS[s], theme: '' } : null),
    parity: {},
    strategyVersion: 'RB v1.1',
    ...o,
  });
}
const row = (out: ReturnType<typeof run>, sym: string) => out.rows.find((r) => r.record.alert.symbol === sym)!;

/** A strong LONG on a $100 stock with ATR 1 (scores in the 90s with ample capital). */
const strong = (symbol: string, extra: Partial<Parameters<typeof recordWith>[0]> = {}, values: Record<string, number> = {}) =>
  recordWith({ symbol, direction: 'LONG', alertIso: ALERT, price: 100.95, ...extra, values: { ...values } });

/* ───────────────────────── deterministic calculations through the automated path ───────────────────────── */

describe('§53 deterministic LONG (GM) through the shared calculator', () => {
  const gm = recordWith({
    symbol: 'GM', direction: 'LONG', alertIso: ALERT, price: 85.45,
    values: { open: 85.4, high: 85.52, low: 85.38, close: 85.5, atr: 0.167, ema9: 85.45, ema20: 85.35, vwap: 85.42, rsi: 67, rvol: 3.6, close15m: 85.5, ema20_15m: 85.3 },
  });
  it('buffer 0.02, entry 85.54, R 0.17 (ATR rounded up), stop 85.37, target 85.88, 233 shares, BUY STOP', () => {
    const r = evaluateTrade(inputsFromRecord(gm, 85.45, NOW, RB_V1_DEFAULTS)!, RB_V1_DEFAULTS);
    expect([r.plan!.buffer, r.plan!.entry, r.plan!.riskPerShare, r.plan!.riskMethod, r.plan!.stop, r.plan!.target, r.plan!.shares]).toEqual([0.02, 85.54, 0.17, 'ATR', 85.37, 85.88, 233]);
    expect(r.action).toBe('BUY_STOP');
  });
  it('the queue candidate carries exactly the calculator numbers', () => {
    const c = row(run([gm]), 'GM').candidate!;
    expect([c.entry, c.stop, c.target, c.shares]).toEqual([85.54, 85.37, 85.88, 233]);
  });
});

describe('§54 deterministic SHORT (NVDA)', () => {
  const nvda = recordWith({
    symbol: 'NVDA', direction: 'SHORT', alertIso: ALERT, price: 212.35,
    values: { open: 212.73, high: 212.76, low: 212.25, close: 212.4, atr: 0.34, ema9: 212.5, ema20: 212.65, vwap: 212.6, rsi: 33, rvol: 3.8, close15m: 212.4, ema20_15m: 212.8 },
  });
  const out = run([nvda]);
  const r = row(out, 'NVDA');
  it('buffer 0.04, entry 212.21, structural risk 0.55, stop 212.76, target 211.11, 94 shares (cap), SELL STOP', () => {
    const e = evaluateTrade(inputsFromRecord(nvda, 212.35, NOW, RB_V1_DEFAULTS)!, RB_V1_DEFAULTS);
    expect([e.plan!.buffer, e.plan!.entry, e.plan!.structuralRisk, e.plan!.stop, e.plan!.target, e.plan!.shares]).toEqual([0.04, 212.21, 0.55, 212.76, 211.11, 94]);
    expect(e.action).toBe('SELL_STOP');
  });
  it('actionable ticket: SELL | STOP | 94 | 212.21 | SL 212.76 | TP 211.11', () => {
    expect(r.decision.decision).toMatch(/^TRADE NOW — ELITE|^HIGH PRIORITY/);
    expect(r.decision.ticket).toEqual({ action: 'SELL', orderType: 'STOP', quantity: 94, price: 212.21, stopLoss: 212.76, takeProfit: 211.11 });
    expect(ticketString(r.decision.ticket!)).toBe('SELL | STOP | 94 | 212.21 | SL 212.76 | TP 211.11');
    expect(r.decision.gate.every((g) => g.pass === true)).toBe(true);
  });
});

describe('§55 chase: SHORT entry 204.83, current 204.60, ATR 0.533 → 0.43 ATR → DO NOT CHASE', () => {
  const rec = recordWith({
    symbol: 'NVDA', direction: 'SHORT', alertIso: ALERT, price: 204.6,
    values: { open: 205.15, high: 205.2, low: 204.87, close: 204.9, atr: 0.533, ema9: 205.0, ema20: 205.3, vwap: 205.2, rsi: 35, rvol: 3, close15m: 204.9, ema20_15m: 205.4 },
  });
  const out = run([rec]);
  const r = row(out, 'NVDA');
  it('entry 204.83, chase 0.23 = 0.43 ATR → NOT ELIGIBLE, no ticket', () => {
    expect(r.candidate!.entry).toBe(204.83);
    expect(r.live!.chase!.distance).toBeCloseTo(0.23, 10);
    expect(r.live!.chase!.distanceAtr).toBeCloseTo(0.4315, 3);
    expect(r.decision).toMatchObject({ decision: 'NOT ELIGIBLE', detail: 'DO NOT CHASE', ticket: null });
  });
});

/* ───────────────────────── ranking of simultaneous alerts ───────────────────────── */

describe('§57 simultaneous alerts are ranked by score, not arrival order', () => {
  const t = (s: number) => T0 + 1500 + s; // all within one micro-batch
  const recs = [
    strong('FIS', { receivedMs: t(0) }, { rvol: 1.5, rsi: 56, ema9: 100.15, ema20: 100.1 }), // arrives first, weakest
    strong('GM', { receivedMs: t(100) }, { rvol: 2.0, rsi: 62 }),
    strong('IBM', { receivedMs: t(200) }, { rvol: 2.5 }),
    strong('NVDA', { receivedMs: t(300) }), // arrives last, strongest
  ];
  const out = run(recs, { now: t(300) + 4000 });
  it('order NVDA, IBM, GM; FIS skipped', () => {
    const score = (s: string) => row(out, s).ranked!.total as number;
    expect(score('NVDA')).toBeGreaterThan(score('IBM'));
    expect(score('IBM')).toBeGreaterThan(score('GM'));
    expect(score('GM')).toBeGreaterThanOrEqual(85);
    expect(score('FIS')).toBeLessThan(80);
    expect(['NVDA', 'IBM', 'GM'].map((s) => row(out, s).ranked!.rank)).toEqual([1, 2, 3]);
    expect(out.rows.slice(0, 3).map((r) => r.record.alert.symbol)).toEqual(['NVDA', 'IBM', 'GM']);
    expect(row(out, 'FIS').decision.section).toBe('IGNORE');
    expect(row(out, 'FIS').decision.ticket).toBeNull();
    expect(row(out, 'NVDA').decision.ticket?.action).toBe('BUY');
  });
  it('before the batch window ends, nothing is shown as ranked (no early #1)', () => {
    const early = run(recs, { now: t(300) + 1000 });
    expect(early.rows.every((r) => r.decision.decision === 'SCORING')).toBe(true);
    expect(early.rows.every((r) => r.decision.ticket === null)).toBe(true);
  });
});

describe('§31 capital priority: A 87-ish, B best, C second; capital for two', () => {
  it('B and C get tickets; A becomes the capital waitlist (no ticket)', () => {
    const held: ManualPosition[] = [1, 2].map((i) => ({ id: `p${i}`, ticker: `H${i}`, direction: 'LONG', sector: `HS${i}`, industry: `HI${i}`, theme: '', positionValue: 20000, plannedRisk: 50, entry: 10, stop: 9, target: 12, status: 'OPEN' }));
    const recs = [strong('AAA', { receivedMs: T0 + 1000 }, { rvol: 2.0, rsi: 62 }), strong('BBB', { receivedMs: T0 + 1100 }), strong('CCC', { receivedMs: T0 + 1200 }, { rvol: 2.5 })];
    const out = run(recs, { positions: held });
    expect(row(out, 'BBB').decision.ticket).not.toBeNull();
    expect(row(out, 'CCC').decision.ticket).not.toBeNull();
    expect(row(out, 'AAA').decision).toMatchObject({ section: 'WATCHLIST', ticket: null });
    expect(row(out, 'AAA').ranked!.recommendation).toMatch(/CAPITAL WAITLIST|BLOCKED/);
  });
});

describe('data-blocked alerts never consume capital', () => {
  it('a higher-scoring alert with a price-source mismatch does not push a valid alert onto the waitlist', () => {
    const held: ManualPosition[] = [1, 2, 3].map((i) => ({ id: `p${i}`, ticker: `H${i}`, direction: 'LONG', sector: `HS${i}`, industry: `HI${i}`, theme: '', positionValue: 19000, plannedRisk: 50, entry: 10, stop: 9, target: 12, status: 'OPEN' }));
    const out = run([strong('AAA', { receivedMs: T0 + 1000, lastPrice: 102 }), strong('BBB', { receivedMs: T0 + 1100 }, { rvol: 2.5 })], { positions: held }); // one slot left
    expect(row(out, 'AAA').decision).toMatchObject({ decision: 'DATA REVIEW REQUIRED', ticket: null });
    expect(row(out, 'AAA').ranked!.rank).toBeNull();
    expect(row(out, 'AAA').ranked!.total).toBeGreaterThan(row(out, 'BBB').ranked!.total as number);
    expect(row(out, 'BBB').decision.ticket).not.toBeNull();
    expect(row(out, 'BBB').ranked!.rank).toBe(1);
  });
});

describe('§32 correlation: the higher-ranked correlated candidate wins', () => {
  it('NVDA ticket; AVGO BLOCKED — CORRELATED EXPOSURE', () => {
    const out = run([strong('AVGO', { receivedMs: T0 + 1000 }, { rvol: 2.5 }), strong('NVDA', { receivedMs: T0 + 1100 })]);
    expect(row(out, 'NVDA').decision.ticket).not.toBeNull();
    expect(row(out, 'AVGO').decision).toMatchObject({ detail: 'BLOCKED — CORRELATED EXPOSURE', ticket: null });
  });
});

describe('§33 pending-order replacement is a prompt only', () => {
  it('pending 86-ish vs new strong candidate → STRONGER OPPORTUNITY; pending stays PENDING', () => {
    const pend = strong('AAA', {}, { rvol: 2.0, rsi: 62 });
    const first = run([pend]);
    const pending: Candidate = { ...first.candidates[0], status: 'PENDING' };
    const held: ManualPosition[] = [1, 2, 3].map((i) => ({ id: `p${i}`, ticker: `H${i}`, direction: 'LONG', sector: `HS${i}`, industry: `HI${i}`, theme: '', positionValue: 19000, plannedRisk: 50, entry: 10, stop: 9, target: 12, status: 'OPEN' }));
    const out = run([pend, strong('BBB', { receivedMs: T0 + 5000 })], { candidates: [pending], positions: held, now: NOW + 10_000 });
    expect(out.suggestions.some((s) => s.kind === 'STRONGER' && s.pendingTicker === 'AAA' && s.candidateTicker === 'BBB')).toBe(true);
    expect(out.candidates.find((c) => c.ticker === 'AAA')!.status).toBe('PENDING');
    expect(row(out, 'AAA').decision.decision).toBe('ORDER SUBMITTED');
  });
});

/* ───────────────────────── hard rules, data gates ───────────────────────── */

describe('§58 hard fail beats a 96 score', () => {
  it('alert 15:40 ET → NOT ELIGIBLE, no ticket', () => {
    const ok = run([strong('XYZ')]);
    expect(row(ok, 'XYZ').ranked!.total).toBeGreaterThanOrEqual(95);
    const late = recordWith({ symbol: 'XYZ', direction: 'LONG', alertIso: '2026-10-30T15:40:00-04:00', price: 100.95, values: {} });
    const out = run([late], { now: Date.parse('2026-10-30T15:41:00-04:00') });
    expect(row(out, 'XYZ').decision).toMatchObject({ decision: 'NOT ELIGIBLE', detail: 'NOT ELIGIBLE — NEW ENTRY WINDOW CLOSED', ticket: null });
  });
});

describe('§59 missing data fails closed', () => {
  it('ATR unavailable → DATA REVIEW REQUIRED / DATA INCOMPLETE, never ATR = 0, never TRADE NOW', () => {
    const rec = strong('XYZ', { issues: [{ kind: 'INCOMPLETE', code: 'ATR14_UNAVAILABLE', message: 'ATR14 could not be calculated.' }] });
    rec.snapshot!.values = null;
    const r = row(run([rec]), 'XYZ');
    expect(r.decision).toMatchObject({ decision: 'DATA REVIEW REQUIRED', detail: 'DATA INCOMPLETE — DO NOT TRADE', ticket: null });
    expect(r.candidate).toBeNull();
  });
  it('DATA_ERROR record → manual review', () => {
    const rec = strong('XYZ');
    rec.status = 'DATA_ERROR';
    rec.errors = ['Alpaca 403: subscription does not permit querying recent SIP data'];
    expect(row(run([rec]), 'XYZ').decision).toMatchObject({ decision: 'DATA REVIEW REQUIRED', detail: 'DATA ERROR — MANUAL REVIEW REQUIRED', ticket: null });
  });
  it('stale current price (older than 5 s) → no TRADE NOW', () => {
    const r = row(run([strong('XYZ')], { quotes: { XYZ: quote(100.95, NOW, 6000) } }), 'XYZ');
    expect(r.decision).toMatchObject({ decision: 'DATA REVIEW REQUIRED', detail: 'STALE DATA — REFRESHING', ticket: null });
  });
  it('last trade older than 60 s → stale data', () => {
    const q: LiveQuote = { ...quote(100.95), tradeIso: new Date(NOW - 120_000).toISOString() };
    expect(row(run([strong('XYZ')], { quotes: { XYZ: q } }), 'XYZ').decision.ticket).toBeNull();
  });
  it('TrendSpider vs provider price mismatch → DATA MISMATCH review', () => {
    const r = row(run([strong('XYZ', { lastPrice: 101.5 })]), 'XYZ');
    expect(r.decision).toMatchObject({ decision: 'DATA REVIEW REQUIRED', detail: 'DATA MISMATCH — MANUAL REVIEW', ticket: null });
    expect(r.decision.reasons.join(' ')).toMatch(/PRICE SOURCE MISMATCH/);
  });
  it('a small, tolerated price difference does not block', () => {
    expect(row(run([strong('XYZ', { lastPrice: 100.97 })]), 'XYZ').decision.ticket).not.toBeNull();
  });
  it('data-parity mismatch for the alert → no ticket', () => {
    const rec = strong('XYZ');
    const r = row(run([rec], { parity: { [rec.id]: ['High: TrendSpider 101.05 vs automated 101.00'] } }), 'XYZ');
    expect(r.decision).toMatchObject({ decision: 'DATA REVIEW REQUIRED', ticket: null });
  });
  it('snapshot REVIEW issue (e.g. ambiguous signal candle) → no ticket', () => {
    const r = row(run([strong('XYZ', { issues: [{ kind: 'REVIEW', code: 'SIGNAL_CANDLE_AMBIGUOUS', message: 'ambiguous' }] })]), 'XYZ');
    expect(r.decision.detail).toBe('DATA MISMATCH — MANUAL REVIEW');
  });
});

describe('trigger states (missed breakouts are never converted)', () => {
  it('crossed by ≤ 0.25 ATR → manual review, no Market/Limit ticket', () => {
    const r = row(run([strong('XYZ')], { prices: { XYZ: 101.1 } }), 'XYZ');
    expect(r.live!.action).toBe('MARKET_LATE_ENTRY');
    expect(r.decision).toMatchObject({ detail: 'TRIGGER CROSSED — MANUAL REVIEW', ticket: null });
  });
  it('crossed by > 0.25 ATR → DO NOT CHASE', () => {
    expect(row(run([strong('XYZ')], { prices: { XYZ: 101.4 } }), 'XYZ').decision).toMatchObject({ decision: 'NOT ELIGIBLE', detail: 'DO NOT CHASE' });
  });
  it('10+ minutes without a trigger → STALE — DO NOT TRADE', () => {
    const r = row(run([strong('XYZ')], { now: T0 + 10.5 * 60_000 }), 'XYZ');
    expect(r.decision).toMatchObject({ decision: 'NOT ELIGIBLE', detail: 'STALE — DO NOT TRADE', ticket: null });
  });
  it('freshness bands: fresh < 5, aging 5–8, urgent 8–10 minutes', () => {
    expect(row(run([strong('XYZ')], { now: T0 + 60_000 }), 'XYZ').decision.freshness.band).toBe('FRESH');
    expect(row(run([strong('XYZ')], { now: T0 + 6 * 60_000 }), 'XYZ').decision.freshness.band).toBe('AGING');
    const u = row(run([strong('XYZ')], { now: T0 + 9 * 60_000 }), 'XYZ').decision.freshness;
    expect([u.band, Math.round(u.remainingMs / 1000)]).toEqual(['URGENT', 60]);
  });
  it('an unknown sector → SCORING INCOMPLETE review (never a fabricated score)', () => {
    const r = row(run([recordWith({ symbol: 'ZZZZ', direction: 'LONG', alertIso: ALERT, price: 100.95, values: {} })]), 'ZZZZ');
    expect(r.decision).toMatchObject({ decision: 'DATA REVIEW REQUIRED', detail: 'SCORING INCOMPLETE', ticket: null });
  });
});

/* ───────────────────────── batching, duplicates, immutability ───────────────────────── */

describe('micro-batching', () => {
  const r = (id: string, receivedMs: number, status: AutoAlertRecord['status'] = 'OK') => ({ id, receivedMs, status });
  it('alerts within 3 s are released together once the window is quiet', () => {
    const xs = [r('a', 0), r('b', 500), r('c', 2900)];
    expect([...releasedIds(xs, 3000, DEFAULT_AUTOMATION)]).toEqual([]);
    expect([...releasedIds(xs, 5900, DEFAULT_AUTOMATION)].sort()).toEqual(['a', 'b', 'c']);
  });
  it('a later, separate alert does not hold earlier batches', () => {
    expect([...releasedIds([r('a', 0), r('b', 10_000)], 10_500, DEFAULT_AUTOMATION)]).toEqual(['a']);
  });
  it('a member still enriching holds the batch; after 15 s the finished ones are released', () => {
    const xs = [r('a', 0), r('b', 500, 'ENRICHING')];
    expect([...releasedIds(xs, 5000, DEFAULT_AUTOMATION)]).toEqual([]);
    expect([...releasedIds(xs, 15_100, DEFAULT_AUTOMATION)]).toEqual(['a']);
  });
  it('batch duration is configurable', () => {
    expect([...releasedIds([r('a', 0)], 1100, { batchMs: 1000, maxBatchHoldMs: 15000 })]).toEqual(['a']);
  });
});

describe('duplicates — one live candidate / position per ticker', () => {
  it('a second fresh alert for the same ticker → DUPLICATE / EXISTING CANDIDATE', () => {
    const a = strong('XYZ');
    const b = recordWith({ symbol: 'XYZ', direction: 'LONG', alertIso: '2026-10-30T10:20:04-04:00', price: 100.95, values: {} });
    const first = run([a]);
    const out = run([a, b], { candidates: first.candidates, now: Date.parse('2026-10-30T10:21:00-04:00') });
    expect(row(out, 'XYZ').record.id).toBe(a.id);
    const second = out.rows.find((x) => x.record.id === b.id)!;
    expect(second.decision).toMatchObject({ decision: 'NOT ELIGIBLE', detail: 'DUPLICATE / EXISTING CANDIDATE', ticket: null });
    expect(out.candidates.filter((c) => c.ticker === 'XYZ')).toHaveLength(1);
  });
  it('an opposite-direction alert while a position exists is also a duplicate (never reverse)', () => {
    const a = strong('XYZ');
    const first = run([a]);
    const filled = first.candidates.map((c) => ({ ...c, status: 'FILLED' as const }));
    const s = recordWith({ symbol: 'XYZ', direction: 'SHORT', alertIso: '2026-10-30T10:40:04-04:00', price: 100, values: { open: 101, close: 100 } });
    const out = run([a, s], { candidates: filled, now: Date.parse('2026-10-30T10:41:00-04:00') });
    expect(out.rows.find((x) => x.record.id === s.id)!.decision.detail).toBe('DUPLICATE / EXISTING CANDIDATE');
    expect(out.rows.find((x) => x.record.id === a.id)!.decision.decision).toBe('IN POSITION');
  });
  it('after the earlier alert went stale, a new alert is processed normally', () => {
    const a = strong('XYZ');
    const first = run([a]);
    const b = recordWith({ symbol: 'XYZ', direction: 'LONG', alertIso: '2026-10-30T10:40:04-04:00', price: 100.95, values: {} });
    const out = run([a, b], { candidates: first.candidates, now: Date.parse('2026-10-30T10:41:00-04:00') });
    expect(out.rows.find((x) => x.record.id === b.id)!.decision.ticket).not.toBeNull();
  });
});

describe('alert-time values are frozen; only the current state changes', () => {
  it('price moves update calcAction/chase but never entry, stop, target, quantity, inputs or the initial score', () => {
    const rec = strong('XYZ');
    const first = run([rec]);
    const c0 = first.candidates[0];
    expect(c0.initialScore).not.toBeNull();
    const later = run([rec], { candidates: first.candidates, prices: { XYZ: 101.4 }, now: NOW + 30_000 });
    const c1 = later.candidates[0];
    expect([c1.entry, c1.stop, c1.target, c1.shares, c1.plannedRisk]).toEqual([c0.entry, c0.stop, c0.target, c0.shares, c0.plannedRisk]);
    expect(c1.inputs).toEqual(c0.inputs);
    expect(c1.initialScore).toEqual(c0.initialScore);
    expect([c0.calcAction, c1.calcAction]).toEqual(['BUY_STOP', 'SKIP_CHASED']);
    expect(rec.snapshot!.values!.high).toBe(101);
  });
  it('filled positions are not re-ranked or displaced', () => {
    const rec = strong('XYZ');
    const filled = run([rec]).candidates.map((c) => ({ ...c, status: 'FILLED' as const }));
    const out = run([rec, strong('AAA', { receivedMs: T0 + 9000 })], { candidates: filled, now: NOW + 20_000 });
    expect(row(out, 'XYZ').decision).toMatchObject({ decision: 'IN POSITION', section: 'ACTIVE', ticket: null });
    expect(out.candidates.find((c) => c.ticker === 'XYZ')!.status).toBe('FILLED');
  });
});
