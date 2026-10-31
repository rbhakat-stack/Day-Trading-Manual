/**
 * RB v1.2 SHADOW comparison log (Step 7, RB_V1_2_ARCHITECTURE.md §27). Keeps, per alert record, the FIRST complete
 * v1.2 shadow score — raw total, Option B tier, Option A tier, the RB v1.1 score and the delta — for the later
 * threshold calibration. Frozen once written (same rule as the v1.1 initial score). Comparison data only: nothing
 * reads it back into a decision.
 */
import type { QueueRow } from '../liveQueue';
import type { AutoAlertRecordV12 } from './audit';

export interface V12ShadowLogEntry {
  recordId: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  alertTimeMs: number;
  ruleSet: string | null;
  qualification: string;
  mapping: string;
  scoredAtMs: number;
  v12Total: number;
  tierOptionB: string | null;
  tierOptionA: string | null;
  thresholdsB: string;
  thresholdsA: string;
  v11Total: number | null;
  v11Tier: string | null;
  deltaVsV11: number | null;
  v12Decision: string;
  v11Decision: string;
  warnings: string[];
  dataReview: string[];
}

export type V12ShadowLog = Record<string, V12ShadowLogEntry>;

const g = (x: { elite: number; high: number; watchlist: number; low: number }) => `${x.elite}/${x.high}/${x.watchlist}/${x.low}`;

/** Add entries for rows scored by v1.2 for the first time. Existing entries are never rewritten. */
export function freezeShadowScores(prev: V12ShadowLog, rows: QueueRow[], now: number): { log: V12ShadowLog; changed: boolean } {
  let log = prev;
  for (const r of rows) {
    const s = r.shadow?.score;
    if (!s || s.total === null || prev[r.record.id]) continue;
    const a = (r.record as AutoAlertRecordV12).v12;
    if (log === prev) log = { ...prev };
    log[r.record.id] = {
      recordId: r.record.id,
      symbol: r.record.alert.symbol,
      direction: r.record.alert.direction,
      alertTimeMs: r.record.alert.alertTimeMs,
      ruleSet: a?.qualification.ruleSet.ruleSet ?? null,
      qualification: a?.qualification.status ?? '',
      mapping: a?.signalMapping.status ?? '',
      scoredAtMs: now,
      v12Total: s.total,
      tierOptionB: s.tierOptionB,
      tierOptionA: s.tierOptionA,
      thresholdsB: g(s.thresholds.shadow),
      thresholdsA: g(s.thresholds.optionA),
      v11Total: s.v11Total,
      v11Tier: r.ranked?.tier ?? null,
      deltaVsV11: s.deltaVsV11,
      v12Decision: r.shadow!.decision,
      v11Decision: r.decision.decision,
      warnings: [...r.shadow!.warnings],
      dataReview: [...r.shadow!.dataReview],
    };
  }
  return { log, changed: log !== prev };
}

const COLS: (keyof V12ShadowLogEntry)[] = ['recordId', 'symbol', 'direction', 'alertTimeMs', 'ruleSet', 'qualification', 'mapping', 'scoredAtMs', 'v12Total', 'tierOptionB', 'tierOptionA', 'thresholdsB', 'thresholdsA', 'v11Total', 'v11Tier', 'deltaVsV11', 'v12Decision', 'v11Decision', 'warnings', 'dataReview'];

/** CSV export of the log (oldest alert first). */
export function shadowLogCsv(log: V12ShadowLog): string {
  const cell = (v: unknown) => {
    const t = Array.isArray(v) ? v.join(' ') : v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const rows = Object.values(log).sort((a, b) => a.alertTimeMs - b.alertTimeMs || a.recordId.localeCompare(b.recordId));
  return [COLS.join(','), ...rows.map((e) => COLS.map((k) => cell(e[k])).join(','))].join('\n') + '\n';
}
