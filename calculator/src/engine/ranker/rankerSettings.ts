/**
 * Opportunity Ranker settings.
 *
 * ⚠ RB v1 PAPER-TESTING ASSUMPTIONS: every weight, band and threshold below is a
 * hypothesis to be tested, not a proven predictive relationship. Nothing here is
 * ever changed automatically.
 *
 * Band "points" are expressed in each category's DEFAULT maximum (e.g. RVOL bands
 * out of 15). If a weight is edited, band points are scaled proportionally:
 *     points = bandPoints × (weight ÷ defaultMax)
 */
import { FIT_KEYS, SETUP_KEYS, type ComponentKey } from './opportunityTypes';
import { toMinutes as tm } from '../rules';

export type Weights = Record<ComponentKey, number>;

export const DEFAULT_MAX: Weights = {
  trend: 15,
  rvol: 15,
  momentum: 10,
  candle: 10,
  location: 10,
  time: 10,
  capitalEfficiency: 10,
  capitalAvailability: 8,
  correlation: 7,
  portfolioRisk: 5,
};

export interface RvolBand { min: number; points: number; label: string }
export interface RsiBand { from: number; to: number; points: number }
export interface TimeBucket { start: string; label: string; points: number }

export interface RankerSettings {
  weights: Weights;
  /** Ascending by min. RVOL below the first band → 0 points. */
  rvolBands: RvolBand[];
  /** LONG RSI bands [from, to). SHORT uses the mirror: score(100 − RSI). Outside all bands → 0. */
  rsiBandsLong: RsiBand[];
  /**
   * Ascending start times (HH:MM ET) INSIDE the entry window. The bucket in force is the last one whose
   * start ≤ alert time. Alerts outside the entry window are hard fails and are never time-scored.
   */
  timeBuckets: TimeBucket[];
  /**
   * Central score thresholds (RB v1.1): ≥ elite → ELITE; ≥ high → HIGH PRIORITY (= the minimum score for trade
   * consideration); ≥ watchlist → WATCHLIST / RESERVE; ≥ low → LOW PRIORITY; below → SKIP.
   */
  grades: { elite: number; high: number; watchlist: number; low: number };
  replacementAdvantage: number;
  portfolio: {
    accountEquity: number;
    maxPositionValue: number;
    maxPositions: number;
    riskPerTradePct: number; // fraction
    heatPct: number; // fraction of equity
    liquidityReservePct: number; // fraction of equity kept undeployed
    brokerBuyingPower: number | null; // informational only — NEVER used as budget
  };
  correlation: {
    maxHighlyCorrelated: number;
    hardBlock: boolean;
    /** OFF (RB v1.1): LONG and SHORT positions both count toward the correlated-theme cap. */
    allowOppositeDirection: boolean;
  };
  /** Capital efficiency is scored relative to peers only when at least this many candidates exist. */
  minCandidatesForRelative: number;
  /** Minimum closed trades in a bucket before the analytics page treats it as more than anecdotal. */
  minSampleForAnalysis: number;
}

export const RANKER_DEFAULTS: Readonly<RankerSettings> = Object.freeze({
  weights: { ...DEFAULT_MAX },
  rvolBands: [
    { min: 1.5, points: 6, label: 'NORMAL' },
    { min: 2.0, points: 9, label: 'ELEVATED' },
    { min: 2.5, points: 12, label: 'STRONG' },
    { min: 3.5, points: 15, label: 'EXCEPTIONAL' },
  ],
  rsiBandsLong: [
    { from: 55, to: 60, points: 6 },
    { from: 60, to: 65, points: 9 },
    { from: 65, to: 70, points: 10 },
    { from: 70, to: 75, points: 7 },
    { from: 75, to: 101, points: 4 },
  ],
  timeBuckets: [
    { start: '09:45', label: 'Primary window 9:45–11:30', points: 10 },
    { start: '11:30', label: 'Midday 11:30–2:00', points: 6 },
    { start: '14:00', label: 'Afternoon 2:00–3:30', points: 8 },
  ],
  grades: { elite: 90, high: 85, watchlist: 80, low: 75 },
  replacementAdvantage: 5,
  portfolio: {
    accountEquity: 100000,
    maxPositionValue: 20000,
    maxPositions: 4,
    riskPerTradePct: 0.0025,
    heatPct: 0.01,
    liquidityReservePct: 0.2,
    brokerBuyingPower: null,
  },
  correlation: { maxHighlyCorrelated: 1, hardBlock: true, allowOppositeDirection: false },
  minCandidatesForRelative: 3,
  minSampleForAnalysis: 30,
}) as RankerSettings;

export function cloneRankerDefaults(): RankerSettings {
  return JSON.parse(JSON.stringify(RANKER_DEFAULTS)) as RankerSettings;
}

/**
 * Restore stored settings over the defaults. Migration (RB v1.1 freeze): the old "sameDirectionOnly" switch is
 * dropped and replaced by allowOppositeDirection, which starts OFF (opposite-direction overlaps count).
 */
