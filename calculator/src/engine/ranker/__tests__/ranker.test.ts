import { describe, expect, it } from 'vitest';
import type { Candidate, ManualPosition, RankingInputs, ScoreSnapshot } from '../opportunityTypes';
import { cloneRankerDefaults, DEFAULT_MAX, totalWeight, validateRankerSettings, type RankerSettings } from '../rankerSettings';
import {
  candleMetrics,
  scoreCandle,
  scoreCapitalAvailability,
  scoreCapitalEfficiency,
  scoreCorrelation,
  scoreLocation,
  scoreMomentum,
  scorePortfolioRisk,
  scoreRvol,
  scoreTime,
  scoreTrend,
} from '../opportunityScorer';
import { allocate, buildPortfolio, type AllocationInput } from '../portfolioAllocator';
import { assessCorrelation, correlationLevel } from '../correlationRules';
import { classifyScore, decide, rankCandidates, scoreComponents, snapshotOf } from '../candidateRanker';
import { performanceByComponent, performanceByScoreBucket, candidateR } from '../rankerAnalytics';
import { sampleDay } from '../rankerSamples';
import { fail } from '../../rules';

const D = '2026-10-29';
let seq = 0;

/** A "perfect" LONG candidate: every setup component at maximum (ATR = 1.00 makes distances easy to read). */
function cand(o: Partial<Omit<Candidate, 'inputs'>> & { inputs?: Partial<RankingInputs> } = {}): Candidate {
  seq += 1;
  const ticker = o.ticker ?? `T${seq}`;
  const { inputs, ...rest } = o;
  return {
    id: `c${seq}`, date: D, alertTime: '10:00', createdAt: seq, ticker, direction: 'LONG',
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
    calcAction: 'SELL_STOP', ...o,
    inputs: { rsi: 33, vwap: 100.7, ema9: 100.3, ema20: 100.9, close15m: 100, ema20_15m: 101, ...o.inputs },
  });

const pos = (o: Partial<ManualPosition>): ManualPosition => ({
  id: `p${++seq}`, ticker: `P${seq}`, direction: 'LONG', sector: `PS${seq}`, industry: `PI${seq}`, theme: '',
  positionValue: 20000, plannedRisk: 50, entry: 10, stop: 9, target: 12, status: 'OPEN', ...o,
});

const S = () => cloneRankerDefaults();
const emptyPf = (s: RankerSettings) => buildPortfolio([], [], s);
const one = (c: Candidate, positions: ManualPosition[] = [], s = S()) => rankCandidates([c], positions, s, D).ranked[0];
const rawTotal = (c: Candidate, s = S()) => scoreComponents(c, emptyPf(s), [], s).reduce((a, x) => a + x.points, 0);

/* ───────────────────────── 100-point structure ───────────────────────── */

describe('100-point structure', () => {
  it('default weights: setup 70 + fit 30 = 100', () => {
    const w = S().weights;
    expect(w.trend + w.rvol + w.momentum + w.candle + w.location + w.time).toBe(70);
    expect(w.capitalEfficiency + w.capitalAvailability + w.correlation + w.portfolioRisk).toBe(30);
    expect(totalWeight(w)).toBe(100);
    expect(DEFAULT_MAX).toEqual(w);
  });
  it('a perfect candidate scores exactly 100 (with ≥3 peers so capital efficiency can rank)', () => {
    const best = cand({ ticker: 'BEST', expectedReward: 400 });
    const r = rankCandidates([best, cand(), cand()], [], S(), D);
    const x = r.ranked.find((q) => q.candidate.id === best.id)!;
    expect(x.components.map((c) => c.points)).toEqual([15, 15, 10, 10, 10, 10, 10, 8, 7, 5]);
    expect([x.setup, x.fit, x.total]).toEqual([70, 30, 100]);
  });
  it('setup + fit always equals total, and never exceeds 70 / 30 / 100 (sample day)', () => {
    const s = S();
    const { candidates, positions } = sampleDay(D, '2026-10-28', s);
    for (const x of rankCandidates(candidates, positions, s, D).ranked) {
      if (x.total === null) continue;
      expect(Math.round(((x.setup as number) + (x.fit as number)) * 10) / 10).toBe(x.total);
      expect(x.setup).toBeLessThanOrEqual(70);
      expect(x.fit).toBeLessThanOrEqual(30);
      expect(x.total).toBeLessThanOrEqual(100);
      for (const c of x.components) expect(c.points).toBeLessThanOrEqual(c.max);
    }
  });
  it('validation: weights total 100, setup exactly 70, fit exactly 30', () => {
    const s = S();
    expect(validateRankerSettings(s)).toEqual([]);
    s.weights.rvol = 20;
    expect(validateRankerSettings(s)[0]).toMatch(/exactly 100/);
    const t = S();
    t.weights.rvol = 20; // setup 75
    t.weights.capitalEfficiency = 5; // fit 25, total still 100
    expect(validateRankerSettings(t).join(' ')).toMatch(/Setup Quality weights must total 70/);
  });
  it('edited weights rescale band points proportionally', () => {
    const s = S();
    s.weights.rvol = 10;
    s.weights.trend = 20;
    expect(scoreRvol(cand({ inputs: { rvol: 2.6 } }), s).points).toBe(8); // 12/15 × 10
    expect(scoreTrend(cand(), s).points).toBe(20);
  });
  it('extreme RVOL cannot exceed 15', () => expect(scoreRvol(cand({ inputs: { rvol: 50 } }), S()).points).toBe(15));
});

