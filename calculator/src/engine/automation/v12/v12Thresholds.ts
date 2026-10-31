/**
 * RB v1.2 — score-threshold calibration (Phase 3C.1, RB_V1_2_ARCHITECTURE.md §26). COMPARISON ONLY: nothing here is
 * wired into a v1.1 or v1.2 decision; the shadow ranking still uses the unchanged RB v1.1 grades (Option A).
 *
 * With RVOL scored at the QUALIFIED_FLOOR, a qualified candidate can earn at most
 *     max = Σ weights − w.rvol + floor × w.rvol ÷ 15      (defaults: 100 − 15 + 6 = 91)
 * so every v1.1 grade threshold asks for a larger share of the available score than it did in v1.1.
 *
 *   A_CURRENT  RB v1.1 grades unchanged (elite / high / watchlist / low = 90 / 85 / 80 / 75)
 *   B_ROUND    every grade × max ÷ 100, rounded to the nearest point          (defaults: 82 / 77 / 73 / 68)
 *   B_CEIL     every grade × max ÷ 100, rounded UP — never a smaller share of the available score than v1.1
 *              (defaults: 82 / 78 / 73 / 69; identical to the exact proportional values on integer scores)
 * All four grades are rebased together: rebasing only High / Elite would leave Watchlist (80) above High (77/78),
 * which breaks the strictly decreasing order validateRankerSettings requires and makes WATCHLIST unreachable.
 * Component weights, bands and the displayed (raw, 0–max) scores are untouched.
 */
import { classifyScore } from '../../ranker/candidateRanker';
import type { QualityTier } from '../../ranker/opportunityTypes';
import { rvolBand } from '../../ranker/opportunityScorer';
import { DEFAULT_MAX, totalWeight, type RankerSettings } from '../../ranker/rankerSettings';
import { RVOL_PROVEN_MIN } from './v12Ranking';

export type Grades = RankerSettings['grades'];
export type ThresholdOption = 'A_CURRENT' | 'B_ROUND' | 'B_CEIL';
export const THRESHOLD_OPTIONS: readonly ThresholdOption[] = ['A_CURRENT', 'B_ROUND', 'B_CEIL'];

const round1 = (x: number) => Math.round(x * 10) / 10;

/** RVOL points a qualified candidate receives (QUALIFIED_FLOOR), at the configured RVOL weight. */
export function floorPoints(s: RankerSettings): number {
  return round1(((rvolBand(RVOL_PROVEN_MIN, s)?.points ?? 0) * s.weights.rvol) / DEFAULT_MAX.rvol);
}

/** Highest score a TrendSpider-qualified v1.2 candidate can reach. */
export function v12MaxScore(s: RankerSettings): number {
  return round1(totalWeight(s.weights) - s.weights.rvol + floorPoints(s));
}

/** Each grade scaled by max ÷ 100 (unrounded). */
export function exactProportionalGrades(g: Grades, max: number): Grades {
  const f = (x: number) => Math.round(((x * max) / 100) * 1e6) / 1e6;
  return { elite: f(g.elite), high: f(g.high), watchlist: f(g.watchlist), low: f(g.low) };
}

export function thresholdsFor(option: ThresholdOption, s: RankerSettings): Grades {
  if (option === 'A_CURRENT') return { ...s.grades };
  const e = exactProportionalGrades(s.grades, v12MaxScore(s));
  const r = option === 'B_ROUND' ? Math.round : (x: number) => Math.ceil(x - 1e-9);
  return { elite: r(e.elite), high: r(e.high), watchlist: r(e.watchlist), low: r(e.low) };
}

/** Ranker settings with only the grades replaced (for a v1.2 shadow ranking pass under a threshold option). */
export function withGrades(s: RankerSettings, grades: Grades): RankerSettings {
  return { ...s, grades: { ...grades } };
}

/** Tier of a raw v1.2 score under a threshold option (the ranker's own classifyScore). */
export function tierUnder(total: number, option: ThresholdOption, s: RankerSettings): QualityTier {
  return classifyScore(total, withGrades(s, thresholdsFor(option, s)));
}
