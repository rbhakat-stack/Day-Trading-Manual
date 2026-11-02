/**
 * RB v1.2 execution layer — CR-01 latency, CR-03/04 immutable alert-time snapshot vs live execution state,
 * CR-05 terminal staleness, CR-06 frozen reference score, CR-07 tier / execution / actionability separation,
 * CR-09 freshness gates, CR-10 gate sequencing, CR-13 end of day. The RB v1.1 decision is never changed.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue, type QueueInput } from '../liveQueue';
import { etToEpoch } from '../etTime';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import type { Candidate, ManualPosition } from '../../ranker/opportunityTypes';
import { RB_V1_DEFAULTS } from '../../settings';
import { recordWith } from './fixtures';
import { alertLatency, latencyLabel } from '../lifecycle/latency';
import { freezeAlertSnapshots, SNAPSHOT_FINALIZE_MS, type AlertSnapshotMap } from '../lifecycle/alertTimeSnapshot';
import { eodStatus } from '../lifecycle/executionState';

const ALERT = '2026-10-30T10:15:04-04:00';
const T0 = Date.parse(ALERT);
const NOW = T0 + 60_000;
const quote = (price: number, now = NOW, ageMs = 500): LiveQuote => ({ price, tradeIso: new Date(now - 1000).toISOString(), fetchedIso: new Date(now - ageMs).toISOString(), receivedMs: now - ageMs });
const SECTORS: Record<string, string> = { XYZ: 'S-X', FIS: 'Fintech', AAA: 'S-A' };

function run(records: AutoAlertRecord[], o: Partial<QueueInput> & { prices?: Record<string, number> } = {}) {
  const now = o.now ?? NOW;
  const quotes: Record<string, LiveQuote> = {};
  for (const r of records) quotes[r.alert.symbol] = quote(o.prices?.[r.alert.symbol] ?? r.initialQuote!.price, now);
  return buildQueue({
    records, candidates: [], positions: [], quotes: { ...quotes, ...(o.quotes ?? {}) }, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(),
    classify: (s) => (SECTORS[s] ? { sector: SECTORS[s], industry: SECTORS[s], theme: '' } : null), parity: {}, strategyVersion: 'RB v1.1', ...o,
  });
}
const strong = (symbol: string, extra: Partial<Parameters<typeof recordWith>[0]> = {}, values: Record<string, number> = {}) =>
  recordWith({ symbol, direction: 'LONG', alertIso: ALERT, price: 100.95, ...extra, values: { ...values } });
const weak = () => strong('FIS', {}, { rvol: 1.5, rsi: 56, ema9: 100.15, ema20: 100.1 });

/** Run the queue the way the app does: freeze snapshots after each pass and feed them into the next one. */
function session(rec: AutoAlertRecord, steps: { now: number; price: number }[]) {
  let candidates: Candidate[] = [];
  let frozen: AlertSnapshotMap = {};
  return steps.map((s) => {
    const out = run([rec], { candidates, frozen, now: s.now, prices: { [rec.alert.symbol]: s.price } });
    candidates = out.candidates;
    frozen = freezeAlertSnapshots(frozen, out.rows, s.now, 91).map;
    return { row: out.rows[0], frozen: frozen[rec.id] };
  });
}

describe('CR-01 latency from persisted timestamps', () => {
  const rec = { ...strong('XYZ', { receivedMs: etToEpoch('2026-10-30', '10:15:09') }), processedIso: new Date(etToEpoch('2026-10-30', '10:15:16')).toISOString() };
  it('signal close 10:15:00 → received +9 s → ready +7 s → total 16 s', () => {
    const l = alertLatency(rec);
    expect([l.signalCloseAt, l.signalCloseSource, l.receiptLagSec, l.processingSec, l.totalSec]).toEqual([etToEpoch('2026-10-30', '10:15'), 'ALERT_TIME', 9, 7, 16]);
    expect(latencyLabel(l)).toBe('Latency 16s');
  });
  it('the mapped v1.2 signal candle is preferred over the alert-time boundary', () => {
    const mapped = { ...rec, v12: { signalMapping: { candleEndMs: etToEpoch('2026-10-30', '10:10') } } } as unknown as AutoAlertRecord;
    expect(alertLatency(mapped)).toMatchObject({ signalCloseSource: 'MAPPED', totalSec: 316 });
  });
  it('never uses the clock: identical at any time; no decision time yet → "Latency —"', () => {
    expect(alertLatency(rec)).toEqual(alertLatency(structuredClone(rec)));
    expect(latencyLabel(alertLatency({ ...rec, processedIso: null }))).toBe('Latency —');
  });
  it('latency does not affect the decision', () => {
    const slow = { ...rec, processedIso: new Date(etToEpoch('2026-10-30', '10:16:30')).toISOString() };
    expect(run([slow]).rows[0].decision).toEqual(run([rec]).rows[0].decision);
  });
});

