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
 *
 * D — terminal MISSED TRIGGER, same evidence standard: the first reliable observation that a fresh trade printed AT OR
 * THROUGH the frozen entry trigger (LONG ≥ entry, SHORT ≤ entry — the price at which the planned stop order would have
 * triggered) while no order was submitted for the alert. Stored under `triggerKey(recordId)`.
 *
 * D4 — first AUTHORIZATION (not terminal; write-once evidence for ticker arbitration): the instant the Live Queue first
 * offered the alert as an order to place. Stored under `authorizedKey(recordId)`. The incumbent of a ticker is the alert
 * with the earliest such record (lifecycle/tickerReservation). A build without these keys ignores them (rollback-safe).
 */
import { RB_V1_DEFAULTS } from '../../settings';
import { quoteAges, type AutomationConfig } from '../alertDecision';
import type { QueueRow } from '../liveQueue';
import { queueOffersOrder } from './executionState';
import { isTriggerEvidence } from '../tradeEligibility';

export interface TerminalEvent {
  recordId: string;
  kind: 'SETUP_FAILED' | 'CHASED' | 'TRIGGER_CROSSED' | 'AUTHORIZED';
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
  /** TRIGGER_CROSSED only (Step 5 · wording): what the crossing evidence was. Provenance only — never read for eligibility. */
  evidence?: TriggerEvidenceInfo;
}

export interface TriggerEvidenceInfo {
  kind: 'ELIGIBLE_TRADE' | 'ODD_LOT_TRADE' | 'MINUTE_BAR';
  /** When the market printed it (trade time), or the start of the 1-minute bar. */
  atIso: string;
  conditions?: string[] | null;
  tape?: string | null;
  /** LIVE_QUOTE = seen on a price poll; DELAYED_RECONSTRUCTION = found by the server when a late snapshot completed. */
  source: 'LIVE_QUOTE' | 'DELAYED_RECONSTRUCTION';
}

export type TerminalEventMap = Record<string, TerminalEvent>;

/** Map key of the S2a terminal chase (kept apart from the record-id key used by SETUP FAILED). */
export const chaseKey = (recordId: string) => `${recordId}|CHASED`;
/** Map key of the terminal missed-trigger crossing. */
export const triggerKey = (recordId: string) => `${recordId}|TRIGGER`;
/** Map key of the first authorization (D4 ticker arbitration evidence; not a terminal event). */
export const authorizedKey = (recordId: string) => `${recordId}|AUTHORIZED`;

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

/**
 * D — the confirmed missed trigger to record for this row now, or null. Same evidence rules as the chase: OK record not
 * under DATA REVIEW, no submitted / filled order, inside the alert window, a fresh quote (existing freshness rules) whose
 * last trade is not older than the alert, the calculator's own crossing of the frozen entry, and the observed price itself
 * at or through the frozen entry. Missing, stale or pre-alert data never latches anything.
 */
export function observedTriggerCross(r: QueueRow, now: number, cfg: Pick<AutomationConfig, 'maxDataAgeSec' | 'maxTradeAgeSec'>): TerminalEvent | null {
  if (r.record.status !== 'OK' || !r.live?.chase?.crossed || !r.quote || !r.candidate) return null;
  if (r.decision.section === 'DATA_REVIEW') return null;
  if (!UNSUBMITTED.includes(r.candidate.status)) return null;
  if (now - r.record.alert.alertTimeMs >= RB_V1_DEFAULTS.alertWindowMinutes * 60_000) return null;
  const ages = quoteAges(r.quote, now);
  if (!ages || ages.dataAgeSec > cfg.maxDataAgeSec || ages.tradeAgeSec > cfg.maxTradeAgeSec) return null;
  const tradeMs = Date.parse(r.quote.tradeIso);
  if (!Number.isFinite(tradeMs) || tradeMs < r.record.receivedMs) return null; // an observation from before the alert
  const { entry, stop } = r.candidate;
  const atr = r.record.snapshot?.values?.atr;
  if (!(entry > 0) || !(stop > 0)) return null;
  // Belt and braces: the observed price itself must be at or through the frozen entry trigger.
  const L = r.record.alert.direction === 'LONG';
  if (L ? r.quote.price < entry : r.quote.price > entry) return null;
  const distanceAtr = atr && atr > 0 ? Math.round(((L ? r.quote.price - entry : entry - r.quote.price) / atr) * 1000) / 1000 : undefined;
  return {
    recordId: r.record.id, kind: 'TRIGGER_CROSSED', direction: r.record.alert.direction, alertTimeMs: r.record.alert.alertTimeMs, observedAtMs: now, price: r.quote.price, stop, quoteTradeIso: r.quote.tradeIso, entry, distanceAtr,
    evidence: { kind: 'ELIGIBLE_TRADE', atIso: r.quote.tradeIso, conditions: r.quote.conditions ?? null, tape: r.quote.tape ?? null, source: 'LIVE_QUOTE' },
  };
}

