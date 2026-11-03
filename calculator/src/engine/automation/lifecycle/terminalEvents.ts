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
 */
import { RB_V1_DEFAULTS } from '../../settings';
import { quoteAges, type AutomationConfig } from '../alertDecision';
import type { QueueRow } from '../liveQueue';

export interface TerminalEvent {
  recordId: string;
  kind: 'SETUP_FAILED';
  direction: 'LONG' | 'SHORT';
  alertTimeMs: number;
  observedAtMs: number;
  /** Observed price that breached the planned stop, and the frozen planned stop it breached. */
  price: number;
  stop: number;
  quoteTradeIso: string;
}

export type TerminalEventMap = Record<string, TerminalEvent>;

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

/** Write-once: existing events are never changed or removed (same object returned when nothing new is latched). */
export function latchTerminalEvents(prev: TerminalEventMap, rows: QueueRow[], now: number, cfg: Pick<AutomationConfig, 'maxDataAgeSec' | 'maxTradeAgeSec'>): { map: TerminalEventMap; changed: boolean } {
  let map = prev;
  for (const r of rows) {
    if (prev[r.record.id]) continue;
    const ev = observedSetupFailure(r, now, cfg);
    if (!ev) continue;
    if (map === prev) map = { ...prev };
    map[r.record.id] = ev;
  }
  return { map, changed: map !== prev };
}

/** Same 90-day retention as the alert snapshots. */
export function pruneTerminalEvents(map: TerminalEventMap, now: number, days = 90): TerminalEventMap {
  const cutoff = now - days * 86_400_000;
  const keep = Object.entries(map).filter(([, e]) => e && e.alertTimeMs >= cutoff);
  return keep.length === Object.keys(map).length ? map : Object.fromEntries(keep);
}