/* ───────────────────────── setup components ───────────────────────── */

describe('RVOL (15)', () => {
  const cases: [number, number, string][] = [
    [1.49, 0, 'BELOW'], [1.5, 6, 'NORMAL'], [1.99, 6, 'NORMAL'], [2.0, 9, 'ELEVATED'], [2.49, 9, 'ELEVATED'],
    [2.5, 12, 'STRONG'], [3.49, 12, 'STRONG'], [3.5, 15, 'EXCEPTIONAL'], [9, 15, 'EXCEPTIONAL'],
  ];
  it.each(cases)('RVOL %s → %s pts (%s)', (rvol, pts, label) => {
    const r = scoreRvol(cand({ inputs: { rvol } }), S());
    expect(r.points).toBe(pts);
    expect(r.summary).toContain(label);
  });
});

describe('Momentum (10) — strong without exhaustion', () => {
  it.each([[54.9, 0], [55, 6], [59.9, 6], [60, 9], [65, 10], [69.9, 10], [70, 7], [75, 4], [90, 4]])('LONG RSI %s → %s', (rsi, pts) => {
    expect(scoreMomentum(cand({ inputs: { rsi } }), S()).points).toBe(pts);
  });
  it.each([[46, 0], [44, 6], [40, 9], [33, 10], [28, 7], [20, 4]])('SHORT RSI %s → %s (mirror 100 − RSI)', (rsi, pts) => {
    expect(scoreMomentum(short({ inputs: { rsi } }), S()).points).toBe(pts);
  });
  it('highest RSI is NOT the highest score', () => {
    expect(scoreMomentum(cand({ inputs: { rsi: 80 } }), S()).points).toBeLessThan(scoreMomentum(cand({ inputs: { rsi: 67 } }), S()).points);
  });
});

describe('Signal candle (10) — documented formula', () => {
  it('ideal LONG candle = 10, Strong Breakout', () => {
    const m = candleMetrics({ open: 100, high: 101, low: 100, close: 101, direction: 'LONG' });
    expect(m.base).toBe(10);
    expect(m.classification).toBe('Strong Breakout Candle');
  });
  it('formula: ROUND(10 × (0.5 × body ratio + 0.5 × close location))', () => {
    const m = candleMetrics({ open: 100, high: 101, low: 99.5, close: 100.8, direction: 'LONG' });
    expect(m.bodyRatio).toBeCloseTo(0.8 / 1.5, 6);
    expect(m.closeLocation).toBeCloseTo(1.3 / 1.5, 6);
    expect(m.base).toBe(7);
  });
  it('opposing wick ≥ 50% → 2 (Rejection Risk)', () => {
    expect(candleMetrics({ open: 100, high: 102, low: 99.9, close: 100.3, direction: 'LONG' }).base).toBe(2);
  });
  it('SHORT uses lower wick and (H − C) ÷ range', () => {
    const m = candleMetrics({ open: 212.95, high: 212.97, low: 212.57, close: 212.6, direction: 'SHORT' });
    expect(m.closeLocation).toBeCloseTo(0.925, 6);
    expect(m.base).toBe(9);
  });
  it('H = L does not divide by zero', () => expect(candleMetrics({ open: 1, high: 1, low: 1, close: 1, direction: 'LONG' }).base).toBe(0));
  it('component uses the metrics', () => expect(scoreCandle(cand(), S()).points).toBe(10));
});

describe('Trend (15) — normalised by ATR', () => {
  it('perfect alignment = 15', () => expect(scoreTrend(cand(), S()).points).toBe(15));
  it('the same $0.30 EMA gap means more on a low-ATR stock than a high-ATR stock', () => {
    const lowAtr = scoreTrend(cand({ atr: 0.2, inputs: { ema9: 100.4, ema20: 100.1 } }), S());
    const highAtr = scoreTrend(cand({ atr: 3.0, inputs: { ema9: 100.4, ema20: 100.1 } }), S());
    expect(lowAtr.points).toBeGreaterThan(highAtr.points);
  });
  it('SHORT uses (EMA20 − EMA9) ÷ ATR', () => expect(scoreTrend(short(), S()).points).toBe(15));
  it('wrong side of VWAP caps the score at 4', () => expect(scoreTrend(cand({ inputs: { vwap: 101.5 } }), S()).points).toBeLessThanOrEqual(4));
  it('ATR 0 is not divided by (missing, not scored)', () => expect(scoreTrend(cand({ atr: 0 }), S()).missing).toBe(true));
});

