/**
 * CR-01 — Decision Latency from PERSISTED timestamps of the ORIGINAL processing lifecycle (never the current clock,
 * never a retry), so the value shown for an alert is identical on every refresh, after any retry and in every replay.
 * Latency is informational: nothing in any decision reads it.
 *
 *   signalCloseAt          close of the mapped 5-minute signal candle (v1.2 audit mapping; else the 5-minute boundary at
 *                          or before the TrendSpider alert time — the same boundary the server uses for the snapshot)
 *   firstReceivedAt        webhook receipt (server; retries never change it)
 *   initialDecisionReadyAt end of the FIRST processing attempt (record.firstProcessedIso, written once). Older records
 *                          without it: processedIso when the record was processed exactly once, otherwise unknown.
 *
 *   Webhook lag = firstReceivedAt − signalCloseAt · RB processing = initialDecisionReadyAt − firstReceivedAt
 *   Total Decision Latency = initialDecisionReadyAt − signalCloseAt
 * Retry facts (count, last processed time, last attempt duration) are reported separately.
 */
import type { AutoAlertRecord } from '../alertDecision';
import type { AutoAlertRecordV12 } from '../v12/audit';

const FIVE_MIN = 5 * 60_000;

export interface AlertLatency {
  signalCloseAt: number | null;
  /** 'MAPPED' = v1.2 signal-candle mapping; 'ALERT_TIME' = 5-minute boundary of the TrendSpider alert time. */
  signalCloseSource: 'MAPPED' | 'ALERT_TIME' | null;
  /** First webhook receipt (alias kept as `receivedAt` for existing callers). */
  receivedAt: number;
  /** End of the first processing attempt; null when it was not recorded (older record that was retried). */
  decisionReadyAt: number | null;
  /** Webhook lag: receipt − signal candle close (TrendSpider + network). */
  receiptLagSec: number | null;
  /** RB processing: initial decision ready − receipt (settle, market data, snapshot, calculator). */
  processingSec: number | null;
  /** Total Decision Latency: initial decision ready − signal candle close. */
  totalSec: number | null;
  /** Retry observability — never part of Decision Latency. */
  retry: { count: number; lastProcessedAt: number | null; lastDurationSec: number | null } | null;
}

const sec = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.round((a - b) / 100) / 10);
const t = (iso: string | null | undefined) => (iso && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : null);

export function alertLatency(rec: AutoAlertRecord): AlertLatency {
  const mapped = (rec as AutoAlertRecordV12).v12?.signalMapping?.candleEndMs;
  const alertMs = rec.alert?.alertTimeMs;
  const signalCloseAt = Number.isFinite(mapped) ? (mapped as number) : Number.isFinite(alertMs) ? Math.floor(alertMs / FIVE_MIN) * FIVE_MIN : null;
  const signalCloseSource = Number.isFinite(mapped) ? 'MAPPED' : signalCloseAt === null ? null : 'ALERT_TIME';
  const retries = rec.retry?.count ?? Math.max(0, (rec.attempts ?? 0) - 1);
  const decisionReadyAt = rec.firstProcessedIso !== undefined && rec.firstProcessedIso !== null ? t(rec.firstProcessedIso) : retries === 0 ? t(rec.processedIso) : null;
  return {
    signalCloseAt,
    signalCloseSource,
    receivedAt: rec.receivedMs,
    decisionReadyAt,
    receiptLagSec: sec(rec.receivedMs, signalCloseAt),
    processingSec: sec(decisionReadyAt, rec.receivedMs),
    totalSec: sec(decisionReadyAt, signalCloseAt),
    retry: retries > 0 ? { count: retries, lastProcessedAt: t(rec.retry?.lastProcessedIso ?? rec.processedIso), lastDurationSec: rec.retry ? Math.round(rec.retry.lastDurationMs / 100) / 10 : null } : null,
  };
}

/** Compact queue text, e.g. "Latency 16s" (— when the original decision time is not recorded). */
export function latencyLabel(l: AlertLatency | null | undefined): string {
  return l?.totalSec === null || l?.totalSec === undefined ? 'Latency —' : `Latency ${Math.round(l.totalSec)}s`;
}
