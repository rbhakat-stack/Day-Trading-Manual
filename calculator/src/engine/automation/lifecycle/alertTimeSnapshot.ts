/**
 * CR-03 / CR-04 — immutable alert-time snapshot (client side, write-once).
 *
 * The server record already freezes the market data; this snapshot additionally freezes what RB decided ABOUT the
 * alert at alert time — identity, OHLC, indicators, trade construction, the RB v1.1 score/tier, the RB v1.2 shadow
 * score (/91) with its Option A/B tiers, latency and provenance. It is finalized once: as soon as every expected part
 * is present, or 60 s after receipt with whatever is available (`complete: false`, `missing` lists the gaps).
 * Once written it is never rewritten — later price moves, rescoring, hard fails or manual trades change only the
 * separate execution state (executionState.ts), never this snapshot.
 */
import type { QueueRow } from '../liveQueue';
import type { AutoAlertRecordV12 } from '../v12/audit';
import { RB_V1_DEFAULTS } from '../../settings';
import { etParts } from '../etTime';
import { alertLatency, type AlertLatency } from './latency';

export const SNAPSHOT_FINALIZE_MS = 60_000;
export const ALERT_SNAPSHOT_SCHEMA = 1;

export interface AlertTimeSnapshot {
  schema: typeof ALERT_SNAPSHOT_SCHEMA;
  recordId: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  alertName: string;
  ruleSet: string | null;
  alertTimeMs: number;
  /** ET trading date of the alert (archive / retention key). */
  date: string;
  frozenAtMs: number;
  /** Terminal staleness time: alert time + alert window (10 min). After it the alert can never become READY again. */
  expiresAtMs: number;
  complete: boolean;
  missing: string[];
  latency: AlertLatency;
  ohlc: { open: number; high: number; low: number; close: number; atr: number } | null;
  indicators: { rvol: number | null; rsi: number | null; vwap: number | null; ema9: number | null; ema20: number | null; close15m: number | null; ema20_15m: number | null } | null;
  trade: { entry: number; stop: number; target: number; shares: number; positionValue: number; plannedRisk: number; expectedReward: number; orderType: string } | null;
  v11: { total: number | null; tier: string | null; decision: string; detail: string; components: Record<string, number> | null };
  v12: { total: number | null; max: number; tierOptionA: string | null; tierOptionB: string | null; decision: string | null } | null;
  provenance: { provider: string; feed: string; marketDataThroughIso: string | null; rulesVersion: string; scoringVersion: string | null; strategyVersion: string | null; recordStatus: string };
}

export type AlertSnapshotMap = Record<string, AlertTimeSnapshot>;

/** What a complete snapshot needs for this row (empty = ready to freeze). */
export function missingParts(row: QueueRow): string[] {
  const out: string[] = [];
  if (row.decision.decision === 'SCORING') out.push('v1.1 decision');
  if (row.record.status === 'OK' && row.record.snapshot?.values && !row.candidate && row.decision.section !== 'IGNORE' && row.decision.section !== 'DATA_REVIEW') out.push('trade construction');
  if ((row.record as AutoAlertRecordV12).v12 && row.shadow?.scoring === 'PENDING_V12_RANKING') out.push('v1.2 score');
  return out;
}