describe('Location / extension (10)', () => {
  const at = (ema20: number, vwap: number, ema9 = 100.9, chase = -0.02) => scoreLocation(cand({ chaseDistanceAtr: chase, inputs: { ema20, vwap, ema9 } }), S()).points;
  it('near structure (≤ 1 ATR) = 10', () => expect(at(100.2, 100.3)).toBe(10));
  it('1.2 ATR = 9; 2.2 ATR = 5; 4 ATR = 1', () => {
    expect(at(99.8, 100.3)).toBe(9);
    expect(at(98.8, 100.3)).toBe(5);
    expect(at(97.0, 100.3, 100.5)).toBe(1);
  });
  it('more than 1 ATR from EMA9 → −1', () => expect(at(100.2, 100.3, 99.8)).toBe(9));
  it('late entry 0.2 ATR beyond trigger → −2', () => expect(at(100.2, 100.3, 100.9, 0.2)).toBe(8));
});

describe('Time of day (10) — scored only inside the entry window', () => {
  it.each([['09:45', 10], ['11:29', 10], ['11:30', 6], ['13:59', 6], ['14:00', 8], ['15:29', 8]])('%s → %s', (t, pts) => {
    expect(scoreTime(cand({ alertTime: t as string }), S()).points).toBe(pts);
  });
  it('before the first bucket there is no time score (it is a hard fail elsewhere)', () => {
    expect(scoreTime(cand({ alertTime: '09:31' }), S()).missing).toBe(true);
  });
  it('edited bucket changes the score', () => {
    const s = S();
    s.timeBuckets[1].points = 9;
    expect(scoreTime(cand({ alertTime: '12:00' }), s).points).toBe(9);
  });
});

/* ───────────────────────── portfolio fit components ───────────────────────── */

describe('Capital efficiency (10)', () => {
  it('neutral 6 with fewer than 3 candidates', () => expect(scoreCapitalEfficiency(cand(), [0.0198], 80000, S()).points).toBe(6));
  it('relative percentile among ≥ 3 candidates: worst 2, middle 6, best 10', () => {
    const peers = [0.01, 0.02, 0.03];
    expect(scoreCapitalEfficiency(cand({ expectedReward: 100 }), peers, 80000, S()).points).toBe(2);
    expect(scoreCapitalEfficiency(cand({ expectedReward: 200 }), peers, 80000, S()).points).toBe(6);
    expect(scoreCapitalEfficiency(cand({ expectedReward: 300 }), peers, 80000, S()).points).toBe(10);
  });
  it('position value 0 is not divided by (missing)', () => expect(scoreCapitalEfficiency(cand({ positionValue: 0 }), [], 80000, S()).missing).toBe(true));
});

describe('Capital availability (8)', () => {
  const s = S();
  it('≤ 50% of available → 8', () => expect(scoreCapitalAvailability(cand({ positionValue: 20000 }), emptyPf(s), s).points).toBe(8));
  it('≤ 80% → 5; > 80% → 2; does not fit → 0', () => {
    const pf = buildPortfolio([pos({ positionValue: 60000 })], [], s); // available 20,000
    expect(scoreCapitalAvailability(cand({ positionValue: 12000 }), pf, s).points).toBe(5);
    expect(scoreCapitalAvailability(cand({ positionValue: 17000 }), pf, s).points).toBe(2);
    expect(scoreCapitalAvailability(cand({ positionValue: 20001 }), pf, s).points).toBe(0);
  });
});