describe('CR-03 immutable alert-time snapshot', () => {
  const steps = session(strong('XYZ'), [{ now: NOW, price: 100.95 }, { now: NOW + 30_000, price: 101.4 }, { now: NOW + 90_000, price: 100.9 }]);
  const snap = steps[0].frozen;
  it('freezes identity, OHLC, indicators, trade construction, v1.1 score/tier and provenance on the first complete scoring', () => {
    expect(snap).toMatchObject({ symbol: 'XYZ', direction: 'LONG', complete: true, missing: [], ohlc: { open: 100, high: 101, low: 100, close: 101, atr: 1 }, provenance: { provider: 'Alpaca', feed: 'sip', rulesVersion: 'RB v1.1' } });
    expect(snap.indicators).toMatchObject({ rvol: 4, rsi: 67, vwap: 100.3 });
    expect(snap.trade).toMatchObject({ entry: steps[0].row.candidate!.entry, stop: steps[0].row.candidate!.stop, shares: steps[0].row.candidate!.shares });
    expect(snap.v11.total).toBe(steps[0].row.ranked!.total);
    expect(snap.v11.tier).toBe(steps[0].row.ranked!.tier);
    expect(snap.expiresAtMs).toBe(T0 + 10 * 60_000);
  });
  it('is never rewritten by later price moves, hard fails or rescoring (same object)', () => {
    expect(steps[1].frozen).toBe(snap);
    expect(steps[2].frozen).toBe(snap);
    expect(steps[1].row.live!.action).toBe('SKIP_CHASED');
  });
  it('an alert that cannot complete is finalized 60 s after receipt with the gaps listed', () => {
    const rec: AutoAlertRecord = { ...strong('AAA'), status: 'ENRICHING' };
    const early = run([rec], { now: rec.receivedMs + 10_000 });
    expect(freezeAlertSnapshots({}, early.rows, rec.receivedMs + 10_000, 91).changed).toBe(false);
    const t = rec.receivedMs + SNAPSHOT_FINALIZE_MS;
    const s = freezeAlertSnapshots({}, run([rec], { now: t }).rows, t, 91).map[rec.id];
    expect(s).toMatchObject({ complete: false, missing: ['v1.1 decision'] });
  });
});

