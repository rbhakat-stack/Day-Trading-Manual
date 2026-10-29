/**
 * RB v1.1 — FROZEN FOR PAPER TESTING: regression tests for the final logic corrections
 * (hard-failed components show N/A; opposite-direction correlation counts by default),
 * the frozen configuration audit, and strategy versioning / historical immutability.
 */
import { describe, expect, it } from 'vitest';
import type { Candidate, ManualPosition, RankingInputs } from '../opportunityTypes';
import { TIER_LABELS } from '../opportunityTypes';
import { cloneRankerDefaults, migrateRankerSettings, RANKER_DEFAULTS, type RankerSettings } from '../rankerSettings';
import { allocate, buildPortfolio, type AllocationInput } from '../portfolioAllocator';
import { classifyScore, rankCandidates, snapshotOf } from '../candidateRanker';
import { candidateVersion } from '../rankerAnalytics';
import { RB_V1_DEFAULTS } from '../../settings';
import { evaluateTrade } from '../../tradeCalculator';
import {
  changedCoreFields,
  FROZEN_LABEL,
  isFrozenDefinition,
  nextVersion,
  resolveVersion,
  versionLabel,
} from '../../strategyVersion';

const D = '2026-10-29';
let seq = 0;

/** A strong, fully valid LONG candidate (ATR = 1.00). */
function cand(o: Partial<Omit<Candidate, 'inputs'>> & { inputs?: Partial<RankingInputs> } = {}): Candidate {
  seq += 1;
  const ticker = o.ticker ?? `T${seq}`;
  const { inputs, ...rest } = o;
  return {
    id: `f${seq}`, date: D, alertTime: '10:00', createdAt: seq, ticker, direction: 'LONG',
    open: 100, high: 101, low: 100, close: 101, atr: 1, currentPrice: 101,
    entry: 101.02, stop: 100.02, target: 103.02, shares: 99, positionValue: 10000, plannedRisk: 99, expectedReward: 198,
    orderType: 'BUY STOP', calcAction: 'BUY_STOP', calcReady: true, chaseDistanceAtr: -0.02, minutesSinceAlert: 1,
    scored: true, status: 'NEW', initialScore: null, entryScore: null, actualFill: null, exitPrice: null, notes: '',
    archived: false, keptAgainst: [],
    ...rest,
    inputs: {
      rvol: 4, rsi: 67, vwap: 100.3, ema9: 100.7, ema20: 100.1, close15m: 101, ema20_15m: 100,
      sector: `Sector ${ticker}`, industry: `Industry ${ticker}`, theme: '', ...inputs,
    },
  };
}

const short = (o: Partial<Omit<Candidate, 'inputs'>> & { inputs?: Partial<RankingInputs> } = {}) =>
  cand({
    direction: 'SHORT', open: 101, high: 101, low: 100, close: 100, currentPrice: 100, entry: 99.98, stop: 100.98, target: 97.98,
    calcAction: 'SELL_STOP', orderType: 'SELL STOP', ...o,
    inputs: { rsi: 33, vwap: 100.7, ema9: 100.3, ema20: 100.9, close15m: 100, ema20_15m: 101, ...o.inputs },
  });

const pos = (o: Partial<ManualPosition>): ManualPosition => ({
  id: `fp${++seq}`, ticker: `P${seq}`, direction: 'LONG', sector: `PS${seq}`, industry: `PI${seq}`, theme: '',
  positionValue: 20000, plannedRisk: 50, entry: 10, stop: 9, target: 12, status: 'OPEN', ...o,
});

const S = () => cloneRankerDefaults();
const one = (c: Candidate, positions: ManualPosition[] = [], s: RankerSettings = S()) => rankCandidates([c], positions, s, D).ranked[0];
const comp = (r: ReturnType<typeof one>, key: string) => r.components.find((x) => x.key === key)!;

const NVDA_POS = { ticker: 'NVDA', direction: 'LONG' as const, sector: 'Technology', industry: 'Semiconductors', theme: 'AI Chips' };
const AVGO_IN = { sector: 'Technology', industry: 'Semiconductors', theme: 'AI Infrastructure' };

/* ───────────────────────── Change 1: hard-failed components display N/A ───────────────────────── */