describe('Correlation (7)', () => {
  const s = S();
  const semis = { sector: 'Technology', industry: 'Semiconductors' };
  it('levels: same industry or theme = HIGH; same sector = SECTOR', () => {
    const a = { ticker: 'NVDA', direction: 'LONG' as const, sector: 'Technology', industry: 'Semiconductors', theme: 'AI Chips' };
    expect(correlationLevel(a, { ...a, ticker: 'AVGO', theme: 'AI Infrastructure' })).toBe('HIGH');
    expect(correlationLevel(a, { ...a, ticker: 'IBM', industry: 'IT Services', theme: '' })).toBe('SECTOR');
  });
  it('no overlap 7 · sector 4 · high blocked 0 · high allowed 1', () => {
    expect(scoreCorrelation(cand(), emptyPf(s), s).points).toBe(7);
    expect(scoreCorrelation(cand({ inputs: semis }), buildPortfolio([pos({ sector: 'Technology', industry: 'IT Services' })], [], s), s).points).toBe(4);
    const semiPf = buildPortfolio([pos({ ticker: 'NVDA', ...semis })], [], s);
    expect(scoreCorrelation(cand({ ticker: 'AVGO', inputs: semis }), semiPf, s).points).toBe(0);
    expect(scoreCorrelation(cand({ ticker: 'AVGO', inputs: semis }), semiPf, { ...s, correlation: { ...s.correlation, maxHighlyCorrelated: 2 } }).points).toBe(1);
  });
  it('RB v1.1 default: opposite-direction overlap still counts (blocked)', () => {
    const a = assessCorrelation({ ticker: 'AVGO', direction: 'SHORT', ...semis, theme: '' }, [{ ticker: 'NVDA', direction: 'LONG', ...semis, theme: '' }], s.correlation);
    expect(a.blocked).toBe(true);
  });
  it('opposite-direction overlap is exempt only when allowOppositeDirection is ON', () => {
    const a = assessCorrelation({ ticker: 'AVGO', direction: 'SHORT', ...semis, theme: '' }, [{ ticker: 'NVDA', direction: 'LONG', ...semis, theme: '' }], { ...s.correlation, allowOppositeDirection: true });
    expect(a.blocked).toBe(false);
    expect(a.oppositeWith).toEqual(['NVDA']);
  });
});

describe('Portfolio heat (5)', () => {
  const s = S();
  it('current + projected heat', () => {
    const pf = buildPortfolio([pos({ plannedRisk: 600 })], [], s);
    expect([pf.heatOpen, pf.heatLimit]).toEqual([600, 1000]);
    expect(scorePortfolioRisk(cand({ plannedRisk: 250 }), pf, s).points).toBe(3);
  });
  it('exceeding the limit → BLOCKED — PORTFOLIO HEAT', () => {
    const r = one(cand({ plannedRisk: 250 }), [pos({ plannedRisk: 900 })]);
    expect(r.recommendation).toBe('BLOCKED — PORTFOLIO HEAT');
    expect(r.hardFails[0].code).toBe('PORTFOLIO_HEAT_LIMIT');
  });
  it('pending orders count toward committed heat', () => {
    const pf = buildPortfolio([pos({ plannedRisk: 300 })], [cand({ status: 'PENDING', plannedRisk: 200 })], s);
    expect([pf.heatOpen, pf.heatCommitted]).toEqual([300, 500]);
  });
});

/* ───────────────────────── capital & allocation ───────────────────────── */

describe('available capital and reservation', () => {
  const s = S();
  it('usable = $80,000; deployed and reserved are subtracted', () => {
    const pf = buildPortfolio([pos({ positionValue: 19000 })], [cand({ status: 'FILLED', positionValue: 15000 }), cand({ status: 'PENDING', positionValue: 18000 })], s);
    expect([pf.usableAllocation, pf.deployed, pf.reserved, pf.available, pf.slotsUsed]).toEqual([80000, 34000, 18000, 28000, 3]);
  });
  it('broker buying power is informational only', () => {
    const s2 = S();
    s2.portfolio.brokerBuyingPower = 400000;
    expect(buildPortfolio([], [], s2).available).toBe(80000);
  });
  it('capital cannot be double-allocated: pending reservations block new candidates', () => {
    const s3 = S();
    s3.portfolio.maxPositions = 10;
    const pending = [1, 2, 3, 4].map(() => cand({ status: 'PENDING', positionValue: 15000 }));
    const fresh = cand({ positionValue: 19000 });
    const r = rankCandidates([...pending, fresh], [], s3, D);
    expect(r.portfolio.available).toBe(20000);
    expect(r.ranked.find((x) => x.candidate.id === fresh.id)!.recommendation?.startsWith('TRADE NOW')).toBe(true);
    const fresh2 = cand({ positionValue: 19000 });
    const r2 = rankCandidates([...pending, fresh, fresh2], [], s3, D);
    const recs = r2.ranked.filter((x) => [fresh.id, fresh2.id].includes(x.candidate.id)).map((x) => x.recommendation);
    expect(recs.filter((x) => x?.startsWith('TRADE NOW'))).toHaveLength(1);
    expect(recs).toContain('CAPITAL WAITLIST');
  });
});

const ai = (id: string, score: number, positionValue: number, extra: Partial<AllocationInput> = {}): AllocationInput => ({
  id, ticker: id, direction: 'LONG', sector: `S-${id}`, industry: `I-${id}`, theme: '', score, setupScore: score * 0.7,
  alertTime: '10:00', createdAt: 0, positionValue, plannedRisk: 50, ...extra,
});

