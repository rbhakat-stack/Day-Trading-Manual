/**
 * CR-04 – CR-07, CR-10, CR-13 — the live EXECUTION layer, kept separate from the immutable alert-time snapshot.
 *
 * Three independent answers per alert (CR-07):
 *   Alert-Time Tier       — frozen at alert time (alertTimeSnapshot); never changes.
 *   Current Execution State — what the setup is doing now (not crossed, late, chased, expired, submitted, …).
 *   Final Actionability   — READY (a ticket exists) / NO TICKET (nothing to do yet) / NO TRADE (terminal).
 *
 * Pure presentation of the existing decisions: the RB v1.1 decision (`row.decision`) is read, never changed, and
 * nothing here can create a ticket. READY is only ever reported where the active decision already carries a ticket.
 */
import { RB_V1_DEFAULTS } from '../../settings';
import type { Candidate, ManualPosition } from '../../ranker/opportunityTypes';
import { etParts } from '../etTime';
import type { QueueRow } from '../liveQueue';
import type { AlertTimeSnapshot } from './alertTimeSnapshot';
import type { AutoAlertRecordV12 } from '../v12/audit';

export type ExecutionState =
  | 'SCORING'
  | 'NOT CROSSED'
  | 'ACTIVE'
  | 'LATE — REVIEW'
  | 'CHASED'
  | 'EXPIRED — STALE'
  | 'ENTRY WINDOW CLOSED'
  | 'PORTFOLIO BLOCKED'
  | 'BELOW THRESHOLD'
  | 'NOT ELIGIBLE'
  | 'DATA REVIEW'
  | 'SUBMITTED'
  | 'IN POSITION'
  | 'CLOSED';

export type FinalActionability = 'READY' | 'NO TICKET' | 'NO TRADE';

export type GateResult = 'PASS' | 'FAIL' | 'PENDING' | 'NOT SCORED' | 'NOT EVALUATED — NOT REQUIRED' | 'NOT ATTEMPTED' | `BLOCKED — ${string}`;

export interface GateSequence {
  score: GateResult;
  portfolio: GateResult;
  capital: GateResult;
}

export interface ScoreDisplay {
  value: number | null;
  /** LIVE = current ranking; FROZEN = alert-time score shown for reference after a hard fail / expiry. */
  basis: 'LIVE' | 'FROZEN — REFERENCE ONLY' | 'NONE';
  rank: number | 'NOT RANKED';
}

export interface Lifecycle {
  alertTimeTier: string | null;
  executionState: ExecutionState;
  finalActionability: FinalActionability;
  /** One-line reason for the execution state / actionability. */
  reason: string;
  terminal: boolean;
  /**
   * CR-13 — the RB v1.1 decision still carries its (historical) ticket but the 15:30 ET entry cutoff has passed:
   * the ticket must NOT be executed. The v1.1 output itself is unchanged.
   */
  entryWindowClosed: boolean;
  gates: GateSequence;
  score: ScoreDisplay;
  eod: EodStatus;
}

const CLOSED = ['TARGET_HIT', 'STOPPED_OUT', 'MANUAL_EXIT', 'SKIPPED', 'CANCELED', 'EXPIRED', 'STALE'];
const PORTFOLIO_BLOCKS: Record<string, string> = {
  'BLOCKED — NO POSITION SLOT': 'NO_POSITION_SLOT',
  'BLOCKED — PORTFOLIO HEAT': 'PORTFOLIO_HEAT_LIMIT',
  'BLOCKED — CORRELATED EXPOSURE': 'CORRELATION_LIMIT',
};