describe('§22 after-hours display (16:04 ET)', () => {
  const r = one(cand({ alertTime: '16:04' }));
  it('hard rule NOT ELIGIBLE — AFTER REGULAR SESSION; not scored, not ranked, blocked', () => {
    expect(r.hardFails[0].label).toBe('NOT ELIGIBLE — AFTER REGULAR SESSION');
    expect(r.recommendation).toBe('NOT ELIGIBLE — CANNOT BE RANKED');
    expect([r.total, r.setup, r.fit, r.tier, r.rank]).toEqual([null, null, null, null, null]);
    expect(r.allocation).toBeNull();
  });
  it('time component is N/A — AFTER REGULAR SESSION, never 8/10', () => {
    const t = comp(r, 'time');
    expect(t.na).toBe('N/A — AFTER REGULAR SESSION');
    expect(t.summary).toBe('N/A — AFTER REGULAR SESSION');
    expect(t.points).toBe(0);
    expect(t.summary).not.toMatch(/Afternoon/);
    expect(t.calc.join(' ')).not.toMatch(/\d+\/10/);
    expect(t.calc.join(' ')).toContain('16:04'); // raw input still visible for learning
  });
});

describe('§23 after 15:30 (15:31 ET)', () => {
  const r = one(cand({ alertTime: '15:31' }));
  it('NOT ELIGIBLE — NEW ENTRY WINDOW CLOSED with time N/A — OUTSIDE ELIGIBLE ENTRY WINDOW', () => {
    expect(r.hardFails[0].label).toBe('NOT ELIGIBLE — NEW ENTRY WINDOW CLOSED');
    expect(comp(r, 'time').na).toBe('N/A — OUTSIDE ELIGIBLE ENTRY WINDOW');
    expect(comp(r, 'time').calc.join(' ')).not.toMatch(/\d+\/10/);
    expect(r.total).toBeNull();
  });
  it('too early (09:40) is also outside the eligible window; 09:20 is before the regular session', () => {
    expect(comp(one(cand({ alertTime: '09:40' })), 'time').na).toBe('N/A — OUTSIDE ELIGIBLE ENTRY WINDOW');
    expect(comp(one(cand({ alertTime: '09:20' })), 'time').na).toBe('N/A — BEFORE REGULAR SESSION');
  });
});

describe('§24 valid afternoon trade (14:45 ET)', () => {
  it('time score 8/10 and no N/A anywhere', () => {
    const r = one(cand({ alertTime: '14:45' }));
    expect(r.strategyEligible).toBe(true);
    expect(comp(r, 'time').points).toBe(8);
    expect(comp(r, 'time').summary).toBe('Afternoon 2:00–3:30');
    expect(r.components.every((x) => x.na === undefined)).toBe(true);
    expect(r.total).not.toBeNull();
  });
});

describe('§2 generalised: components invalidated by a hard rule show N/A', () => {
  it('invalid LONG candle → Signal Candle N/A — INVALID LONG CANDLE', () => {
    const r = one(cand({ open: 101, close: 100 }));
    expect(comp(r, 'candle')).toMatchObject({ na: 'N/A — INVALID LONG CANDLE', points: 0 });
    expect(comp(r, 'time').na).toBeUndefined(); // only directly invalidated components
  });
  it('invalid SHORT candle → Signal Candle N/A — INVALID SHORT CANDLE', () => {
    expect(comp(one(short({ open: 100, close: 101 })), 'candle').na).toBe('N/A — INVALID SHORT CANDLE');
  });
  it('failed 15m confirmation → Trend N/A — HIGHER-TIMEFRAME CONFIRMATION FAILED', () => {
    const r = one(cand({ inputs: { close15m: 100, ema20_15m: 101 } }));
    expect(comp(r, 'trend').na).toBe('N/A — HIGHER-TIMEFRAME CONFIRMATION FAILED');
    expect(comp(r, 'trend').calc.join(' ')).toContain('15m Close 100');
  });
  it('chased entry → Location N/A', () => {
    expect(comp(one(cand({ chaseDistanceAtr: 0.3 })), 'location').na).toBe('N/A — CHASED ENTRY');
  });
  it('the frozen snapshot records N/A components and the strategy version', () => {
    const r = one(cand({ alertTime: '16:04' }));
    const snap = snapshotOf(r, 1, S(), undefined, 'RB v1.1');
    expect(snap.na?.time).toBe('N/A — AFTER REGULAR SESSION');
    expect(snap.strategyVersion).toBe('RB v1.1');
    expect(snap.total).toBeNull();
  });
});

