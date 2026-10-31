import { describe, expect, it } from 'vitest';
import { classifyScore, rankCandidates, DEFAULT_STRATEGY_RULES } from '../../../ranker/candidateRanker';
import { cloneRankerDefaults, RANKER_DEFAULTS, validateRankerSettings } from '../../../ranker/rankerSettings';
import { scenarios, TODAY } from '../../../ranker/__tests__/v11RegressionSet';
import { RVOL_PROVEN_MIN } from '../v12Ranking';
import { exactProportionalGrades, floorPoints, thresholdsFor, tierUnder, v12MaxScore, withGrades } from '../v12Thresholds';

/** Phase 3C.1 — threshold calibration, comparison only (RB_V1_2_ARCHITECTURE.md §26). */
const S = cloneRankerDefaults();

describe('v1.2 maximum and proportional thresholds', () => {
  it('floor = 6/15 and the qualified maximum is 91 at default weights', () => {
    expect(floorPoints(S)).toBe(6);
    expect(v12MaxScore(S)).toBe(91);
  });
  it('exact proportional grades: 85 → 77.35, 90 → 81.9, 80 → 72.8, 75 → 68.25', () => {
    expect(exactProportionalGrades(S.grades, 91)).toEqual({ elite: 81.9, high: 77.35, watchlist: 72.8, low: 68.25 });
  });
  it('Option A = RB v1.1 grades; B_ROUND = 82/77/73/68; B_CEIL = 82/78/73/69', () => {
    expect(thresholdsFor('A_CURRENT', S)).toEqual({ elite: 90, high: 85, watchlist: 80, low: 75 });
    expect(thresholdsFor('B_ROUND', S)).toEqual({ elite: 82, high: 77, watchlist: 73, low: 68 });
    expect(thresholdsFor('B_CEIL', S)).toEqual({ elite: 82, high: 78, watchlist: 73, low: 69 });
  });
  it('B_CEIL classifies every integer score exactly like the unrounded proportional grades', () => {
    const exact = withGrades(S, exactProportionalGrades(S.grades, 91));
    for (let t = 0; t <= 91; t++) expect(tierUnder(t, 'B_CEIL', S), String(t)).toBe(classifyScore(t, exact));
  });
  it('each B threshold keeps ≈ the v1.1 share of the available score', () => {
    for (const k of ['elite', 'high', 'watchlist', 'low'] as const) {
      const share = S.grades[k] / 100;
      expect(Math.abs(thresholdsFor('B_ROUND', S)[k] / 91 - share)).toBeLessThan(0.006);
      expect(thresholdsFor('B_CEIL', S)[k] / 91).toBeGreaterThanOrEqual(share);
    }
  });
  it('both B variants pass the settings validator; rebasing only High/Elite does not (Watchlist 80 > High 77)', () => {
    for (const o of ['A_CURRENT', 'B_ROUND', 'B_CEIL'] as const) expect(validateRankerSettings(withGrades(S, thresholdsFor(o, S)))).toEqual([]);
    const upperOnly = withGrades(S, { ...S.grades, elite: 82, high: 77 });
    expect(validateRankerSettings(upperOnly).join(' ')).toMatch(/strictly decreasing/);
    expect([75, 77, 78, 79, 80, 81, 82].map((t) => classifyScore(t, upperOnly))).not.toContain('WATCHLIST');
  });
  it('follows edited weights (max = Σw − w.rvol + floor × w.rvol/15)', () => {
    const s = cloneRankerDefaults();
    s.weights = { ...s.weights, rvol: 20, trend: 10 };
    expect(floorPoints(s)).toBe(8);
    expect(v12MaxScore(s)).toBe(88);
    expect(thresholdsFor('A_CURRENT', s)).toEqual(s.grades);
  });
  it('does not touch RANKER_DEFAULTS or the input settings', () => {
    const before = JSON.stringify(S);
    thresholdsFor('B_CEIL', S);
    withGrades(S, thresholdsFor('B_ROUND', S));
    expect(JSON.stringify(S)).toBe(before);
    expect(RANKER_DEFAULTS.grades).toEqual({ elite: 90, high: 85, watchlist: 80, low: 75 });
  });
});

describe('synthetic boundary table (raw v1.2 score → tier)', () => {
  const T = { E: 'ELITE', H: 'HIGH_PRIORITY', W: 'WATCHLIST', L: 'LOW_PRIORITY', S: 'SKIP' } as const;
  // score: [Option A, B_ROUND, B_CEIL]
  const table: [number, keyof typeof T, keyof typeof T, keyof typeof T][] = [
    [67, 'S', 'S', 'S'], [68, 'S', 'L', 'S'], [69, 'S', 'L', 'L'], [72, 'S', 'L', 'L'], [73, 'S', 'W', 'W'],
    [75, 'L', 'W', 'W'], [76, 'L', 'W', 'W'], [77, 'L', 'H', 'W'], [78, 'L', 'H', 'H'], [80, 'W', 'H', 'H'],
    [81, 'W', 'H', 'H'], [82, 'W', 'E', 'E'], [83, 'W', 'E', 'E'], [84, 'W', 'E', 'E'], [85, 'H', 'E', 'E'],
    [89, 'H', 'E', 'E'], [90, 'E', 'E', 'E'], [91, 'E', 'E', 'E'],
  ];
  it.each(table)('score %i → A %s · B_ROUND %s · B_CEIL %s', (score, a, br, bc) => {
    expect(tierUnder(score, 'A_CURRENT', S)).toBe(T[a]);
    expect(tierUnder(score, 'B_ROUND', S)).toBe(T[br]);
    expect(tierUnder(score, 'B_CEIL', S)).toBe(T[bc]);
  });
  it('a real qualified candidate: the ranker tier under rebased grades equals tierUnder(total)', () => {
    const sc = scenarios().filter((x) => x.name.startsWith('LONG rvol') || x.name === 'SHORT ok');
    for (const o of ['A_CURRENT', 'B_ROUND', 'B_CEIL'] as const) {
      for (const x of sc) {
        const q = x.candidates.map((c) => ({ ...c, qualification: { source: 'TRENDSPIDER' as const, ruleSet: 'RBTS-L-901', rvolProvenMin: RVOL_PROVEN_MIN, waivedRules: [] } }));
        const r = rankCandidates(q, x.positions, withGrades(S, thresholdsFor(o, S)), TODAY, DEFAULT_STRATEGY_RULES).ranked[0];
        if (r.total === null) continue;
        expect(r.total).toBeLessThanOrEqual(91);
        expect(r.tier).toBe(tierUnder(r.total, o, S));
      }
    }
  });
});