/** CR-10 — gates are evaluated in order; a later gate is never reported as failing when an earlier one stopped it. */
export function gateSequence(row: QueueRow): GateSequence {
  const r = row.ranked;
  if (row.decision.decision === 'SCORING') return { score: 'PENDING', portfolio: 'PENDING', capital: 'PENDING' };
  if (!r) return { score: 'NOT SCORED', portfolio: 'NOT EVALUATED — NOT REQUIRED', capital: 'NOT ATTEMPTED' };
  const tier = r.tier;
  const score: GateResult = r.total === null || !tier ? 'NOT SCORED' : tier === 'ELITE' || tier === 'HIGH_PRIORITY' ? 'PASS' : 'FAIL';
  const rec = r.recommendation ?? '';
  // Portfolio hard rules (slot / heat / correlation) are hard rules: RB v1.1 evaluates them regardless of the score, and
  // a full portfolio also lowers the portfolio-fit points. When one failed, it is reported as the block — never hidden
  // behind "NOT EVALUATED".
  const block = PORTFOLIO_BLOCKS[rec] ?? r.hardFails.find((f) => ['NO_POSITION_SLOT', 'PORTFOLIO_HEAT_LIMIT', 'CORRELATION_LIMIT'].includes(f.code))?.code;
  if (score === 'FAIL' && block) return { score, portfolio: `BLOCKED — ${block}`, capital: 'NOT ATTEMPTED' };
  if (score !== 'PASS') return { score, portfolio: 'NOT EVALUATED — NOT REQUIRED', capital: 'NOT ATTEMPTED' };
  if (block) return { score, portfolio: `BLOCKED — ${block}`, capital: 'NOT ATTEMPTED' };
  if (rec.startsWith('TRADE NOW')) return { score, portfolio: 'PASS', capital: 'PASS' };
  if (rec === 'BLOCKED — CAPITAL' || rec === 'CAPITAL WAITLIST' || r.allocation?.reason === 'CAPITAL') return { score, portfolio: 'PASS', capital: 'BLOCKED — CAPITAL_LIMIT' };
  return { score, portfolio: 'PASS', capital: r.allocation?.allocated ? 'PASS' : `BLOCKED — ${r.allocation?.reason ?? 'NOT ALLOCATED'}` };
}

/* ───────────────────────── CR-13 end of day (detect & flag only) ───────────────────────── */

export type EodPhase = 'OPEN' | 'NO NEW ENTRIES' | 'EOD CANCEL REQUIRED' | 'EOD EXIT REQUIRED' | 'FLAT REQUIRED' | 'FLAT' | 'NOT FLAT AFTER CLOSE' | 'CLOSED';

export interface EodStatus {
  phase: EodPhase;
  noNewEntries: boolean;
  actionRequired: boolean;
  pendingOrders: number;
  openPositions: number;
  /** Tickers behind the counts (RB lifecycle, manual positions and — when merged — read-only broker facts). */
  pendingTickers: string[];
  openTickers: string[];
  message: string;
}

const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const ENTRY_WINDOW_CLOSED = 'NO TICKET — ENTRY WINDOW CLOSED. DO NOT EXECUTE — AFTER 3:30 PM ENTRY CUTOFF (any ticket issued for this alert before 15:30 is historical).';
const WINDOW_CLOSED_DETAIL = 'NOT ELIGIBLE — NEW ENTRY WINDOW CLOSED';
/** The entry window closed AFTER a valid alert (alert before 15:30, evaluated at/after it) — time-driven, not never-eligible. */
const closedAfterAlert = (row: QueueRow, detail: string) => detail === WINDOW_CLOSED_DETAIL && etParts(row.record.alert.alertTimeMs).hhmm < RB_V1_DEFAULTS.entryWindowEnd;
export const EOD_TIMES = { noNewEntries: '15:30', cancel: '15:50', exit: '15:55', flat: '15:58', close: '16:00' } as const;

/**
 * Portfolio-level EOD state. Counts pending orders and open positions (automated candidates + manual positions, one per
 * ticker). It never places, cancels or closes anything — every broker action at EOD stays manual.
 */
export function eodStatus(now: number, candidates: Candidate[], positions: ManualPosition[]): EodStatus {
  const today = etParts(now).date;
  const pending = candidates.filter((c) => c.status === 'PENDING' && c.date === today && !c.archived).map((c) => c.ticker);
  const open = [...candidates.filter((c) => c.status === 'FILLED' && !c.archived).map((c) => c.ticker), ...positions.filter((p) => p.status === 'OPEN').map((p) => p.ticker)];
  return eodFrom(now, pending, open);
}

/** Merge read-only broker facts (open positions, unfilled entry orders) into an EOD status — flag only. */
export function withBrokerFacts(e: EodStatus, now: number, broker: { openTickers: string[]; pendingTickers: string[] }): EodStatus {
  return eodFrom(now, [...e.pendingTickers, ...broker.pendingTickers], [...e.openTickers, ...broker.openTickers]);
}