describe('§3 / §29 hard fail still overrides everything', () => {
  it('a candidate that would score 95+ at 10:00 is NOT ELIGIBLE at 16:04, never ELITE', () => {
    const good = one(cand());
    expect(good.total).toBeGreaterThanOrEqual(95);
    expect(good.recommendation).toBe('TRADE NOW — ELITE');
    const late = one(cand({ alertTime: '16:04' }));
    expect(late.recommendation).toBe('NOT ELIGIBLE — CANNOT BE RANKED');
    expect(late.eligibilityLabel).toBe('NOT ELIGIBLE');
    expect([late.tier, late.rank, late.eligible]).toEqual([null, null, false]);
  });
  it('a hard-failed candidate never takes capital from, or ranks above, an eligible one', () => {
    const late = cand({ alertTime: '16:04', createdAt: 1 });
    const ok = cand({ createdAt: 2 });
    const r = rankCandidates([late, ok], [], S(), D);
    expect(r.ranked[0].candidate.id).toBe(ok.id);
    expect(r.ranked.find((x) => x.candidate.id === late.id)!.rank).toBeNull();
    expect(r.ranked[0].rankOf).toBe(1);
  });
});

/* ───────────────────────── Change 2: correlation counts both directions ───────────────────────── */

describe('§25–27 correlation policy (default: opposite direction is NOT exempt)', () => {
  it('defaults: max 1 per theme, hard block ON, opposite direction allowed OFF', () => {
    expect(RANKER_DEFAULTS.correlation).toEqual({ maxHighlyCorrelated: 1, hardBlock: true, allowOppositeDirection: false });
  });
  it('§25 NVDA LONG held, AVGO LONG candidate → BLOCKED — CORRELATED EXPOSURE', () => {
    expect(one(cand({ ticker: 'AVGO', inputs: AVGO_IN }), [pos(NVDA_POS)]).recommendation).toBe('BLOCKED — CORRELATED EXPOSURE');
  });
  it('§26 NVDA LONG held, AVGO SHORT candidate → BLOCKED — CORRELATED EXPOSURE', () => {
    const r = one(short({ ticker: 'AVGO', inputs: AVGO_IN }), [pos(NVDA_POS)]);
    expect(r.recommendation).toBe('BLOCKED — CORRELATED EXPOSURE');
    expect(r.hardRules.find((h) => h.key === 'correlation')!.pass).toBe(false);
  });
  it('NVDA SHORT held, AVGO SHORT candidate → BLOCKED', () => {
    expect(one(short({ ticker: 'AVGO', inputs: AVGO_IN }), [pos({ ...NVDA_POS, direction: 'SHORT' })]).recommendation).toBe('BLOCKED — CORRELATED EXPOSURE');
  });
  it('§26 only a deliberate setting change exempts opposite-direction exposure', () => {
    const s = S();
    s.correlation.allowOppositeDirection = true;
    const r = one(short({ ticker: 'AVGO', inputs: AVGO_IN }), [pos(NVDA_POS)], s);
    expect(r.hardRules.find((h) => h.key === 'correlation')!.pass).toBe(true);
    expect(r.recommendation).toBe('TRADE NOW — ELITE');
  });
  it('§27 NVDA LONG held, NEE SHORT (Utilities) → correlation passes; sides alone never block', () => {
    const r = one(short({ ticker: 'NEE', inputs: { sector: 'Utilities', industry: 'Electric Utilities', theme: 'Renewables' } }), [pos(NVDA_POS)]);
    expect(r.hardRules.find((h) => h.key === 'correlation')!.pass).toBe(true);
    expect(r.recommendation).not.toBe('BLOCKED — CORRELATED EXPOSURE');
  });
  it('a higher-ranked opposite-direction candidate in the same theme also consumes the slot', () => {
    const nvda = cand({ ticker: 'NVDA', inputs: { sector: 'Technology', industry: 'Semiconductors', theme: 'AI Chips' } });
    const avgo = short({ ticker: 'AVGO', inputs: { ...AVGO_IN, rvol: 2.5 } });
    const r = rankCandidates([avgo, nvda], [], S(), D);
    const a = r.ranked.find((x) => x.candidate.ticker === 'AVGO')!;
    expect(r.ranked.find((x) => x.candidate.ticker === 'NVDA')!.recommendation).toMatch(/^TRADE NOW/);
    expect(a.recommendation).toBe('BLOCKED — CORRELATED EXPOSURE');
    expect(a.allocation).toMatchObject({ allocated: false, reason: 'CORRELATION', correlatedWith: ['NVDA'] });
  });
  it('stored pre-v1.1 settings migrate to the conservative default', () => {
    const old = { ...cloneRankerDefaults(), correlation: { maxHighlyCorrelated: 1, hardBlock: true, sameDirectionOnly: true } } as unknown as RankerSettings;
    expect(migrateRankerSettings(old).correlation).toEqual({ maxHighlyCorrelated: 1, hardBlock: true, allowOppositeDirection: false });
    const chosen = { ...cloneRankerDefaults(), correlation: { maxHighlyCorrelated: 1, hardBlock: true, allowOppositeDirection: true } };
    expect(migrateRankerSettings(chosen).correlation.allowOppositeDirection).toBe(true);
  });
});