describe('CR-04 / CR-05 / CR-06 / CR-07 execution state separate from the snapshot', () => {
  it('fresh, valid, ≥ 85 → tier HIGH/ELITE · ACTIVE · READY', () => {
    const [s] = session(strong('XYZ'), [{ now: NOW, price: 100.95 }]);
    expect(s.row.decision.ticket).not.toBeNull();
    expect(s.row.lifecycle).toMatchObject({ executionState: 'ACTIVE', finalActionability: 'READY', score: { basis: 'LIVE' } });
    expect(['ELITE', 'HIGH_PRIORITY']).toContain(s.row.lifecycle.alertTimeTier);
  });
  it('chased after alert time → CHASED · NO TRADE; frozen score shown for reference only, NOT RANKED', () => {
    const [a, b] = session(strong('XYZ'), [{ now: NOW, price: 100.95 }, { now: NOW + 30_000, price: 101.4 }]);
    expect(b.row.lifecycle).toMatchObject({ executionState: 'CHASED', finalActionability: 'NO TRADE', score: { value: a.row.ranked!.total, basis: 'FROZEN — REFERENCE ONLY', rank: 'NOT RANKED' } });
    expect(b.row.lifecycle.alertTimeTier).toBe(a.row.lifecycle.alertTimeTier);
  });
  it('late (crossed ≤ 0.25 ATR) → LATE — REVIEW, never WATCHLIST, no ticket', () => {
    const [, b] = session(strong('XYZ'), [{ now: NOW, price: 100.95 }, { now: NOW + 30_000, price: 101.1 }]);
    expect(b.row.decision.ticket).toBeNull();
    expect(b.row.lifecycle).toMatchObject({ executionState: 'LATE — REVIEW', finalActionability: 'NO TICKET' });
    expect(b.row.lifecycle.executionState).not.toMatch(/WATCHLIST/);
  });
  it('10 minutes → EXPIRED — STALE, terminal; never revived when price returns below the trigger', () => {
    const steps = session(strong('XYZ'), [{ now: NOW, price: 100.95 }, { now: T0 + 10 * 60_000, price: 100.95 }, { now: T0 + 12 * 60_000, price: 100.9 }]);
    for (const s of steps.slice(1)) {
      expect(s.row.lifecycle).toMatchObject({ executionState: 'EXPIRED — STALE', finalActionability: 'NO TRADE', terminal: true, score: { basis: 'FROZEN — REFERENCE ONLY', rank: 'NOT RANKED' } });
      expect(s.row.decision.ticket).toBeNull();
    }
  });
  it('a submitted order is SUBMITTED even after the alert window (broker owns it)', () => {
    const [s] = session(strong('XYZ'), [{ now: NOW, price: 100.95 }]);
    const pending = s.row.candidate ? [{ ...s.row.candidate, status: 'PENDING' as const }] : [];
    const out = run([strong('XYZ')], { candidates: pending, now: T0 + 11 * 60_000 });
    expect(out.rows[0].lifecycle.executionState).toBe('SUBMITTED');
  });
  it('the RB v1.1 decision is identical with or without the execution layer inputs', () => {
    const rec = strong('XYZ');
    const [s] = session(rec, [{ now: NOW, price: 100.95 }]);
    const a = run([rec], { now: NOW + 5000 });
    const b = run([rec], { now: NOW + 5000, frozen: { [rec.id]: s.frozen } });
    expect(b.rows[0].decision).toEqual(a.rows[0].decision);
    expect(b.rows[0].ranked).toEqual(a.rows[0].ranked);
  });
});

describe('CR-09 freshness gates stay hard', () => {
  it('Case A — current price 6 s old → NO READY', () => {
    const r = run([strong('XYZ')], { quotes: { XYZ: quote(100.95, NOW, 6000) } }).rows[0];
    expect(r.lifecycle.finalActionability).not.toBe('READY');
    expect(r.decision.ticket).toBeNull();
  });
  it('Case B — last trade 120 s old → NO READY', () => {
    const r = run([strong('XYZ')], { quotes: { XYZ: { ...quote(100.95), tradeIso: new Date(NOW - 120_000).toISOString() } } }).rows[0];
    expect(r.lifecycle.finalActionability).not.toBe('READY');
  });
});

describe('CR-10 gate sequencing', () => {
  it('score fails → Portfolio NOT EVALUATED — NOT REQUIRED, Capital NOT ATTEMPTED', () => {
    const r = run([weak()]).rows[0];
    expect(r.lifecycle.gates).toEqual({ score: 'FAIL', portfolio: 'NOT EVALUATED — NOT REQUIRED', capital: 'NOT ATTEMPTED' });
  });
  it('score passes, no position slot → BLOCKED — NO_POSITION_SLOT, Capital NOT ATTEMPTED, no ticket', () => {
    const pos = (t: string): ManualPosition => ({ id: t, ticker: t, direction: 'LONG', sector: `S${t}`, industry: `I${t}`, theme: '', positionValue: 5000, plannedRisk: 50, entry: 10, stop: 9, target: 12, status: 'OPEN' });
    const r = run([strong('XYZ')], { positions: ['P1', 'P2', 'P3', 'P4'].map(pos) }).rows[0];
    expect(r.lifecycle.gates).toEqual({ score: 'PASS', portfolio: 'BLOCKED — NO_POSITION_SLOT', capital: 'NOT ATTEMPTED' });
    expect(r.lifecycle).toMatchObject({ executionState: 'PORTFOLIO BLOCKED', finalActionability: 'NO TICKET' });
  });
  it('all pass → PASS / PASS / PASS', () => {
    expect(run([strong('XYZ')]).rows[0].lifecycle.gates).toEqual({ score: 'PASS', portfolio: 'PASS', capital: 'PASS' });
  });
});