function eodFrom(now: number, pendingList: string[], openList: string[]): EodStatus {
  const t = mins(etParts(now).hhmm);
  const pending = new Set(pendingList.map((x) => x.toUpperCase()));
  const open = new Set(openList.map((x) => x.toUpperCase()));
  const base = { pendingOrders: pending.size, openPositions: open.size, pendingTickers: [...pending].sort(), openTickers: [...open].sort() };
  const st = (phase: EodPhase, noNewEntries: boolean, actionRequired: boolean, message: string): EodStatus => ({ phase, noNewEntries, actionRequired, message, ...base });
  const flat = pending.size === 0 && open.size === 0;
  if (t < mins(EOD_TIMES.noNewEntries)) return st('OPEN', false, false, 'Normal session.');
  if (t >= mins(EOD_TIMES.close)) return flat ? st('CLOSED', true, false, 'Market closed — portfolio flat.') : st('NOT FLAT AFTER CLOSE', true, true, `Market closed with ${open.size} open position(s) / ${pending.size} pending order(s). Close manually.`);
  if (t >= mins(EOD_TIMES.flat)) return flat ? st('FLAT', true, false, 'Portfolio flat for the close.') : st('FLAT REQUIRED', true, true, `Portfolio must be FLAT by 16:00 — ${open.size} open / ${pending.size} pending. Exit manually now.`);
  if (t >= mins(EOD_TIMES.exit) && !flat) return st('EOD EXIT REQUIRED', true, true, `EOD EXIT REQUIRED — close ${open.size} open position(s)${pending.size ? ` and cancel ${pending.size} pending order(s)` : ''} manually.`);
  if (t >= mins(EOD_TIMES.cancel) && pending.size) return st('EOD CANCEL REQUIRED', true, true, `EOD CANCEL REQUIRED — cancel ${pending.size} unfilled order(s) manually.`);
  return st('NO NEW ENTRIES', true, false, `No new entries after ${EOD_TIMES.noNewEntries} ET.`);
}

/* ───────────────────────── per-alert lifecycle ───────────────────────── */

/** NOT ELIGIBLE reasons that are caused by the passage of time / price after the alert (the setup itself was valid). */
const TIME_DRIVEN = ['STALE — DO NOT TRADE', 'DO NOT CHASE'];
const TICKET_DECISIONS = ['TRADE NOW — ELITE', 'HIGH PRIORITY — TRADE CONSIDERATION'];

/**
 * CR-05 / never-eligible — why an alert was NEVER actionable, from the alert-time snapshot first (what RB decided at
 * alert time), else the current decision. Null = it was a valid setup, so it may expire.
 *   • NOT ELIGIBLE for a non-time reason (after regular session, entry window, duplicate, hard rule …)
 *   • below the score threshold (SKIP)
 *   • data never trustworthy within the window (DATA REVIEW / DATA ERROR)
 *   • v1.2: TrendSpider not qualified (missing / unknown / retired / conflicting rule_set) and no ticket at alert time
 */
export function neverEligible(row: QueueRow, snap: AlertTimeSnapshot | null): { state: ExecutionState; reason: string } | null {
  const d = row.decision;
  const strip = (x: string) => x.replace(/^NOT ELIGIBLE — /, '');
  const atAlert = snap ? { decision: snap.v11.decision, detail: snap.v11.detail } : null;
  for (const x of [atAlert, { decision: d.decision, detail: d.detail }]) {
    if (!x) continue;
    if (x.decision === 'NOT ELIGIBLE' && !TIME_DRIVEN.includes(x.detail) && !closedAfterAlert(row, x.detail)) return { state: 'NOT ELIGIBLE', reason: `NOT ELIGIBLE — ${strip(x.detail)} (never actionable)` };
    if (x.decision === 'SKIP') return { state: 'BELOW THRESHOLD', reason: `${x.detail} (never actionable)` };
  }
  if (row.record.status === 'DATA_ERROR' || (atAlert?.decision ?? d.decision) === 'DATA REVIEW REQUIRED' && d.decision === 'DATA REVIEW REQUIRED') {
    return { state: 'DATA REVIEW', reason: `Never actionable — ${atAlert?.detail ?? d.detail} (unresolved within the alert window)` };
  }
  const q = (row.record as AutoAlertRecordV12).v12?.qualification;
  const ticketAtAlert = atAlert ? TICKET_DECISIONS.includes(atAlert.decision) : false;
  if (q && q.status !== 'QUALIFIED' && !ticketAtAlert && !d.ticket) return { state: 'NOT ELIGIBLE', reason: `NOT ELIGIBLE — TrendSpider not qualified: rule_set ${q.ruleSet.status} (never actionable)` };
  return null;
}