/* ───────────────────────── thresholds & capital priority ───────────────────────── */

describe('§28 score thresholds (unchanged)', () => {
  it.each([
    [92, 'ELITE', 'ELITE — PREFERRED CAPITAL ALLOCATION'],
    [87, 'HIGH_PRIORITY', 'HIGH PRIORITY — TRADE CONSIDERATION'],
    [82, 'WATCHLIST', 'WATCHLIST / RESERVE'],
    [77, 'LOW_PRIORITY', 'LOW PRIORITY'],
    [72, 'SKIP', 'SKIP — QUALITY BELOW THRESHOLD'],
  ])('%s → %s', (score, tier, label) => {
    const t = classifyScore(score as number, S());
    expect(t).toBe(tier);
    expect(TIER_LABELS[t]).toBe(label);
  });
});

describe('§30 capital priority: A 94, B 91, C 88, capital for two', () => {
  const ai = (id: string, score: number, createdAt: number): AllocationInput => ({
    id, ticker: id, direction: 'LONG', sector: `S-${id}`, industry: `I-${id}`, theme: '', score, setupScore: score * 0.7,
    alertTime: `10:0${createdAt}`, createdAt, positionValue: 19000, plannedRisk: 50,
  });
  it('A and B allocated, C CAPITAL waitlist, even when C arrived first', () => {
    const s = S();
    s.portfolio.maxPositions = 10; // isolate the capital constraint (slots would also run out at the default 4)
    const pf = buildPortfolio([pos({ positionValue: 20000, plannedRisk: 0 }), pos({ positionValue: 20000, plannedRisk: 0 })], [], s);
    const out = allocate([ai('C', 88, 1), ai('B', 91, 2), ai('A', 94, 3)], pf, s);
    expect(out.map((o) => [o.id, o.allocated])).toEqual([['A', true], ['B', true], ['C', false]]);
    expect(out[2].reason).toBe('CAPITAL');
  });
  it('end to end through rankCandidates: arrival order C, B, A does not override score', () => {
    const s = S();
    const held = [pos({ positionValue: 21000, plannedRisk: 0 }), pos({ positionValue: 21000, plannedRisk: 0 })]; // $38,000 left
    const C = cand({ ticker: 'C', createdAt: 1, alertTime: '10:01', positionValue: 19000, inputs: { rvol: 2.0 } });
    const B = cand({ ticker: 'B', createdAt: 2, alertTime: '10:02', positionValue: 19000, inputs: { rvol: 2.5 } });
    const A = cand({ ticker: 'A', createdAt: 3, alertTime: '10:03', positionValue: 19000, inputs: { rvol: 4 } });
    const r = rankCandidates([C, B, A], held, s, D).ranked;
    const by = (t: string) => r.find((x) => x.candidate.ticker === t)!;
    expect((by('A').total as number) > (by('B').total as number)).toBe(true);
    expect((by('B').total as number) > (by('C').total as number)).toBe(true);
    expect(by('C').total as number).toBeGreaterThanOrEqual(85);
    expect([by('A').rank, by('B').rank, by('C').rank]).toEqual([1, 2, 3]);
    expect(by('A').recommendation).toMatch(/^TRADE NOW/);
    expect(by('B').recommendation).toMatch(/^TRADE NOW/);
    expect(by('C').recommendation).toBe('CAPITAL WAITLIST');
  });
});

