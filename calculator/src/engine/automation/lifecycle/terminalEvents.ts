/**
 * Terminal SETUP FAILED latch (v1.2 execution layer, write-once per alert).
 *
 * When an alert's price reaches its structural invalidation level before any order — LONG: at or below the planned
 * stop; SHORT: at or above it — the shared calculator reports the SETUP_FAILED hard rule. That evaluation uses the
 * current price, so on its own it "revives" when price recovers. This module records the first OBSERVED breach once
 * and the execution layer treats the alert as terminally failed from then on: no revival, no actionable ticket.
 *
 * A breach is latched only from a reliable observation:
 *   • the calculator's own SETUP_FAILED hard fail on the live evaluation (same planned stop, same rule);
 *   • a current quote that passes the existing freshness rules (data age ≤ maxDataAgeSec, last trade ≤ maxTradeAgeSec);
 *   • the alert is still inside its alert window and no order has been submitted / filled (the broker governs those).
 * Missing or stale data never latches anything. The frozen alert snapshot, scores and plan are untouched; the RB v1.1
 * decision itself is not changed (the execution layer withholds its ticket, like the 15:30 cutoff).
 *
 * S2a — terminal CHASE, same rules: the first reliable observation that price is beyond the existing 0.25 ATR chase limit
 * (the calculator's own CHASED_SETUP hard fail, re-checked against the frozen entry and the signal ATR) for an unsubmitted
 * alert is recorded once; a later pullback can never re-authorize that alert. It is stored in the same map under
 * `chaseKey(recordId)` — never the record-id key — so a build without S2a ignores it, and SETUP FAILED is still recorded
 * independently (no evidence is suppressed).
 */
import { RB_V1_DEFAULTS } from '../../settings';
import { quoteAges, type AutomationConfig } from '../alertDecision';
import type { QueueRow } from '../liveQueue';

export interface TerminalEvent {
  recordId: string;
  kind: 'SETUP_FAILED' | 'CHASED';
  direction: 'LONG' | 'SHORT';
  alertTimeMs: number;
  observedAtMs: number;
  /** Observed price that breached the planned stop, and the frozen planned stop it breached. */
  price: number;
  stop: number;
  quoteTradeIso: string;
  /** CHASED only: frozen planned entry, observed distance beyond it (ATR) and the limit exceeded. */
  entry?: number;
  distanceAtr?: number;
  thresholdAtr?: number;
}

export type TerminalEventMap = Record<string, TerminalEvent>;

/** Map key of the S2a terminal chase (kept apart from the record-id key used by SETUP FAILED). */
export const chaseKey = (recordId: string) => `${recordId}|CHASED`;

const UNSUBMITTED = ['NEW', 'WATCHLIST'];

/** The breach to latch for this row now, or null (no reliable observation). */
export function observedSetupFailure(r: QueueRow, now: number, cfg: Pick<AutomationConfig, 'maxDataAgeSec' | 'maxTradeAgeSec'>): TerminalEvent | null {
  if (r.record.status !== 'OK' || !r.live || !r.quote) return null;
  if (r.candidate && !UNSUBMITTED.includes(r.candidate.status)) return null;
  if (now - r.record.alert.alertTimeMs >= RB_V1_DEFAULTS.alertWindowMinutes * 60_000) return null;
  if (!r.live.hardFails.some((f) => f.code === 'SETUP_FAILED')) return null;
  const ages = quoteAges(r.quote, now);
  if (!ages || ages.dataAgeSec > cfg.maxDataAgeSec || ages.tradeAgeSec > cfg.maxTradeAgeSec) return null;
  const stop = r.candidate?.stop ?? r.live.plan?.stop;
  if (stop === undefined || stop === null) return null;
  const L = r.record.alert.direction === 'LONG';
  // Belt and braces: the observed price itself must be through the frozen planned stop.
  if (L ? r.quote.price > stop : r.quote.price < stop) return null;
  return { recordId: r.record.id, kind: 'SETUP_FAILED', direction: r.record.alert.direction, alertTimeMs: r.record.alert.alertTimeMs, observedAtMs: now, price: r.quote.price, stop, quoteTradeIso: r.quote.tradeIso };
}