export function deriveLifecycle(row: QueueRow, snap: AlertTimeSnapshot | null, now: number, eod: EodStatus): Lifecycle {
  const d = row.decision;
  const st = row.candidate?.status;
  const action = row.live?.action ?? null;
  const gates = gateSequence(row);
  // Alert-time values: the frozen snapshot, else the frozen v1.1 initial score, else (first scoring pass only) the
  // ranking row the initial score is being frozen from.
  const first = !row.candidate?.initialScore && row.ranked?.strategyEligible && row.ranked.total !== null ? row.ranked : null;
  const frozen = snap ? snap.v11.total : row.candidate?.initialScore?.total ?? first?.total ?? null;
  const alertTimeTier = snap ? snap.v11.tier : row.candidate?.initialScore?.tier ?? first?.tier ?? null;
  const expiresAt = snap?.expiresAtMs ?? row.record.alert.alertTimeMs + RB_V1_DEFAULTS.alertWindowMinutes * 60_000;
  const liveScore: ScoreDisplay = row.ranked?.total !== null && row.ranked?.total !== undefined && row.ranked.strategyEligible
    ? { value: row.ranked.total, basis: 'LIVE', rank: row.ranked.rank ?? 'NOT RANKED' }
    : frozen !== null ? { value: frozen, basis: 'FROZEN — REFERENCE ONLY', rank: 'NOT RANKED' } : { value: null, basis: 'NONE', rank: 'NOT RANKED' };
  const frozenScore: ScoreDisplay = frozen !== null ? { value: frozen, basis: 'FROZEN — REFERENCE ONLY', rank: 'NOT RANKED' } : { value: null, basis: 'NONE', rank: 'NOT RANKED' };
  const L = (executionState: ExecutionState, finalActionability: FinalActionability, reason: string, terminal = false, score = liveScore): Lifecycle =>
    ({ alertTimeTier, executionState, finalActionability, reason, terminal, entryWindowClosed: false, gates, score, eod });

  // User-controlled lifecycle always wins: an order or position is governed by the broker, not by the alert clock.
  if (st === 'PENDING') return L('SUBMITTED', 'NO TICKET', 'Order marked submitted — manage it at the broker.', false, frozenScore);
  if (st === 'FILLED') return L('IN POSITION', 'NO TICKET', 'Position open — governed by its stop and target.', false, frozenScore);
  if (st && CLOSED.includes(st)) return L('CLOSED', 'NO TRADE', st.replace(/_/g, ' '), true, frozenScore);

  // CR-05 — terminal staleness: no revival, no READY, no rescoring after the alert window. Only an alert that was a
  // valid setup can expire; one that was never eligible keeps the reason it was never actionable (time never
  // rewrites "NOT ELIGIBLE — AFTER REGULAR SESSION" into "EXPIRED — STALE").
  if (now >= expiresAt) {
    const ne = neverEligible(row, snap);
    if (ne) return L(ne.state, 'NO TRADE', ne.reason, true, frozenScore);
    return L('EXPIRED — STALE', 'NO TRADE', `EXPIRED — STALE: no trigger within ${RB_V1_DEFAULTS.alertWindowMinutes} minutes of the alert. Terminal.`, true, frozenScore);
  }

  if (d.decision === 'SCORING') return L('SCORING', 'NO TICKET', d.detail);
  if (d.section === 'DATA_REVIEW') return L('DATA REVIEW', 'NO TICKET', d.detail);
  if (action === 'SKIP_CHASED' || d.detail === 'DO NOT CHASE') return L('CHASED', 'NO TRADE', 'Price moved beyond the 0.25 ATR chase limit — do not chase.', true, frozenScore);
  // CR-07 — a crossed-but-late setup is a review state, never WATCHLIST.
  if (action === 'MARKET_LATE_ENTRY') return L('LATE — REVIEW', 'NO TICKET', 'Trigger crossed (≤ 0.25 ATR) — no automatic ticket; manual review only.', false, frozenScore);
  // CR-13 — the 15:30 cutoff reached after a valid alert: RB v1.1 has withdrawn the ticket; say so unambiguously.
  if (d.decision === 'NOT ELIGIBLE' && closedAfterAlert(row, d.detail)) return { ...L('ENTRY WINDOW CLOSED', 'NO TICKET', ENTRY_WINDOW_CLOSED, true, frozenScore), entryWindowClosed: true };
  if (d.decision === 'NOT ELIGIBLE') return L('NOT ELIGIBLE', 'NO TRADE', d.detail, true, frozenScore);
  if (d.decision === 'SKIP') return L('BELOW THRESHOLD', 'NO TRADE', d.detail, true);
  if (d.ticket) {
    if (eod.noNewEntries) return { ...L('ACTIVE', 'NO TICKET', ENTRY_WINDOW_CLOSED), entryWindowClosed: true };
    return L('ACTIVE', 'READY', d.detail);
  }
  if (gates.portfolio.startsWith('BLOCKED') || gates.capital.startsWith('BLOCKED')) return L('PORTFOLIO BLOCKED', 'NO TICKET', gates.portfolio.startsWith('BLOCKED') ? gates.portfolio : gates.capital);
  return L(action === 'BUY_STOP' || action === 'SELL_STOP' ? 'NOT CROSSED' : 'NOT ELIGIBLE', 'NO TICKET', d.detail);
}