/* ───────────────────────── configuration audit (must not change) ───────────────────────── */

describe('RB v1.1 frozen configuration audit', () => {
  const s = RANKER_DEFAULTS;
  it('weights: setup 70 (15/15/10/10/10/10) + fit 30 (10/8/7/5)', () => {
    expect(s.weights).toEqual({ trend: 15, rvol: 15, momentum: 10, candle: 10, location: 10, time: 10, capitalEfficiency: 10, capitalAvailability: 8, correlation: 7, portfolioRisk: 5 });
  });
  it('thresholds 90 / 85 / 80 / 75, replacement advantage 5', () => {
    expect(s.grades).toEqual({ elite: 90, high: 85, watchlist: 80, low: 75 });
    expect(s.replacementAdvantage).toBe(5);
  });
  it('capital and risk policy', () => {
    expect(s.portfolio).toMatchObject({ accountEquity: 100000, maxPositionValue: 20000, liquidityReservePct: 0.2, maxPositions: 4, riskPerTradePct: 0.0025, heatPct: 0.01 });
    expect(s.portfolio.accountEquity * (1 - s.portfolio.liquidityReservePct)).toBe(80000);
  });
  it('RVOL bands 1.5/2.0/2.5/3.5 → 6/9/12/15', () => {
    expect(s.rvolBands.map((b) => [b.min, b.points])).toEqual([[1.5, 6], [2.0, 9], [2.5, 12], [3.5, 15]]);
  });
  it('RSI LONG bands 55–60 6 · 60–65 9 · 65–70 10 · 70–75 7 · ≥75 4', () => {
    expect(s.rsiBandsLong.map((b) => [b.from, b.to, b.points])).toEqual([[55, 60, 6], [60, 65, 9], [65, 70, 10], [70, 75, 7], [75, 101, 4]]);
  });
  it('time buckets 09:45 → 10 · 11:30 → 6 · 14:00 → 8; entry window 09:45–15:30', () => {
    expect(s.timeBuckets.map((b) => [b.start, b.points])).toEqual([['09:45', 10], ['11:30', 6], ['14:00', 8]]);
    expect([RB_V1_DEFAULTS.entryWindowStart, RB_V1_DEFAULTS.entryWindowEnd]).toEqual(['09:45', '15:30']);
  });
  it('calculator formulas unchanged (IBM LONG, NVDA SHORT)', () => {
    expect(RB_V1_DEFAULTS).toMatchObject({ minBuffer: 0.01, bufferPct: 0.0002, atrStopMultiple: 1, rewardMultiple: 2, chaseThresholdAtr: 0.25, riskPct: 0.0025, investmentCap: 20000, alertWindowMinutes: 10 });
    const base = { investmentAmount: 20000, accountEquity: 100000, riskPct: 0.0025, alertTime: '10:07', hasOpenPosition: false };
    const ibm = evaluateTrade({ ...base, ticker: 'IBM', direction: 'LONG', open: 255.3, high: 255.6, low: 255.24, close: 255.55, atr: 0.37, currentPrice: 255.5, close15m: 255.48, ema20_15m: 255 }).plan!;
    expect([ibm.buffer, ibm.entry, ibm.riskPerShare, ibm.stop, ibm.target, ibm.shares]).toEqual([0.05, 255.65, 0.41, 255.24, 256.47, 78]);
    const nvda = evaluateTrade({ ...base, ticker: 'NVDA', direction: 'SHORT', open: 212.95, high: 212.97, low: 212.57, close: 212.6, atr: 0.333, currentPrice: 212.7, close15m: 212.65, ema20_15m: 213.3 }).plan!;
    expect([nvda.buffer, nvda.entry, nvda.riskPerShare, nvda.stop, nvda.target, nvda.shares]).toEqual([0.04, 212.53, 0.44, 212.97, 211.65, 94]);
  });
});

/* ───────────────────────── versioning & historical immutability ───────────────────────── */