describe('CR-13 end of day — detect and flag only', () => {
  const D = '2026-10-30';
  const c = (status: Candidate['status'], ticker: string) => ({ status, ticker, date: D, archived: false }) as Candidate;
  const at = (t: string, cands: Candidate[] = [], pos: ManualPosition[] = []) => eodStatus(etToEpoch(D, t), cands, pos);
  it('before 15:30 normal; from 15:30 no new entries', () => {
    expect(at('15:29')).toMatchObject({ phase: 'OPEN', noNewEntries: false });
    expect(at('15:30')).toMatchObject({ phase: 'NO NEW ENTRIES', noNewEntries: true, actionRequired: false });
  });
  it('15:50 with an unfilled order → EOD CANCEL REQUIRED', () => {
    expect(at('15:50', [c('PENDING', 'A')])).toMatchObject({ phase: 'EOD CANCEL REQUIRED', actionRequired: true, pendingOrders: 1 });
  });
  it('15:55 with an open position → EOD EXIT REQUIRED', () => {
    expect(at('15:55', [c('FILLED', 'B')])).toMatchObject({ phase: 'EOD EXIT REQUIRED', openPositions: 1 });
  });
  it('15:58–16:00 must be FLAT', () => {
    expect(at('15:58', [c('FILLED', 'B')])).toMatchObject({ phase: 'FLAT REQUIRED', actionRequired: true });
    expect(at('15:59')).toMatchObject({ phase: 'FLAT', actionRequired: false });
  });
  it('a ticket after 15:30 is flagged NO TICKET by the execution layer (the v1.1 decision itself is unchanged)', () => {
    const late = recordWith({ symbol: 'XYZ', direction: 'LONG', alertIso: '2026-10-30T15:29:04-04:00', price: 100.95, values: {} });
    const now = Date.parse('2026-10-30T15:31:00-04:00');
    const r = run([late], { now }).rows[0];
    if (r.decision.ticket) expect(r.lifecycle).toMatchObject({ executionState: 'ACTIVE', finalActionability: 'NO TICKET' });
    expect(r.lifecycle.finalActionability).not.toBe('READY');
    expect(r.lifecycle.eod.noNewEntries).toBe(true);
  });
});

describe('CR-11 archive / retention', () => {
  it('0–10 min operational; > 10 min stale but visible; next session or ≥ 12 h archived', async () => {
    const { retentionState } = await import('../lifecycle/alertTimeSnapshot');
    expect(retentionState(T0, T0 + 9 * 60_000)).toBe('OPERATIONAL');
    expect(retentionState(T0, T0 + 11 * 60_000)).toBe('STALE_VISIBLE');
    expect(retentionState(T0, T0 + 5 * 3_600_000)).toBe('STALE_VISIBLE');
    expect(retentionState(T0, T0 + 12 * 3_600_000)).toBe('ARCHIVED');
    expect(retentionState(T0, etToEpoch('2026-11-02', '09:30'))).toBe('ARCHIVED');
  });
  it('snapshots are pruned after 90 days only; history export is a dated CSV of frozen values', async () => {
    const { pruneAlertSnapshots, alertSnapshotsCsv } = await import('../lifecycle/alertTimeSnapshot');
    const [s] = session(strong('XYZ'), [{ now: NOW, price: 100.95 }]);
    const map = { [s.frozen.recordId]: s.frozen };
    expect(pruneAlertSnapshots(map, T0 + 89 * 86_400_000)).toBe(map);
    expect(pruneAlertSnapshots(map, T0 + 91 * 86_400_000)).toEqual({});
    const csv = alertSnapshotsCsv(map).trim().split('\n');
    expect(csv).toHaveLength(2);
    expect(csv[0]).toMatch(/^date,recordId,symbol,direction/);
    expect(csv[1]).toContain('2026-10-30');
    expect(csv[1]).toContain(String(s.frozen.v11.total));
    expect(alertSnapshotsCsv(map, '2026-10-31').trim().split('\n')).toHaveLength(1);
  });
});

describe('CR-10 gate sequencing for unscored records', () => {
  it('DATA_ERROR (no ranking) → NOT SCORED / NOT EVALUATED / NOT ATTEMPTED, never PENDING', () => {
    const rec: AutoAlertRecord = { ...strong('XYZ'), status: 'DATA_ERROR', snapshot: null as unknown as AutoAlertRecord['snapshot'], errors: ['provider error'] };
    const r = run([rec]).rows[0];
    expect(r.decision.decision).toBe('DATA REVIEW REQUIRED');
    expect(r.lifecycle.gates).toEqual({ score: 'NOT SCORED', portfolio: 'NOT EVALUATED — NOT REQUIRED', capital: 'NOT ATTEMPTED' });
  });
});