describe('allocation — spec examples', () => {
  it('§27 $40,000: A 86 (10:00), B 94 (10:03), C 91 (10:05) → B and C; A waitlisted', () => {
    const s = S();
    s.portfolio.maxPositions = 10;
    const pf = buildPortfolio([pos({ positionValue: 40000, plannedRisk: 0 })], [], s);
    const out = allocate([ai('A', 86, 20000, { alertTime: '10:00' }), ai('B', 94, 20000, { alertTime: '10:03' }), ai('C', 91, 20000, { alertTime: '10:05' })], pf, s);
    expect(out.filter((o) => o.allocated).map((o) => o.id)).toEqual(['B', 'C']);
    expect(out.find((o) => o.id === 'A')).toMatchObject({ allocated: false, reason: 'CAPITAL' });
  });
  it('§51 A 94, B 91, C 88, capital for two → A, B; C waitlist', () => {
    const s = S();
    const pf = buildPortfolio([pos({ positionValue: 20000, plannedRisk: 0 }), pos({ positionValue: 20000, plannedRisk: 0 })], [], s);
    const out = allocate([ai('C', 88, 19000), ai('A', 94, 19000), ai('B', 91, 19000)], pf, s);
    expect(out.map((o) => [o.id, o.allocated])).toEqual([['A', true], ['B', true], ['C', false]]);
  });
  it('§47 correlation: NVDA chosen, AVGO blocked with NVDA, IBM eligible', () => {
    const s = S();
    const semis = { sector: 'Technology', industry: 'Semiconductors' };
    const out = allocate([ai('AVGO', 90, 19000, semis), ai('IBM', 87, 19000, { sector: 'Technology', industry: 'IT Services' }), ai('NVDA', 92, 19000, semis)], emptyPf(s), s);
    expect(out.find((o) => o.id === 'AVGO')).toMatchObject({ allocated: false, reason: 'CORRELATION', correlatedWith: ['NVDA'] });
    expect(out.find((o) => o.id === 'IBM')!.allocated).toBe(true);
  });
  it('deterministic: input order does not matter; ties break by setup, then alert time', () => {
    const s = S();
    const xs = [ai('C', 88, 1000, { setupScore: 60, alertTime: '10:05' }), ai('A', 88, 1000, { setupScore: 62 }), ai('B', 88, 1000, { setupScore: 60, alertTime: '10:01' })];
    expect(allocate(xs, emptyPf(s), s).map((o) => o.id)).toEqual(['A', 'B', 'C']);
    expect(allocate([...xs].reverse(), emptyPf(s), s).map((o) => o.id)).toEqual(['A', 'B', 'C']);
  });
  it('heat exhaustion produces a HEAT waitlist', () => {
    const s = S();
    const out = allocate([ai('X', 95, 5000, { plannedRisk: 600 }), ai('Y', 90, 5000, { plannedRisk: 600 })], emptyPf(s), s);
    expect(out[1]).toMatchObject({ id: 'Y', allocated: false, reason: 'HEAT' });
  });
});

/* ───────────────────────── RB v1.1 thresholds & decisions ───────────────────────── */

describe('central score classification (§40)', () => {
  it.each([[100, 'ELITE'], [90, 'ELITE'], [89.9, 'HIGH_PRIORITY'], [85, 'HIGH_PRIORITY'], [84.9, 'WATCHLIST'], [80, 'WATCHLIST'], [79.9, 'LOW_PRIORITY'], [75, 'LOW_PRIORITY'], [74.9, 'SKIP'], [0, 'SKIP']])(
    '%s → %s', (t, tier) => expect(classifyScore(t as number, S())).toBe(tier),
  );
  it('decide(): hard fail → completeness → portfolio → absolute threshold → allocation', () => {
    const alloc = { id: 'x', allocated: true, reason: 'ALLOCATED' as const, correlatedWith: [], availableBefore: 1 };
    const base = { strategyFails: [], missing: [], portfolioFails: [], tier: 'ELITE' as const, allocation: alloc };
    expect(decide({ ...base, strategyFails: [fail('AFTER_HOURS', 'x')] })).toBe('NOT ELIGIBLE — CANNOT BE RANKED');
    expect(decide({ ...base, missing: ['RVOL(20)'] })).toBe('SCORING INCOMPLETE');
    expect(decide({ ...base, portfolioFails: [fail('NO_POSITION_SLOT', 'x')] })).toBe('BLOCKED — NO POSITION SLOT');
    expect(decide({ ...base, tier: 'WATCHLIST' })).toBe('WATCHLIST / RESERVE');
    expect(decide({ ...base, tier: 'LOW_PRIORITY' })).toBe('LOW PRIORITY');
    expect(decide({ ...base, tier: 'SKIP' })).toBe('SKIP — QUALITY BELOW THRESHOLD');
    expect(decide(base)).toBe('TRADE NOW — ELITE');
    expect(decide({ ...base, tier: 'HIGH_PRIORITY' })).toBe('TRADE NOW — HIGH PRIORITY');
    expect(decide({ ...base, allocation: { ...alloc, allocated: false, reason: 'CAPITAL' } })).toBe('CAPITAL WAITLIST');
  });
  it('recommendations by threshold (single candidate, ample capital; fit = 26)', () => {
    const rec = (rvol: number, rsi: number, alertTime: string) => one(cand({ alertTime, inputs: { rvol, rsi } }));
    expect(rec(4, 67, '10:00')).toMatchObject({ total: 96, recommendation: 'TRADE NOW — ELITE', eligibilityLabel: 'ELITE — PREFERRED CAPITAL ALLOCATION' });
    expect(rec(2.0, 62, '11:45')).toMatchObject({ total: 85, recommendation: 'TRADE NOW — HIGH PRIORITY' });
    expect(rec(2.0, 57, '11:45')).toMatchObject({ total: 82, recommendation: 'WATCHLIST / RESERVE' });
    expect(rec(1.5, 57, '11:45')).toMatchObject({ total: 79, recommendation: 'LOW PRIORITY' });
  });
  it('§50 absolute threshold wins over rank: only candidate, score 73, rank #1 of 1 → do not trade', () => {
    const r = one(cand({ alertTime: '11:45', inputs: { rvol: 1.5, rsi: 54 } }));
    expect([r.total, r.rank, r.rankOf]).toEqual([73, 1, 1]);
    expect(r.recommendation).toBe('SKIP — QUALITY BELOW THRESHOLD');
    expect(r.eligibilityLabel).toMatch(/BELOW TRADE THRESHOLD/);
  });
  it('12 candidates ≥ 85 but only 3 slots → only the best 3 are TRADE NOW', () => {
    const s = S();
    s.portfolio.maxPositions = 3;
    const cs = Array.from({ length: 12 }, (_, i) => cand({ positionValue: 5000, plannedRisk: 50, inputs: { rvol: 2 + i * 0.15 } }));
    const r = rankCandidates(cs, [], s, D);
    const trades = r.ranked.filter((x) => x.recommendation?.startsWith('TRADE NOW'));
    expect(trades).toHaveLength(3);
    expect(trades.map((x) => x.rank)).toEqual([1, 2, 3]);
    expect(r.ranked.filter((x) => x.recommendation === 'CAPITAL WAITLIST')).toHaveLength(9);
  });
});