export function buildAlertTimeSnapshot(row: QueueRow, now: number, v12Max: number): AlertTimeSnapshot {
  const rec = row.record;
  const a = (rec as AutoAlertRecordV12).v12;
  const v = rec.snapshot?.values;
  const c = row.candidate;
  const init = c?.initialScore ?? null;
  // On the pass that first scores the alert, the v1.1 initial score is frozen from this same ranking row
  // (liveQueue: snapshotOf(ranked)), so the row's ranking IS the alert-time score.
  const firstTotal = init ? init.total : row.ranked?.strategyEligible ? row.ranked.total : null;
  const firstTier = init ? init.tier : row.ranked?.strategyEligible ? row.ranked.tier : null;
  const missing = missingParts(row);
  const s12 = row.shadow?.score ?? null;
  return {
    schema: ALERT_SNAPSHOT_SCHEMA,
    recordId: rec.id,
    symbol: rec.alert.symbol,
    direction: rec.alert.direction,
    alertName: rec.alert.alertName,
    ruleSet: a?.qualification?.ruleSet?.ruleSet ?? null,
    alertTimeMs: rec.alert.alertTimeMs,
    date: etParts(rec.alert.alertTimeMs).date,
    frozenAtMs: now,
    expiresAtMs: rec.alert.alertTimeMs + RB_V1_DEFAULTS.alertWindowMinutes * 60_000,
    complete: missing.length === 0,
    missing,
    latency: alertLatency(rec),
    ohlc: v ? { open: v.open, high: v.high, low: v.low, close: v.close, atr: v.atr } : null,
    indicators: v ? { rvol: v.rvol ?? null, rsi: v.rsi ?? null, vwap: v.vwap ?? null, ema9: v.ema9 ?? null, ema20: v.ema20 ?? null, close15m: v.close15m ?? null, ema20_15m: v.ema20_15m ?? null } : null,
    trade: c ? { entry: c.entry, stop: c.stop, target: c.target, shares: c.shares, positionValue: c.positionValue, plannedRisk: c.plannedRisk, expectedReward: c.expectedReward, orderType: c.orderType } : null,
    v11: {
      total: firstTotal ?? null,
      tier: firstTier ?? null,
      decision: row.decision.decision,
      detail: row.decision.detail,
      components: init ? { ...init.components } : row.ranked?.total != null ? Object.fromEntries(row.ranked.components.map((k) => [k.key, k.points])) : null,
    },
    v12: a ? { total: s12?.total ?? null, max: v12Max, tierOptionA: s12?.tierOptionA ?? null, tierOptionB: s12?.tierOptionB ?? null, decision: row.shadow?.decision ?? null } : null,
    provenance: {
      provider: rec.provider?.name ?? '',
      feed: rec.provider?.feed ?? '',
      marketDataThroughIso: rec.marketDataThroughIso ?? null,
      rulesVersion: rec.versions?.rules ?? '',
      scoringVersion: init?.scoringVersion ?? rec.versions?.scoring ?? null,
      strategyVersion: init?.strategyVersion ?? null,
      recordStatus: rec.status,
    },
  };
}

/**
 * Write-once freeze. A row is frozen when nothing is missing, or when 60 s have passed since receipt. Existing
 * entries are returned untouched (same object), so a snapshot can never be revised.
 */
export function freezeAlertSnapshots(prev: AlertSnapshotMap, rows: QueueRow[], now: number, v12Max: number): { map: AlertSnapshotMap; changed: boolean } {
  let map = prev;
  for (const r of rows) {
    if (prev[r.record.id]) continue;
    const due = now - r.record.receivedMs >= SNAPSHOT_FINALIZE_MS;
    if (missingParts(r).length && !due) continue;
    if (map === prev) map = { ...prev };
    map[r.record.id] = buildAlertTimeSnapshot(r, now, v12Max);
  }
  return { map, changed: map !== prev };
}

/* ───────────────────────── CR-11 retention & export ───────────────────────── */

export const SNAPSHOT_RETENTION_DAYS = 90;

/** Drop snapshots whose alert is older than the retention window (default 90 days). Nothing else is changed. */
export function pruneAlertSnapshots(map: AlertSnapshotMap, now: number, days = SNAPSHOT_RETENTION_DAYS): AlertSnapshotMap {
  const cutoff = now - days * 86_400_000;
  const keep = Object.entries(map).filter(([, s]) => s && s.alertTimeMs >= cutoff);
  return keep.length === Object.keys(map).length ? map : Object.fromEntries(keep);
}