describe('§16–19 RB v1.1 — FROZEN FOR PAPER TESTING', () => {
  const rb = { ...RB_V1_DEFAULTS };
  it('the defaults are the frozen definition and carry the frozen label', () => {
    expect(FROZEN_LABEL).toBe('RB v1.1 — FROZEN FOR PAPER TESTING');
    expect(isFrozenDefinition(rb, S())).toBe(true);
    expect(versionLabel({ name: 'RB v1.1', locked: true }, rb, S())).toBe(FROZEN_LABEL);
  });
  it('normal inputs (account equity, broker buying power, labels) do not change the strategy definition', () => {
    const s = S();
    s.portfolio.accountEquity = 98000;
    s.portfolio.brokerBuyingPower = 400000;
    s.timeBuckets[0].label = 'Morning';
    expect(isFrozenDefinition({ ...rb, accountEquity: 98000 }, s)).toBe(true);
  });
  it.each([
    ['score weight', (s: RankerSettings) => void ((s.weights.rvol = 14), (s.weights.trend = 16)), 'weights'],
    ['minimum score', (s: RankerSettings) => void (s.grades.high = 84), 'grades'],
    ['risk per trade', (s: RankerSettings) => void (s.portfolio.riskPerTradePct = 0.003), 'riskPerTradePct'],
    ['time bucket', (s: RankerSettings) => void (s.timeBuckets[1].points = 7), 'timeBuckets'],
    ['correlation policy', (s: RankerSettings) => void (s.correlation.allowOppositeDirection = true), 'correlation'],
    ['max positions', (s: RankerSettings) => void (s.portfolio.maxPositions = 5), 'maxPositions'],
  ])('changing %s is a strategy-definition change', (_, mutate, field) => {
    const s = S();
    mutate(s);
    expect(isFrozenDefinition(rb, s)).toBe(false);
    expect(changedCoreFields([rb, S()], [rb, s])).toContain(field);
    expect(versionLabel({ name: 'RB v1.1', locked: false }, rb, s)).not.toBe(FROZEN_LABEL);
  });
  it.each([
    ['chase threshold', { chaseThresholdAtr: 0.3 }, 'chaseThresholdAtr'],
    ['ATR multiplier', { atrStopMultiple: 1.2 }, 'atrStopMultiple'],
  ])('changing the calculator %s is a strategy-definition change', (_, patch, field) => {
    expect(isFrozenDefinition({ ...rb, ...patch }, S())).toBe(false);
    expect(changedCoreFields([rb, S()], [{ ...rb, ...patch }, S()])).toEqual([field]);
  });
  it('next version is suggested; a modified definition is never silently called RB v1.1', () => {
    expect(nextVersion('RB v1.1')).toBe('RB v1.2');
    expect(nextVersion('RB v1.9')).toBe('RB v1.10');
    const s = S();
    s.grades.high = 84;
    expect(resolveVersion({ name: 'RB v1.1', locked: true }, rb, s).name).toBe('RB v1.2');
    expect(resolveVersion(null, rb, s).name).toBe('RB v1.2');
    expect(resolveVersion(null, rb, S())).toEqual({ name: 'RB v1.1', locked: true });
    expect(resolveVersion({ name: 'RB v1.2', locked: false }, rb, s)).toEqual({ name: 'RB v1.2', locked: false });
  });
  it('historical candidates keep their original version, score, components, decision and hard-rule state', () => {
    const s11 = S();
    const c = cand();
    const first = one(c, [], s11);
    c.initialScore = snapshotOf(first, 1, s11, undefined, 'RB v1.1');
    c.status = 'TARGET_HIT';
    c.exitPrice = 103.02;
    const frozen = JSON.parse(JSON.stringify(c.initialScore));
    const s12 = S();
    s12.weights.rvol = 10;
    s12.weights.trend = 20;
    s12.grades.high = 88;
    rankCandidates([c], [], s12, D); // later settings never rewrite the stored snapshot
    expect(c.initialScore).toEqual(frozen);
    expect(c.initialScore.strategyVersion).toBe('RB v1.1');
    expect(c.initialScore.total).toBe(first.total);
    expect(c.initialScore.components.rvol).toBe(15);
    expect(c.initialScore.decision).toBe('TRADE NOW — ELITE');
    expect(c.initialScore.hardRules.every((h) => h.pass)).toBe(true);
    expect(candidateVersion(c)).toBe('RB v1.1');
  });
  it('older snapshots without strategyVersion fall back to their scoring version', () => {
    const c = cand();
    c.initialScore = { ...snapshotOf(one(c), 1, S()), strategyVersion: undefined };
    expect(candidateVersion(c)).toBe('RB v1.1');
  });
});