describe('hard rules override scores (strategy fails are not scored or ranked)', () => {
  it('§52 raw score 96+ but alert 16:04 → NOT ELIGIBLE, never ELITE', () => {
    expect(rawTotal(cand())).toBeGreaterThanOrEqual(96); // the same inputs at 10:00 would be elite
    const r = one(cand({ alertTime: '16:04' }));
    expect(r.recommendation).toBe('NOT ELIGIBLE — CANNOT BE RANKED');
    expect(r.hardFails[0].label).toBe('NOT ELIGIBLE — AFTER REGULAR SESSION');
    expect([r.total, r.tier, r.rank]).toEqual([null, null, null]);
    expect(r.eligibilityLabel).toBe('NOT ELIGIBLE');
  });
  it.each([
    ['15:31 → window closed', { alertTime: '15:31' }, 'NOT ELIGIBLE — NEW ENTRY WINDOW CLOSED'],
    ['09:40 → too early', { alertTime: '09:40' }, 'NOT ELIGIBLE — TOO EARLY'],
    ['red LONG candle', { open: 101, close: 100 }, 'NOT ELIGIBLE — LONG SIGNAL CANDLE INVALID'],
    ['chased (from calculator)', { calcAction: 'SKIP_CHASED', calcReady: false }, 'NOT ELIGIBLE — DO NOT CHASE'],
    ['stale (from calculator)', { calcAction: 'SKIP_STALE', calcReady: false }, 'NOT ELIGIBLE — STALE SETUP'],
    ['chase re-check from distance', { chaseDistanceAtr: 0.3 }, 'NOT ELIGIBLE — DO NOT CHASE'],
    ['broken structure', { stop: 102 }, 'INVALID TRADE STRUCTURE'],
    ['risk above per-trade max', { plannedRisk: 300 }, 'NOT ELIGIBLE — RISK ABOVE PER-TRADE MAXIMUM'],
  ])('%s', (_, o, label) => {
    const r = one(cand(o as Partial<Candidate>));
    expect(r.recommendation).toBe('NOT ELIGIBLE — CANNOT BE RANKED');
    expect(r.hardFails.map((f) => f.label)).toContain(label);
    expect(r.total).toBeNull();
  });
  it('§54 invalid 15m trend: LONG 15m Close 100 < EMA20 101 → NOT ELIGIBLE; SHORT mirror too', () => {
    expect(one(cand({ inputs: { close15m: 100, ema20_15m: 101 } })).hardFails[0].code).toBe('HTF_CONFIRMATION_FAILED');
    expect(one(short({ inputs: { close15m: 101.5, ema20_15m: 101 } })).hardFails[0].code).toBe('HTF_CONFIRMATION_FAILED');
  });
  it('existing same-ticker position → NOT ELIGIBLE', () => {
    expect(one(cand({ ticker: 'IBM' }), [pos({ ticker: 'IBM' })]).hardFails[0].code).toBe('EXISTING_SAME_TICKER_POSITION');
  });
  it('max positions reached → BLOCKED — NO POSITION SLOT', () => {
    expect(one(cand(), [1, 2, 3, 4].map(() => pos({ positionValue: 1000 }))).recommendation).toBe('BLOCKED — NO POSITION SLOT');
  });
  it('position above max single position → BLOCKED — CAPITAL', () => expect(one(cand({ positionValue: 25000 })).recommendation).toBe('BLOCKED — CAPITAL'));
  it('hard correlation cap → BLOCKED — CORRELATED EXPOSURE', () => {
    const semis = { sector: 'Technology', industry: 'Semiconductors' };
    expect(one(cand({ inputs: semis }), [pos({ ticker: 'NVDA', ...semis })]).recommendation).toBe('BLOCKED — CORRELATED EXPOSURE');
  });
});