/**
 * Step 3 · D — conservative trigger evidence from the newest print the server did NOT use as the price (quote.skipped):
 * an odd lot (otherwise eligible conditions) at/through the frozen entry, fresh, after the alert, for an unsubmitted alert.
 * The executable price stays the eligible print; this can only end the alert (MISSED), never create a ticket.
 */
export function observedSkippedCross(r: QueueRow, now: number, cfg: Pick<AutomationConfig, 'maxDataAgeSec' | 'maxTradeAgeSec'>): TerminalEvent | null {
  const s = r.quote?.skipped;
  if (!s || !r.quote || r.record.status !== 'OK' || !r.candidate || !UNSUBMITTED.includes(r.candidate.status)) return null;
  if (r.decision.section === 'DATA_REVIEW') return null;
  if (now - r.record.alert.alertTimeMs >= RB_V1_DEFAULTS.alertWindowMinutes * 60_000) return null;
  if (!isTriggerEvidence({ c: s.conditions, z: s.tape })) return null;
  const tradeMs = Date.parse(s.tradeIso);
  const dataAgeSec = (now - r.quote.receivedMs) / 1000;
  const tradeAgeSec = (Date.parse(r.quote.fetchedIso) - tradeMs) / 1000;
  if (!Number.isFinite(tradeMs) || tradeMs < r.record.receivedMs || dataAgeSec > cfg.maxDataAgeSec || tradeAgeSec > cfg.maxTradeAgeSec) return null;
  const { entry, stop } = r.candidate;
  const L = r.record.alert.direction === 'LONG';
  if (!(entry > 0) || (L ? s.price < entry : s.price > entry)) return null;
  return {
    recordId: r.record.id, kind: 'TRIGGER_CROSSED', direction: r.record.alert.direction, alertTimeMs: r.record.alert.alertTimeMs, observedAtMs: now, price: s.price, stop, quoteTradeIso: s.tradeIso, entry,
    evidence: { kind: 'ODD_LOT_TRADE', atIso: s.tradeIso, conditions: s.conditions, tape: s.tape, source: 'LIVE_QUOTE' },
  };
}

/** Step 3 · A — the crossing the server proved during a delayed reconstruction (before any order could exist), or null. */
export function delayedCrossing(r: QueueRow): TerminalEvent | null {
  const g = r.record.delayedReconstruction?.gap;
  if (r.record.status !== 'OK' || g?.status !== 'CROSSED' || g.crossedPrice === null || !g.crossedAtIso) return null;
  if (r.candidate && !UNSUBMITTED.includes(r.candidate.status)) return null;
  return {
    recordId: r.record.id, kind: 'TRIGGER_CROSSED', direction: r.record.alert.direction, alertTimeMs: r.record.alert.alertTimeMs, observedAtMs: Date.parse(g.crossedAtIso), price: g.crossedPrice, stop: r.candidate?.stop ?? NaN, quoteTradeIso: g.crossedAtIso, entry: g.entry,
    evidence: { kind: g.crossedVia ?? 'MINUTE_BAR', atIso: g.crossedAtIso, conditions: g.crossedConditions ?? null, tape: g.crossedTape ?? null, source: 'DELAYED_RECONSTRUCTION' },
  };
}

/** D4 — the first authorization of this row (the Queue offers it as an order to place now), or null. */
export function observedAuthorization(r: QueueRow, now: number): TerminalEvent | null {
  if (!queueOffersOrder(r) || !r.candidate || !r.quote) return null;
  return { recordId: r.record.id, kind: 'AUTHORIZED', direction: r.record.alert.direction, alertTimeMs: r.record.alert.alertTimeMs, observedAtMs: now, price: r.quote.price, stop: r.candidate.stop, quoteTradeIso: r.quote.tradeIso, entry: r.candidate.entry };
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
    // D — confirmed missed trigger (evidence recorded independently; the lifecycle keeps the first terminal reason).
    // Step 3 · A — a crossing proven by the server during a delayed reconstruction counts the same way.
    const tk = triggerKey(r.record.id);
    if (!prev[tk]) {
      const ev = observedTriggerCross(r, now, cfg) ?? observedSkippedCross(r, now, cfg) ?? delayedCrossing(r);
      if (ev) {
        if (map === prev) map = { ...prev };
        map[tk] = ev;
      }
    }
    // D4 — first authorization (incumbent evidence for ticker arbitration).
    const ak = authorizedKey(r.record.id);
    if (!prev[ak]) {
      const ev = observedAuthorization(r, now);
      if (ev) {
        if (map === prev) map = { ...prev };
        map[ak] = ev;
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