export function migrateRankerSettings(stored: Partial<RankerSettings> | null | undefined): RankerSettings {
  const defaults = cloneRankerDefaults();
  if (!stored) return defaults;
  const old = (stored.correlation ?? {}) as Partial<RankerSettings['correlation']> & { sameDirectionOnly?: boolean };
  const { sameDirectionOnly: _dropped, ...corr } = old;
  void _dropped;
  const correlation = {
    ...defaults.correlation,
    ...corr,
    allowOppositeDirection: typeof corr.allowOppositeDirection === 'boolean' ? corr.allowOppositeDirection : false,
  };
  return { ...defaults, ...stored, correlation } as RankerSettings;
}

export const totalWeight = (w: Weights) => Object.values(w).reduce((a, b) => a + b, 0);

const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateRankerSettings(s: RankerSettings): string[] {
  const e: string[] = [];
  const sum = totalWeight(s.weights);
  if (Math.abs(sum - 100) > 1e-9) e.push(`Score weights must add up to exactly 100 (currently ${+sum.toFixed(4)}).`);
  const setupSum = SETUP_KEYS.reduce((a, k) => a + s.weights[k], 0);
  const fitSum = FIT_KEYS.reduce((a, k) => a + s.weights[k], 0);
  if (Math.abs(setupSum - 70) > 1e-9) e.push(`Setup Quality weights must total 70 (currently ${+setupSum.toFixed(4)}).`);
  if (Math.abs(fitSum - 30) > 1e-9) e.push(`Portfolio Fit weights must total 30 (currently ${+fitSum.toFixed(4)}).`);
  for (const [k, v] of Object.entries(s.weights)) if (!(v >= 0)) e.push(`Weight "${k}" cannot be negative.`);
  const asc = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]);
  if (!asc(s.rvolBands.map((b) => b.min))) e.push('RVOL bands must have strictly increasing minimums.');
  if (s.rvolBands.some((b) => b.points < 0 || b.points > DEFAULT_MAX.rvol)) e.push(`RVOL band points must be 0–${DEFAULT_MAX.rvol}.`);
  if (s.rsiBandsLong.some((b) => b.to <= b.from)) e.push('Each RSI band needs "to" greater than "from".');
  if (s.rsiBandsLong.some((b) => b.points < 0 || b.points > DEFAULT_MAX.momentum)) e.push(`RSI band points must be 0–${DEFAULT_MAX.momentum}.`);
  if (!s.timeBuckets.every((b) => hhmm.test(b.start))) e.push('Time bucket starts must be HH:MM (24h).');
  if (!asc(s.timeBuckets.map((b) => toMinutes(b.start)))) e.push('Time buckets must be in increasing time order.');
  if (s.timeBuckets.some((b) => b.points < 0 || b.points > DEFAULT_MAX.time)) e.push(`Time points must be 0–${DEFAULT_MAX.time}.`);
  const g = s.grades;
  if (!(g.elite <= 100 && g.elite > g.high && g.high > g.watchlist && g.watchlist > g.low && g.low >= 0)) {
    e.push('Score thresholds must be strictly decreasing: Elite > High priority > Watchlist > Low priority (0–100).');
  }
  if (s.timeBuckets.length === 0) e.push('At least one time bucket is required.');
  if (!(s.replacementAdvantage >= 0)) e.push('Replacement advantage cannot be negative.');
  const p = s.portfolio;
  if (!(p.accountEquity > 0)) e.push('Account equity must be greater than 0.');
  if (!(p.maxPositionValue > 0)) e.push('Max single position must be greater than 0.');
  if (!(Number.isInteger(p.maxPositions) && p.maxPositions >= 1)) e.push('Max positions must be a whole number ≥ 1.');
  if (!(p.riskPerTradePct > 0 && p.riskPerTradePct <= 0.05)) e.push('Risk per trade must be > 0% and ≤ 5%.');
  if (!(p.heatPct > 0 && p.heatPct <= 0.2)) e.push('Portfolio heat limit must be > 0% and ≤ 20%.');
  if (!(p.liquidityReservePct >= 0 && p.liquidityReservePct < 1)) e.push('Liquidity reserve must be 0% to < 100%.');
  if (!(Number.isInteger(s.correlation.maxHighlyCorrelated) && s.correlation.maxHighlyCorrelated >= 1)) e.push('Max highly correlated positions must be a whole number ≥ 1.');
  if (!(s.minCandidatesForRelative >= 2)) e.push('Relative capital-efficiency scoring needs at least 2 candidates.');
  return e;
}

export const toMinutes = tm;

/** Time buckets must start inside the entry window (they only score eligible times). */
export function validateTimeBucketsInWindow(s: RankerSettings, w: { entryWindowStart: string; entryWindowEnd: string }): string[] {
  const a = tm(w.entryWindowStart);
  const b = tm(w.entryWindowEnd);
  const out: string[] = [];
  if (s.timeBuckets.length && tm(s.timeBuckets[0].start) > a) out.push(`The first time bucket must start at or before the entry window start (${w.entryWindowStart}).`);
  if (s.timeBuckets.some((x) => tm(x.start) >= b)) out.push(`Time buckets must start before the entry window end (${w.entryWindowEnd}).`);
  return out;
}
