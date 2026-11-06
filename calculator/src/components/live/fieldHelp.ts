/**
 * Field help for the five primary Live Queue fields (Score, Tier, Decision, Execution, Final State) and the
 * presentation-only "PLACE BUY/SELL STOP" action hint. PURE TEXT / PRESENTATION: nothing here is read by any decision,
 * ranking, ticket, lifecycle, broker or Journal code. Wording verified against alertDecision.decideAlert,
 * candidateRanker.classifyScore, lifecycle/executionState and queueView (production 4bb248b).
 */
import type { QueueRow } from '../../engine/automation/liveQueue';
import type { RankerSettings } from '../../engine/ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../engine/settings';
import { finalBadge } from './queueView';

type Grades = RankerSettings['grades'];
const below = (x: number) => `${+(x - 0.1).toFixed(1)}`;

/** Tier bands exactly as classifyScore applies the Ranker's current grades (score ≥ threshold → that tier). */
export function tierBands(g: Grades): string {
  return `ELITE ≥ ${g.elite} · HIGH ${g.high}–${below(g.elite)} · WATCHLIST ${g.watchlist}–${below(g.high)} · LOW ${g.low}–${below(g.watchlist)} · SKIP < ${g.low}`;
}

export function scoreHelp(g: Grades): string {
  return [
    'RB’s weighted 0–100 assessment of opportunity quality: Setup Quality (max 70 — trend, RVOL, momentum, candle, price location, time of day) + Portfolio Fit (max 30 — capital efficiency, capital availability, correlation, portfolio risk), rounded to 0.1. Expand the alert for the component breakdown.',
    `A score does not override mandatory trading, data-quality or risk rules. Minimum actionable score: ${g.high}. Tier bands: ${tierBands(g)}.`,
    'LIVE unless labelled: “Frozen” = the original alert-time score (reference only, not ranked). Grey “Reference only” = a diagnostic score for a disqualified alert — it cannot authorize a trade. “—” / Score unavailable = no reliable score.',
  ].join('\n\n');
}

export function tierHelp(g: Grades): string {
  return [
    `Quality class of the score: ${tierBands(g)}. LOW and SKIP both mean below the ${g.watchlist} watchlist threshold (Decision: SKIP).`,
    'Tier is a classification only — it is not authorization to place an order (see Decision and Final State).',
    'A grey tier marked “Reference only” is derived from a reference-only score and is diagnostic. N/A = no reliable score, so no tier.',
  ].join('\n\n');
}

export function decisionHelp(g: Grades): string {
  return [
    'Whether the alert qualifies under RB v1.1’s strategy, indicator-validation and opportunity-scoring rules (LIVE). A qualifying decision does not guarantee that the planned entry can still be executed — see Execution and Final State.',
    `TRADE READY: qualifies (score ≥ ${g.high}, capital allocated, order ticket built; ELITE ≥ ${g.elite}). If the execution layer withholds that ticket the badge names the reason instead (e.g. v1.1 TICKET — CHASED / MISSED / AFTER CUTOFF, HELD — TICKER RESERVED).`,
    `WATCHLIST: score ${g.watchlist}–${below(g.high)}, or ≥ ${g.high} but not allocated — monitor only. LATE — REVIEW / EXPIRED — STALE: named by the execution state.`,
    `SKIP: data verified, score below ${g.watchlist}. NOT ELIGIBLE: a hard rule failed (session / entry window, duplicate ticker, stale, setup rules). CHASED: not eligible because price ran past the chase limit. DATA REVIEW: RB could not verify or reproduce the alert data — no trade until resolved.`,
    'SUBMITTED / IN POSITION: you marked the order submitted / filled (or verified broker sync confirmed it).',
  ].join('\n\n');
}

export const EXECUTION_HELP = [
  `Whether the planned entry can still be pursued now (LIVE): current price vs the entry trigger, chase distance (${RB_V1_DEFAULTS.chaseThresholdAtr} ATR), the ${RB_V1_DEFAULTS.alertWindowMinutes}-minute alert window and the ${RB_V1_DEFAULTS.entryWindowEnd} ET entry cutoff. Fresh setups use a BUY STOP (LONG) or SELL STOP (SHORT) at the entry. Placing a stop order is different from the stop order being triggered.`,
  'ACTIVE: valid setup with an order ticket; entry not yet triggered. NOT CROSSED: entry not yet reached, but this alert has no ticket (e.g. WATCHLIST) — do not place.',
  `LATE — REVIEW: price already crossed the entry by ≤ ${RB_V1_DEFAULTS.chaseThresholdAtr} ATR — manual review only, no ticket. CHASED: beyond the chase limit — do not chase. MISSED — TRIGGER CROSSED: the entry traded through without an RB-recorded order — terminal.`,
  `EXPIRED — STALE: no trigger within ${RB_V1_DEFAULTS.alertWindowMinutes} minutes. SETUP FAILED: price breached the planned stop. ENTRY WINDOW CLOSED: after ${RB_V1_DEFAULTS.entryWindowEnd} ET. HELD — TICKER RESERVED: another alert holds this ticker. PORTFOLIO BLOCKED / BELOW THRESHOLD / NOT ELIGIBLE / DATA REVIEW: see Decision.`,
  'SUBMITTED / IN POSITION: from your manual order status or verified broker sync. RB knows about a broker order only after you mark it or broker sync verifies it — it cannot see an order placed since the last sync.',
].join('\n\n');

export const FINAL_HELP = [
  'Combines the strategy decision, execution checks, portfolio capacity, risk limits and the alert lifecycle to say whether RB considers this opportunity actionable (LIVE).',
  'READY: actionable now — place the order manually at your broker. RB runs in PAPER / manual-execution mode and never submits orders.',
  'NO TICKET: nothing to place now (watchlist, review, held, portfolio unverified, after the entry cutoff). NO TRADE: terminal — this alert will not become actionable. SUBMITTED / IN POSITION / CLOSED: lifecycle after you act.',
].join('\n\n');

/**
 * Presentation-only action hint for case A (an order may be placed now). Shown ONLY when the existing authoritative
 * state already says so: the v1.1 decision carries a ticket, the execution layer reports ACTIVE + READY, the Final
 * State badge is READY (which already excludes held / chased / missed / setup-failed / after-cutoff / portfolio-
 * unverified, and known same-ticker orders or positions via the Ranker's EXISTING_SAME_TICKER_POSITION rule), and the
 * alert's candidate has not been marked submitted or filled. Never creates or changes anything.
 */
export function placeOrderHint(r: QueueRow): { label: 'PLACE BUY STOP' | 'PLACE SELL STOP'; detail: string } | null {
  const t = r.decision.ticket;
  const lc = r.lifecycle;
  if (!t || !lc || lc.executionState !== 'ACTIVE' || lc.finalActionability !== 'READY') return null;
  if (finalBadge(r).label !== 'READY') return null;
  if (r.candidate && !['NEW', 'WATCHLIST'].includes(r.candidate.status)) return null;
  const label = t.action === 'BUY' ? 'PLACE BUY STOP' : 'PLACE SELL STOP';
  return { label, detail: `RB considers this actionable now: ${t.action} STOP ${t.quantity} @ ${t.price} (stop loss ${t.stopLoss}, take profit ${t.takeProfit}). Place it manually at your broker — RB never submits orders. The stop order only executes if price reaches the entry.` };
}
