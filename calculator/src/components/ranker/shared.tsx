import type { Recommendation } from '../../engine/ranker/opportunityTypes';
import type { Tone } from '../../engine/tradeCalculator';

/** Tone for each standardized recommendation (and lifecycle display statuses). */
export function recTone(rec: string): Tone {
  if (rec.startsWith('TRADE NOW')) return 'long';
  if (rec.startsWith('WATCHLIST') || rec === 'CAPITAL WAITLIST' || rec === 'LOW PRIORITY' || rec.startsWith('SCORING') || rec.startsWith('PENDING')) return 'warn';
  if (rec.startsWith('BLOCKED') || rec.startsWith('NOT ELIGIBLE') || rec.startsWith('SKIP')) return 'danger';
  return 'neutral';
}

export const REC_HELP: Record<Recommendation, string> = {
  'TRADE NOW — ELITE': 'Elite score, every hard rule passed, and capital is allocated. Highest-priority candidate under the current scoring model — not a guarantee of a win.',
  'TRADE NOW — HIGH PRIORITY': 'Score ≥ 85, every hard rule passed, and capital is allocated after any higher-ranked candidates.',
  'CAPITAL WAITLIST': 'Qualifies (≥ 85), but higher-ranked candidates use the available capital, slots or heat.',
  'WATCHLIST / RESERVE': 'Score 80–84: below the 85 trade threshold. Not a normal trade candidate.',
  'LOW PRIORITY': 'Score 75–79: normally skip.',
  'SKIP — QUALITY BELOW THRESHOLD': 'Score below 75.',
  'BLOCKED — CAPITAL': 'Hard rule: not enough RB v1 allocatable capital, or above the max single position.',
  'BLOCKED — NO POSITION SLOT': 'Hard rule: all position slots are in use (open + pending).',
  'BLOCKED — PORTFOLIO HEAT': 'Hard rule: would exceed the aggregate planned-risk limit.',
  'BLOCKED — CORRELATED EXPOSURE': 'Hard rule: correlated with an existing or higher-ranked trade in the same theme (LONG and SHORT both count by default).',
  'NOT ELIGIBLE — CANNOT BE RANKED': 'A strategy hard rule failed. The setup is not scored or ranked. See the reasons below.',
  'SCORING INCOMPLETE': 'Required inputs are missing. No score is produced until they are entered.',
};

export function ScoreBar({ points, max, tone = 'bg-[#5b8cff]' }: { points: number; max: number; tone?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (points / max) * 100)) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-700">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export const fmtScore = (x: number | null) => (x === null ? '—' : Number.isInteger(x) ? String(x) : x.toFixed(1));
