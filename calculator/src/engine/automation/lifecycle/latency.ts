/**
 * CR-01 — alert latency from PERSISTED timestamps only (never the current clock), so the value shown for an alert is
 * identical on every refresh and in every replay. Latency is informational: nothing in any decision reads it.
 *
 *   signalCloseAt   close of the mapped 5-minute signal candle (v1.2 audit mapping; else the 5-minute boundary at or
 *                   before the TrendSpider alert time — the same boundary the server uses for the snapshot)
 *   receivedAt      webhook receipt (server)
 *   decisionReadyAt server finished the snapshot + shared-calculator evaluation (record.processedIso)
 */
import type { AutoAlertRecord } from '../alertDecision';
import type { AutoAlertRecordV12 } from '../v12/audit';

const FIVE_MIN = 5 * 60_000;

export interface AlertLatency {
  signalCloseAt: number | null;
  /** 'MAPPED' = v1.2 signal-candle mapping; 'ALERT_TIME' = 5-minute boundary of the TrendSpider alert time. */
  signalCloseSource: 'MAPPED' | 'ALERT_TIME' | null;
  receivedAt: number;
  decisionReadyAt: number | null;
  /** Webhook receipt − signal candle close (TrendSpider + network). */
  receiptLagSec: number | null;
  /** Decision ready − receipt (RB processing: settle, market data, snapshot, calculator). */
  processingSec: number | null;
  /** Decision ready − signal candle close. */
  totalSec: number | null;
}

const sec = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.round((a - b) / 100) / 10);

export function alertLatency(rec: AutoAlertRecord): AlertLatency {
  const mapped = (rec as AutoAlertRecordV12).v12?.signalMapping?.candleEndMs;
  const alertMs = rec.alert?.alertTimeMs;
  const signalCloseAt = Number.isFinite(mapped) ? (mapped as number) : Number.isFinite(alertMs) ? Math.floor(alertMs / FIVE_MIN) * FIVE_MIN : null;
  const signalCloseSource = Number.isFinite(mapped) ? 'MAPPED' : signalCloseAt === null ? null : 'ALERT_TIME';
  const ready = rec.processedIso ? Date.parse(rec.processedIso) : NaN;
  const decisionReadyAt = Number.isFinite(ready) ? ready : null;
  return {
    signalCloseAt,
    signalCloseSource,
    receivedAt: rec.receivedMs,
    decisionReadyAt,
    receiptLagSec: sec(rec.receivedMs, signalCloseAt),
    processingSec: sec(decisionReadyAt, rec.receivedMs),
    totalSec: sec(decisionReadyAt, signalCloseAt),
  };
}

/** Compact queue text, e.g. "Latency 16s" (— when the decision time is not recorded yet). */
export function latencyLabel(l: AlertLatency | null | undefined): string {
  return l?.totalSec === null || l?.totalSec === undefined ? 'Latency —' : `Latency ${Math.round(l.totalSec)}s`;
}