/**
 * S2a — the terminal chase to record for this row now, or null (no reliable observation). Requires: OK record not under
 * DATA REVIEW, no submitted / filled order, inside the alert window, a fresh quote (existing freshness rules) whose last
 * trade is not older than the alert, the calculator's CHASED_SETUP hard fail, and the observed price itself beyond the
 * frozen entry by more than the existing chase limit in signal ATR.
 */
export function observedChase(r: QueueRow, now: number, cfg: Pick<AutomationConfig, 'maxDataAgeSec' | 'maxTradeAgeSec'>): TerminalEvent | null {
  if (r.record.status !== 'OK' || !r.live?.chase || !r.quote) return null;
  if (r.decision.section === 'DATA_REVIEW') return null;
  if (r.candidate && !UNSUBMITTED.includes(r.candidate.status)) return null;
  if (now - r.record.alert.alertTimeMs >= RB_V1_DEFAULTS.alertWindowMinutes * 60_000) return null;
  if (!r.live.hardFails.some((f) => f.code === 'CHASED_SETUP')) return null;
  const ages = quoteAges(r.quote, now);
  if (!ages || ages.dataAgeSec > cfg.maxDataAgeSec || ages.tradeAgeSec > cfg.maxTradeAgeSec) return null;
  const tradeMs = Date.parse(r.quote.tradeIso);
  if (!Number.isFinite(tradeMs) || tradeMs < r.record.receivedMs) return null; // an observation from before the alert
  const entry = r.candidate?.entry ?? r.live.plan?.entry;
  const stop = r.candidate?.stop ?? r.live.plan?.stop;
  const atr = r.record.snapshot?.values?.atr;
  const limit = r.live.chase.thresholdAtr;
  if (entry === undefined || entry === null || stop === undefined || stop === null || !atr || !(atr > 0)) return null;
  // Belt and braces: the observed price itself must be beyond the frozen entry by more than the limit.
  const distanceAtr = (r.record.alert.direction === 'LONG' ? r.quote.price - entry : entry - r.quote.price) / atr;
  if (!(distanceAtr > limit)) return null;
  return {
    recordId: r.record.id, kind: 'CHASED', direction: r.record.alert.direction, alertTimeMs: r.record.alert.alertTimeMs, observedAtMs: now,
    price: r.quote.price, stop, quoteTradeIso: r.quote.tradeIso, entry, distanceAtr: Math.round(distanceAtr * 1000) / 1000, thresholdAtr: limit,
  };
}

/** Write-once: existing events are never changed or removed (same object returned when nothing new is latched). */
export function latchTerminalEvents(prev: TerminalEventMap, rows: QueueRow[], now: number, cfg: Pick<AutomationConfig, 'maxDataAgeSec' | 'maxTradeAgeSec'>): { map: TerminalEventMap; changed: boolean } {
  let map = prev;
  for (const r of rows) {
    if (!prev[r.record.id]) {
      const ev = observedSetupFailure(r, now, cfg);
      if (ev) {
        if (map === prev) map = { ...prev };
        map[r.record.id] = ev;
      }
    }
    // S2a — terminal chase, recorded independently of SETUP FAILED (both are evidence; neither suppresses the other).
    const ck = chaseKey(r.record.id);
    if (!prev[ck]) {
      const ev = observedChase(r, now, cfg);
      if (ev) {
        if (map === prev) map = { ...prev };
        map[ck] = ev;
      }
    }
  }
  return { map, changed: map !== prev };
}

/** Same 90-day retention as the alert snapshots. */
export function pruneTerminalEvents(map: TerminalEventMap, now: number, days = 90): TerminalEventMap {
  const cutoff = now - days * 86_400_000;
  const keep = Object.entries(map).filter(([, e]) => e && e.alertTimeMs >= cutoff);
  return keep.length === Object.keys(map).length ? map : Object.fromEntries(keep);
}