describe('§53 missing inputs → SCORING INCOMPLETE (never a fabricated score)', () => {
  it.each([['close15m', 'Last completed 15m Close'], ['ema20_15m', 'Last completed 15m EMA20'], ['rvol', 'RVOL(20)'], ['rsi', 'RSI(14)']])('missing %s', (k, name) => {
    const r = one(cand({ inputs: { [k]: null } as Partial<RankingInputs> }));
    expect(r.recommendation).toBe('SCORING INCOMPLETE');
    expect(r.missing).toContain(name);
    expect([r.total, r.setup, r.fit, r.rank]).toEqual([null, null, null, null]);
  });
  it('missing sector is listed', () => expect(one(cand({ inputs: { sector: '' } })).missing).toContain('Sector'));
  it('a hard fail takes precedence over missing data', () => {
    expect(one(cand({ alertTime: '16:04', inputs: { rvol: null } })).recommendation).toBe('NOT ELIGIBLE — CANNOT BE RANKED');
  });
});

describe('rank & live parameter changes', () => {
  it('changing a scoring parameter immediately changes the ranking', () => {
    const s = S();
    const a = cand({ ticker: 'A', inputs: { rvol: 3.6, rsi: 57 } });
    const b = cand({ ticker: 'B', inputs: { rvol: 1.6, rsi: 67 } });
    const first = (st: RankerSettings) => rankCandidates([a, b], [], st, D).ranked[0].candidate.ticker;
    expect(first(s)).toBe('A');
    s.weights.rvol = 5;
    s.weights.momentum = 20;
    expect(first(s)).toBe('B');
  });
  it('raising the trade threshold immediately removes TRADE NOW', () => {
    const s = S();
    const c = cand({ alertTime: '11:45', inputs: { rvol: 2.0, rsi: 62 } }); // 85
    expect(one(c, [], s).recommendation).toBe('TRADE NOW — HIGH PRIORITY');
    s.grades.high = 86;
    expect(one(c, [], s).recommendation).toBe('WATCHLIST / RESERVE');
  });
  it('rankCandidates does not mutate its inputs (scores are never written back)', () => {
    const s = S();
    const { candidates, positions } = sampleDay(D, '2026-10-28', s);
    const before = JSON.stringify(candidates);
    rankCandidates(candidates, positions, s, D);
    expect(JSON.stringify(candidates)).toBe(before);
  });
});

/* ───────────────────────── replacement advantage ───────────────────────── */