const SNAP_COLS = ['date', 'recordId', 'symbol', 'direction', 'ruleSet', 'alertTime', 'signalClose', 'receiptLagSec', 'processingSec', 'totalLatencySec', 'open', 'high', 'low', 'close', 'atr', 'rvol', 'rsi', 'vwap', 'ema9', 'ema20', 'entry', 'stop', 'target', 'shares', 'plannedRisk', 'v11Total', 'v11Tier', 'v11Decision', 'v12Total', 'v12Max', 'v12TierOptionA', 'v12TierOptionB', 'complete', 'missing', 'provider', 'feed', 'rulesVersion', 'frozenAt'] as const;

/** CSV history export of the frozen snapshots (oldest first), optionally limited to [fromDate, toDate] (ET dates). */
export function alertSnapshotsCsv(map: AlertSnapshotMap, fromDate = '', toDate = '9999-99-99'): string {
  const iso = (ms: number | null) => (ms === null ? '' : new Date(ms).toISOString());
  const cell = (v: unknown) => {
    const t = Array.isArray(v) ? v.join(' ') : v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const rows = Object.values(map)
    .filter((s) => s.date >= fromDate && s.date <= toDate)
    .sort((a, b) => a.alertTimeMs - b.alertTimeMs || a.recordId.localeCompare(b.recordId))
    .map((s) => {
      const v: Record<(typeof SNAP_COLS)[number], unknown> = {
        date: s.date, recordId: s.recordId, symbol: s.symbol, direction: s.direction, ruleSet: s.ruleSet, alertTime: iso(s.alertTimeMs), signalClose: iso(s.latency.signalCloseAt),
        receiptLagSec: s.latency.receiptLagSec, processingSec: s.latency.processingSec, totalLatencySec: s.latency.totalSec,
        open: s.ohlc?.open, high: s.ohlc?.high, low: s.ohlc?.low, close: s.ohlc?.close, atr: s.ohlc?.atr,
        rvol: s.indicators?.rvol, rsi: s.indicators?.rsi, vwap: s.indicators?.vwap, ema9: s.indicators?.ema9, ema20: s.indicators?.ema20,
        entry: s.trade?.entry, stop: s.trade?.stop, target: s.trade?.target, shares: s.trade?.shares, plannedRisk: s.trade?.plannedRisk,
        v11Total: s.v11.total, v11Tier: s.v11.tier, v11Decision: s.v11.decision, v12Total: s.v12?.total, v12Max: s.v12?.max, v12TierOptionA: s.v12?.tierOptionA, v12TierOptionB: s.v12?.tierOptionB,
        complete: s.complete, missing: s.missing, provider: s.provenance.provider, feed: s.provenance.feed, rulesVersion: s.provenance.rulesVersion, frozenAt: iso(s.frozenAtMs),
      };
      return SNAP_COLS.map((k) => cell(v[k])).join(',');
    });
  return [SNAP_COLS.join(','), ...rows].join('\n') + '\n';
}

export type RetentionState = 'OPERATIONAL' | 'STALE_VISIBLE' | 'ARCHIVED';
export const ARCHIVE_AFTER_MS = 12 * 3_600_000;

/**
 * CR-11 — queue visibility (records are never deleted; the server keeps every record and the snapshots are kept
 * for 90 days):
 *   0–10 min            OPERATIONAL
 *   > 10 min            STALE_VISIBLE — still listed for the same session
 *   next ET session or ≥ 12 h  ARCHIVED — removed from the queue, kept in history and exports
 */
export function retentionState(alertTimeMs: number, now: number): RetentionState {
  if (etParts(alertTimeMs).date !== etParts(now).date || now - alertTimeMs >= ARCHIVE_AFTER_MS) return 'ARCHIVED';
  return now - alertTimeMs >= RB_V1_DEFAULTS.alertWindowMinutes * 60_000 ? 'STALE_VISIBLE' : 'OPERATIONAL';
}
