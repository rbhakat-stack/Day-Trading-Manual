/**
 * D4 — one actionable alert per ticker (execution layer; RB v1 never pyramids).
 *
 * Every distinct alert is evaluated on its own (no candidate reserves a ticker merely because it exists). A ticker is
 * RESERVED only by an alert the Live Queue actually authorized (offered as an order to place):
 *
 *   • Incumbent — among the ticker's alerts (LONG or SHORT) with a recorded first authorization (`authorizedKey`), the
 *     earliest one that is still a live reservation: unsubmitted (NEW / WATCHLIST), inside its own alert window, and
 *     without a latched terminal event (SETUP FAILED, CHASED, MISSED TRIGGER). The reservation is sticky: a holder whose
 *     score or price flickers this pass keeps the ticker; a newly qualified alert never displaces it.
 *   • No incumbent — of the alerts the Queue offers this pass, the earliest alert (then arrival, then id) is offered; it
 *     records its first authorization and becomes the incumbent from the next pass.
 *   • Every other alert of the ticker that the Queue would offer is HELD: its ticket is withheld (NO TICKET), it keeps its
 *     own diagnostic evaluation, and it may compete again after the reservation ends (submission, terminal event or
 *     expiry of the holder) — still inside its own window and subject to every existing gate.
 *   • While a live incumbent holds the ticker, its challengers are kept out of the capital / slot / correlation
 *     allocation (`heldCandidateIds`, used by the Queue), so a later higher-scoring alert can never take the incumbent's
 *     allocation (no displacement); they are scored for display only, like untrusted-data alerts.
 *
 * A submitted order or an open position (RB PENDING / FILLED, or verified broker facts) is handled earlier by the existing
 * same-ticker hard rule and the duplicate block; missing / stale broker verification already withholds every ticket.
 * Pure and deterministic: the result depends only on the rows, the write-once event map and `now`.
 */
import type { Candidate } from '../../ranker/opportunityTypes';
import { RB_V1_DEFAULTS } from '../../settings';
import { etParts } from '../etTime';
import type { QueueRow } from '../liveQueue';
import { queueOffersOrder } from './executionState';
import { authorizedKey, chaseKey, triggerKey, type TerminalEventMap } from './terminalEvents';

const UNSUBMITTED = ['NEW', 'WATCHLIST'];
const T = (s: string) => s.toUpperCase();

export interface TickerReservation {
  ticker: string;
  recordId: string;
  alertTimeMs: number;
  /** First recorded authorization (null = authorized for the first time on this pass). */
  authorizedAtMs: number | null;
  untilMs: number;
}

const WINDOW_MS = RB_V1_DEFAULTS.alertWindowMinutes * 60_000;
const windowEnd = (r: QueueRow) => r.record.alert.alertTimeMs + WINDOW_MS;
const order = (a: QueueRow, b: QueueRow) => a.record.alert.alertTimeMs - b.record.alert.alertTimeMs || a.record.receivedMs - b.record.receivedMs || a.record.id.localeCompare(b.record.id);

/** A recorded authorization that is still a live reservation: unsubmitted, inside its own window, no latched terminal event. */
function liveIncumbent(c: Candidate, events: TerminalEventMap, now: number): boolean {
  const id = c.id;
  if (!events[authorizedKey(id)] || c.archived || !UNSUBMITTED.includes(c.status) || c.alertMs === undefined) return false;
  if (now >= c.alertMs + WINDOW_MS) return false;
  return !events[id] && !events[chaseKey(id)] && !events[triggerKey(id)];
}

/**
 * Unsubmitted candidates of a ticker held by a live incumbent (other than the incumbent itself). The Queue keeps them out
 * of the capital / slot / correlation allocation — like untrusted-data alerts — so a challenger can never take the
 * incumbent's allocation; they are still scored for display (their own independent evaluation).
 */
export function heldCandidateIds(candidates: Candidate[], events: TerminalEventMap | undefined, now: number): Set<string> {
  const ev = events ?? {};
  const held = new Set<string>();
  const incumbents = candidates.filter((c) => liveIncumbent(c, ev, now));
  if (!incumbents.length) return held;
  const tickers = new Map<string, string>();
  for (const c of [...incumbents].sort((a, b) => ev[authorizedKey(a.id)].observedAtMs - ev[authorizedKey(b.id)].observedAtMs || a.id.localeCompare(b.id))) if (!tickers.has(T(c.ticker))) tickers.set(T(c.ticker), c.id);
  for (const c of candidates) {
    const holder = tickers.get(T(c.ticker));
    if (holder && holder !== c.id && UNSUBMITTED.includes(c.status) && !c.archived) held.add(c.id);
  }
  return held;
}

/** The reservation holder per ticker for this pass (absent = the ticker is free). */
export function tickerReservations(rows: QueueRow[], events: TerminalEventMap | undefined, now: number): Map<string, TickerReservation> {
  const ev = events ?? {};
  const out = new Map<string, TickerReservation>();
  const byTicker = new Map<string, QueueRow[]>();
  for (const r of rows) byTicker.set(T(r.record.alert.symbol), [...(byTicker.get(T(r.record.alert.symbol)) ?? []), r]);
  for (const [ticker, rs] of byTicker) {
    const incumbents = rs
      .filter((r) => !!r.candidate && liveIncumbent(r.candidate, ev, now))
      .sort((a, b) => ev[authorizedKey(a.record.id)].observedAtMs - ev[authorizedKey(b.record.id)].observedAtMs || order(a, b));
    const holder = incumbents[0] ?? rs.filter(queueOffersOrder).sort(order)[0];
    if (!holder) continue;
    out.set(ticker, { ticker, recordId: holder.record.id, alertTimeMs: holder.record.alert.alertTimeMs, authorizedAtMs: ev[authorizedKey(holder.record.id)]?.observedAtMs ?? null, untilMs: windowEnd(holder) });
  }
  return out;
}

/** Withhold the ticket of every offered alert that does not hold its ticker's reservation (lifecycle only). */
export function applyTickerReservations(rows: QueueRow[], events: TerminalEventMap | undefined, now: number): QueueRow[] {
  const res = tickerReservations(rows, events, now);
  return rows.map((r) => {
    const h = res.get(T(r.record.alert.symbol));
    if (!h || h.recordId === r.record.id || !queueOffersOrder(r)) return r;
    const t = (ms: number) => etParts(ms).hhmmss;
    const since = h.authorizedAtMs !== null ? `, authorized since ${t(h.authorizedAtMs)} ET` : '';
    return {
      ...r,
      lifecycle: {
        ...r.lifecycle,
        executionState: 'HELD — TICKER RESERVED',
        finalActionability: 'NO TICKET',
        heldBy: { recordId: h.recordId, alertTimeMs: h.alertTimeMs, authorizedAtMs: h.authorizedAtMs, untilMs: h.untilMs },
        reason: `HELD — ${r.record.alert.symbol} is reserved by the earlier authorized alert ${h.recordId} (alert ${t(h.alertTimeMs)} ET${since}) until it is submitted, reaches a terminal state or expires (${t(h.untilMs)} ET). One actionable alert per ticker; RB v1 never pyramids. This alert stays evaluated and may compete after the reservation ends, inside its own window.`,
      },
    };
  });
}