describe('replacement suggestions (pending orders only)', () => {
  const s = S();
  const full = () => [pos({ positionValue: 20000 }), pos({ positionValue: 20000 }), pos({ positionValue: 20000 })];

  it('§30 materially stronger new candidate → STRONGER (manual confirmation only)', () => {
    const ibm = cand({ ticker: 'IBM', status: 'PENDING', positionValue: 19900, inputs: { rvol: 1.6 } }); // 81
    const nvda = cand({ ticker: 'NVDA', positionValue: 19500, inputs: { rvol: 3.6 } }); // 90 once IBM's capital is released
    const r = rankCandidates([ibm, nvda], full(), s, D);
    expect(r.ranked.find((x) => x.candidate.id === nvda.id)!.recommendation).toBe('BLOCKED — NO POSITION SLOT');
    expect(r.suggestions[0]).toMatchObject({ kind: 'STRONGER', pendingTicker: 'IBM', candidateTicker: 'NVDA', difference: 9 });
    expect(r.ranked.find((x) => x.candidate.id === ibm.id)!.candidate.status).toBe('PENDING');
  });
  it('small difference → Similar quality — keep existing candidate', () => {
    const ibm = cand({ ticker: 'IBM', status: 'PENDING', positionValue: 19900, inputs: { rvol: 2.6 } }); // 87
    const nvda = cand({ ticker: 'NVDA', positionValue: 19500, inputs: { rvol: 3.6 } }); // 90
    expect(rankCandidates([ibm, nvda], full(), s, D).suggestions[0]).toMatchObject({ kind: 'SIMILAR', difference: 3 });
  });
  it('a below-threshold candidate (< 85) is never proposed as a replacement', () => {
    const ibm = cand({ ticker: 'IBM', status: 'PENDING', positionValue: 19900, inputs: { rvol: 1.6 } });
    const nvda = cand({ ticker: 'NVDA', positionValue: 19500, inputs: { rvol: 2.0 } }); // 84
    expect(rankCandidates([ibm, nvda], full(), s, D).suggestions).toHaveLength(0);
  });
  it('replacement advantage is configurable', () => {
    const s2 = S();
    s2.replacementAdvantage = 2;
    const ibm = cand({ ticker: 'IBM', status: 'PENDING', positionValue: 19900, inputs: { rvol: 2.6 } });
    const nvda = cand({ ticker: 'NVDA', positionValue: 19500, inputs: { rvol: 3.6 } });
    expect(rankCandidates([ibm, nvda], full(), s2, D).suggestions[0].kind).toBe('STRONGER');
  });
  it('KEEP hides the suggestion', () => {
    const nvda = cand({ ticker: 'NVDA', positionValue: 19500, inputs: { rvol: 3.6 } });
    const ibm = cand({ ticker: 'IBM', status: 'PENDING', positionValue: 19900, inputs: { rvol: 1.6 }, keptAgainst: [nvda.id] });
    expect(rankCandidates([ibm, nvda], full(), s, D).suggestions).toHaveLength(0);
  });
  it('§29 a FILLED position is never suggested for replacement', () => {
    const ibm = cand({ ticker: 'IBM', status: 'FILLED', positionValue: 19900, inputs: { rvol: 1.6 } });
    const nvda = cand({ ticker: 'NVDA', positionValue: 19500, inputs: { rvol: 3.6 } });
    const r = rankCandidates([ibm, nvda], full(), s, D);
    expect(r.suggestions).toHaveLength(0);
    expect(r.ranked.find((x) => x.candidate.id === ibm.id)!.displayStatus).toBe('FILLED');
  });
});

/* ───────────────────────── audit trail & analytics ───────────────────────── */

describe('audit trail (§43–44)', () => {
  it('snapshot records versions, settings, hard-rule results, score and decision', () => {
    const s = S();
    const r = one(cand());
    const snap = snapshotOf(r, 123, s);
    expect(snap).toMatchObject({ at: 123, rulesVersion: 'RB v1.1', scoringVersion: 'RB v1.1', total: r.total, tier: r.tier, decision: r.displayStatus });
    expect(snap.hardRules.length).toBe(r.hardRules.length);
    expect(snap.entryWindow).toEqual({ start: '09:45', end: '15:30' });
    s.weights.rvol = 1; // later changes do not alter the frozen copy
    expect((snap.settings as RankerSettings).weights.rvol).toBe(15);
  });
});

describe('performance analytics (uses the frozen initial score)', () => {
  const s = S();
  const snap = (total: number, rvolPts: number): ScoreSnapshot => ({
    at: 0, rulesVersion: 'RB v1.1', scoringVersion: 'RB v1.1', total, setup: null, fit: null, tier: classifyScore(total, s), decision: '',
    components: { trend: 15, rvol: rvolPts, momentum: 10, candle: 10, location: 10, time: 10, capitalEfficiency: 6, capitalAvailability: 8, correlation: 7, portfolioRisk: 5 },
    maxes: { ...DEFAULT_MAX }, hardRules: [], missing: [], settings: {}, entryWindow: { start: '09:45', end: '15:30' },
  });
  const closed = (total: number, exitPrice: number, rvolPts = 15) =>
    cand({ status: exitPrice > 101.02 ? 'TARGET_HIT' : 'STOPPED_OUT', exitPrice, initialScore: snap(total, rvolPts), archived: true });
  const trades = [closed(95, 103.02), closed(92, 100.02), closed(86, 103.02, 6), closed(81, 100.02, 6), closed(70, 100.02, 6)];

  it('R multiple from planned risk', () => {
    expect(candidateR(trades[0])).toBeCloseTo(2, 6);
    expect(candidateR(trades[1])).toBeCloseTo(-1, 6);
  });
  it('score buckets follow the central thresholds', () => {
    const b = performanceByScoreBucket(trades, s);
    expect(b.map((x) => x.label)).toEqual(['90–100', '85–89', '80–84', '75–79', '< 75']);
    expect(b[0]).toMatchObject({ trades: 2, winRate: 0.5, totalR: 1, profitFactor: 2 });
    expect(b[0].sufficient).toBe(false);
  });
  it('component buckets', () => {
    const rv = performanceByComponent(trades, s).find((x) => x.key === 'rvol')!;
    expect([rv.high.trades, rv.low.trades]).toEqual([2, 3]);
  });
});
