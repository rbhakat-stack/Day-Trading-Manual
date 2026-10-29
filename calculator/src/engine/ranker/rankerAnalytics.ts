/**
 * Does the ranking work? Analytics use the FROZEN initial score (never rewritten after the outcome),
 * so they test whether scores assigned at alert time had predictive usefulness.
 */
import { clean } from '../rounding';
import { COMPONENT_LABELS, OUTCOME_STATUSES, type Candidate, type ComponentKey } from './opportunityTypes';
import { toMinutes, type RankerSettings } from './rankerSettings';

export function candidatePnl(c: Candidate): number | null {
  if (!OUTCOME_STATUSES.includes(c.status) || c.exitPrice === null || !Number.isFinite(c.exitPrice) || c.shares < 1) return null;
  const entry = c.actualFill ?? c.entry;
  return clean((c.direction === 'LONG' ? c.exitPrice - entry : entry - c.exitPrice) * c.shares);
}

export function candidateR(c: Candidate): number | null {
  const pnl = candidatePnl(c);
  return pnl === null || !(c.plannedRisk > 0) ? null : clean(pnl / c.plannedRisk);
}

/** Strategy version a candidate was scored under (frozen in its first snapshot; never recomputed). */
export function candidateVersion(c: Candidate): string | null {
  const snap = c.initialScore ?? c.entryScore ?? c.finalScore;
  return snap ? snap.strategyVersion ?? snap.scoringVersion ?? null : null;
}

export interface BucketStats {
  label: string;
  trades: number;
  winRate: number;
  averageR: number;
  totalR: number;
  profitFactor: number | null;
  sufficient: boolean;
}

function stats(label: string, cs: Candidate[], minSample: number): BucketStats {
  const rs = cs.map((c) => candidateR(c) as number);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r < 0);
  const grossW = wins.reduce((a, b) => a + b, 0);
  const grossL = Math.abs(losses.reduce((a, b) => a + b, 0));
  return {
    label,
    trades: cs.length,
    winRate: cs.length ? wins.length / cs.length : 0,
    averageR: cs.length ? clean(rs.reduce((a, b) => a + b, 0) / cs.length) : 0,
    totalR: clean(rs.reduce((a, b) => a + b, 0)),
    profitFactor: grossL > 0 ? clean(grossW / grossL) : null,
    sufficient: cs.length >= minSample,
  };
}

/** Closed trades that have a frozen initial score and a computable R. */
export function closedScoredTrades(candidates: Candidate[]): Candidate[] {
  return candidates.filter((c) => c.initialScore && typeof c.initialScore.total === 'number' && candidateR(c) !== null);
}

export function performanceByScoreBucket(candidates: Candidate[], s: RankerSettings): BucketStats[] {
  const t = closedScoredTrades(candidates);
  const g = s.grades;
  const buckets: [string, (x: number) => boolean][] = [
    [`${g.elite}–100`, (x) => x >= g.elite],
    [`${g.high}–${g.elite - 1}`, (x) => x >= g.high && x < g.elite],
    [`${g.watchlist}–${g.high - 1}`, (x) => x >= g.watchlist && x < g.high],
    [`${g.low}–${g.watchlist - 1}`, (x) => x >= g.low && x < g.watchlist],
    [`< ${g.low}`, (x) => x < g.low],
  ];
  return buckets.map(([label, f]) => stats(label, t.filter((c) => f(c.initialScore!.total as number)), s.minSampleForAnalysis));
}

export interface ComponentAnalysis {
  key: ComponentKey;
  label: string;
  high: BucketStats; // ≥ 80% of the component maximum at the time
  mid: BucketStats; // 50–79%
  low: BucketStats; // < 50%
}

export function performanceByComponent(candidates: Candidate[], s: RankerSettings): ComponentAnalysis[] {
  const t = closedScoredTrades(candidates);
  const keys: ComponentKey[] = ['trend', 'rvol', 'momentum', 'candle', 'location', 'time'];
  return keys.map((key) => {
    const frac = (c: Candidate) => {
      const max = c.initialScore!.maxes?.[key] ?? 0;
      return max > 0 ? c.initialScore!.components[key] / max : 0;
    };
    return {
      key,
      label: COMPONENT_LABELS[key],
      high: stats('High (≥80%)', t.filter((c) => frac(c) >= 0.8), s.minSampleForAnalysis),
      mid: stats('Mid (50–79%)', t.filter((c) => frac(c) >= 0.5 && frac(c) < 0.8), s.minSampleForAnalysis),
      low: stats('Low (<50%)', t.filter((c) => frac(c) < 0.5), s.minSampleForAnalysis),
    };
  });
}

export function performanceByTimeBucket(candidates: Candidate[], s: RankerSettings): BucketStats[] {
  const t = closedScoredTrades(candidates);
  return s.timeBuckets.map((b, i) => {
    const start = toMinutes(b.start);
    const end = i + 1 < s.timeBuckets.length ? toMinutes(s.timeBuckets[i + 1].start) : 24 * 60;
    return stats(b.label, t.filter((c) => toMinutes(c.alertTime) >= start && toMinutes(c.alertTime) < end), s.minSampleForAnalysis);
  });
}
