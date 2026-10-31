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
  /** Mapped signal candle (HH:MM–HH:MM ET) and webhook lag after its close. */
  signalCandle: string | null;
  lagSec: number | null;
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
  /** Alert-time ticket geometry from the shared RB calculator. */
  entry: number | null;
  stop: number | null;
  target: number | null;
  shares: number | null;
  /** Why a manual TrendSpider RVOL capture is worth doing for this alert (empty = optional). */
  capturePriority: string[];
}

/** Capture priorities for the manual TrendSpider RVOL reading (A vs B calibration). */
export function capturePriority(e: Pick<V12ShadowLogEntry, 'direction' | 'tierOptionA' | 'tierOptionB' | 'v12Total'>, shadowHigh: number): string[] {
  const out: string[] = [];
  if (e.tierOptionB === 'HIGH_PRIORITY' || e.tierOptionB === 'ELITE') out.push('HIGH_OR_ELITE_SHADOW');
  if (e.tierOptionA !== e.tierOptionB) out.push('A_B_DISAGREE');
  if (e.direction === 'SHORT') out.push('SHORT');
  if (Math.abs(e.v12Total - shadowHigh) <= 2) out.push('NEAR_TRADE_THRESHOLD');
  return out;
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
      signalCandle: a?.signalMapping.label ?? null,
      lagSec: a?.signalMapping.lagSec ?? null,
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
      entry: a?.ticketAtAlert?.entry ?? null,
      stop: a?.ticketAtAlert?.stop ?? null,
      target: a?.ticketAtAlert?.target ?? null,
      shares: a?.ticketAtAlert?.shares ?? null,
      capturePriority: [],
    };
    log[r.record.id].capturePriority = capturePriority(log[r.record.id], s.thresholds.shadow.high);
  }
  return { log, changed: log !== prev };
}

const COLS: (keyof V12ShadowLogEntry)[] = ['recordId', 'symbol', 'direction', 'alertTimeMs', 'ruleSet', 'qualification', 'mapping', 'signalCandle', 'lagSec', 'scoredAtMs', 'v12Total', 'tierOptionB', 'tierOptionA', 'thresholdsB', 'thresholdsA', 'v11Total', 'v11Tier', 'deltaVsV11', 'v12Decision', 'v11Decision', 'warnings', 'dataReview', 'entry', 'stop', 'target', 'shares', 'capturePriority'];

/** CSV export of the log (oldest alert first). The last column is left empty for a manual TrendSpider RVOL reading. */
export function shadowLogCsv(log: V12ShadowLog): string {
  const cell = (v: unknown) => {
    const t = Array.isArray(v) ? v.join(' ') : v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const rows = Object.values(log).sort((a, b) => a.alertTimeMs - b.alertTimeMs || a.recordId.localeCompare(b.recordId));
  return [[...COLS, 'tsRvolManual'].join(','), ...rows.map((e) => [...COLS.map((k) => cell(e[k])), ''].join(','))].join('\n') + '\n';
}
