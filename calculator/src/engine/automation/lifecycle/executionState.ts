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
import type { TerminalEvent } from './terminalEvents';
import { PORTFOLIO_UNVERIFIED } from './portfolioExposure';

export type ExecutionState =
  | 'SCORING'
  | 'NOT CROSSED'
  | 'ACTIVE'
  | 'LATE — REVIEW'
  | 'CHASED'
  | 'EXPIRED — STALE'
  | 'SETUP FAILED'
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
  /** The RB v1.1 ticket is withheld because broker sync is enabled and the portfolio is not verified (flag only). */
  portfolioUnverified: boolean;
  /** Portfolio verification gate in force for this evaluation (null = none); also applies to v1.2 shadow actionability. */
  portfolioGate: string | null;
  /** Terminal SETUP FAILED latched from an observed stop breach (null = none). Any RB v1.1 ticket is withheld. */
  setupFailed: { observedAtMs: number; price: number; stop: number } | null;
  /** S2a — terminal chase recorded from a reliable observation (evidence; null/absent = none). */
  chaseLatched?: { observedAtMs: number; price: number; entry: number | null; distanceAtr: number | null; thresholdAtr: number | null; quoteTradeIso: string } | null;
  /** Frozen alert-time v1.2 score and tiers from the snapshot (null = no snapshot yet; total null = genuinely unscored). */
  frozenV12: { total: number | null; max: number; tierOptionA: string | null; tierOptionB: string | null } | null;
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

/** NOT ELIGIBLE reasons caused by time / price AFTER the alert (the setup itself was valid): stale, chased, and a
 *  later stop breach (SETUP FAILED). An alert that failed this way was not "never eligible". */
const TIME_DRIVEN = ['STALE — DO NOT TRADE', 'DO NOT CHASE', 'NOT ELIGIBLE — SETUP FAILED'];
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

/**
 * S2a — the lifecycle with the terminal chase applied. The pre-S2a derivation below is unchanged; this wrapper only
 *   • records the chase as evidence on every lifecycle of the alert (`chaseLatched`);
 *   • keeps broker / user states (SUBMITTED, IN POSITION, CLOSED) exactly as they are — the broker governs those;
 *   • keeps an earlier SETUP FAILED as the terminal reason (the first supported terminal event wins the display);
 *   • otherwise, whenever the active decision carries a ticket (a revival after the chase), withholds it: CHASED · NO TRADE.
 * Without a live ticket the existing labels are kept, so nothing changes for alerts that could not be traded anyway.
 */
export function deriveLifecycle(row: QueueRow, snap: AlertTimeSnapshot | null, now: number, eod: EodStatus, terminal: TerminalEvent | null = null, portfolioGate: string | null = null, chase: TerminalEvent | null = null): Lifecycle {
  const lc = deriveLifecycleBase(row, snap, now, eod, terminal, portfolioGate);
  if (chase?.kind !== 'CHASED') return lc;
  const chaseLatched = { observedAtMs: chase.observedAtMs, price: chase.price, entry: chase.entry ?? null, distanceAtr: chase.distanceAtr ?? null, thresholdAtr: chase.thresholdAtr ?? null, quoteTradeIso: chase.quoteTradeIso };
  if (['SUBMITTED', 'IN POSITION', 'CLOSED'].includes(lc.executionState)) return { ...lc, chaseLatched };
  if (lc.setupFailed && lc.setupFailed.observedAtMs <= chase.observedAtMs) return { ...lc, chaseLatched };
  if (!row.decision.ticket && !lc.setupFailed) return { ...lc, chaseLatched };
  const frozen = snap ? snap.v11.total : row.candidate?.initialScore?.total ?? null;
  const dist = chase.distanceAtr !== undefined ? ` (${chase.distanceAtr.toFixed(2)} ATR, limit ${chase.thresholdAtr ?? RB_V1_DEFAULTS.chaseThresholdAtr} ATR)` : '';
  return {
    ...lc,
    executionState: 'CHASED', finalActionability: 'NO TRADE', terminal: true, entryWindowClosed: false, portfolioUnverified: false, chaseLatched,
    reason: `CHASED — price ${chase.price} was beyond the ${chase.entry ?? '—'} entry${dist} at ${etParts(chase.observedAtMs).hhmmss} ET. Terminal: no new entry from this alert; a new TrendSpider alert is required.`,
    score: frozen !== null ? { value: frozen, basis: 'FROZEN — REFERENCE ONLY', rank: 'NOT RANKED' } : { value: null, basis: 'NONE', rank: 'NOT RANKED' },
  };
}

function deriveLifecycleBase(row: QueueRow, snap: AlertTimeSnapshot | null, now: number, eod: EodStatus, terminal: TerminalEvent | null = null, portfolioGate: string | null = null): Lifecycle {
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
  const frozenV12 = snap?.v12 ? { total: snap.v12.total, max: snap.v12.max, tierOptionA: snap.v12.tierOptionA, tierOptionB: snap.v12.tierOptionB } : null;
  const liveScore: ScoreDisplay = row.ranked?.total !== null && row.ranked?.total !== undefined && row.ranked.strategyEligible
    ? { value: row.ranked.total, basis: 'LIVE', rank: row.ranked.rank ?? 'NOT RANKED' }
    : frozen !== null ? { value: frozen, basis: 'FROZEN — REFERENCE ONLY', rank: 'NOT RANKED' } : { value: null, basis: 'NONE', rank: 'NOT RANKED' };
  const frozenScore: ScoreDisplay = frozen !== null ? { value: frozen, basis: 'FROZEN — REFERENCE ONLY', rank: 'NOT RANKED' } : { value: null, basis: 'NONE', rank: 'NOT RANKED' };
  const L = (executionState: ExecutionState, finalActionability: FinalActionability, reason: string, terminal = false, score = liveScore): Lifecycle =>
    ({ alertTimeTier, executionState, finalActionability, reason, terminal, entryWindowClosed: false, portfolioUnverified: false, portfolioGate, setupFailed: null, frozenV12, gates, score, eod });

  // User-controlled lifecycle always wins: an order or position is governed by the broker, not by the alert clock.
  if (st === 'PENDING') return L('SUBMITTED', 'NO TICKET', 'Order marked submitted — manage it at the broker.', false, frozenScore);
  if (st === 'FILLED') return L('IN POSITION', 'NO TICKET', 'Position open — governed by its stop and target.', false, frozenScore);
  if (st && CLOSED.includes(st)) return L('CLOSED', 'NO TRADE', st.replace(/_/g, ' '), true, frozenScore);

  // Terminal SETUP FAILED: an observed breach of the planned stop ends this alert for good (no revival when price
  // recovers, no ticket). A fresh setup needs a new authenticated TrendSpider alert.
  if (terminal?.kind === 'SETUP_FAILED') {
    const at = etParts(terminal.observedAtMs).hhmmss;
    return {
      ...L('SETUP FAILED', 'NO TRADE', `SETUP FAILED — price ${terminal.price} breached the planned stop ${terminal.stop} at ${at} ET. Terminal: no revival; a new TrendSpider alert is required.`, true, frozenScore),
      setupFailed: { observedAtMs: terminal.observedAtMs, price: terminal.price, stop: terminal.stop },
    };
  }

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
    // Broker sync enabled but the portfolio is not verified: the capacity behind this ticket is unconfirmed → withheld.
    // Reached only by a still-valid, unsubmitted setup (terminal, expired, chased, late and user states returned above).
    if (portfolioGate) return { ...L('ACTIVE', 'NO TICKET', `${PORTFOLIO_UNVERIFIED} — ${portfolioGate}. The ticket returns only when fresh broker data verifies the portfolio.`), portfolioUnverified: true };
    return L('ACTIVE', 'READY', d.detail);
  }
  if (gates.portfolio.startsWith('BLOCKED') || gates.capital.startsWith('BLOCKED')) return L('PORTFOLIO BLOCKED', 'NO TICKET', gates.portfolio.startsWith('BLOCKED') ? gates.portfolio : gates.capital);
  return L(action === 'BUY_STOP' || action === 'SELL_STOP' ? 'NOT CROSSED' : 'NOT ELIGIBLE', 'NO TICKET', d.detail);
}

/* ───────────────────────── S2a — execution authorization contract ───────────────────────── */

/**
 * One authorization per alert that the Live Queue — the single execution authority — currently offers as an order to
 * place. It is bound to the exact alert (record id), to the plan it authorizes (side, entry, stop, target, quantity), to
 * the active logic version and to the instant of the evaluation. It is never persisted: it exists only for the current
 * evaluation and is rebuilt on every Queue pass.
 */
export interface ExecutionAuthorization {
  recordId: string;
  logicVersion: string;
  evaluatedAtMs: number;
  quoteTradeIso: string;
  plan: { direction: 'LONG' | 'SHORT'; entry: number; stop: number; target: number; shares: number };
}

const NEW_ENTRY = ['NEW', 'WATCHLIST'];

/** The Queue's own "order to place" predicate (the same flags its action cards and buttons use), plus the S2a chase. */
export function queueOffersOrder(r: QueueRow): boolean {
  const lc = r.lifecycle;
  return !!r.decision.ticket && !!lc && lc.finalActionability === 'READY' && !lc.entryWindowClosed && !lc.setupFailed && !lc.portfolioUnverified && !lc.chaseLatched;
}

export function executionAuthorizations(rows: QueueRow[], now: number): Record<string, ExecutionAuthorization> {
  const out: Record<string, ExecutionAuthorization> = {};
  for (const r of rows) {
    const c = r.candidate;
    if (!queueOffersOrder(r) || !c || !r.quote || !NEW_ENTRY.includes(c.status)) continue;
    const logicVersion = (r.decision.flags ?? []).find((f) => f.startsWith('LOGIC '))?.slice(6) ?? r.record.versions?.strategy ?? 'RB v1.1';
    out[r.record.id] = { recordId: r.record.id, logicVersion, evaluatedAtMs: now, quoteTradeIso: r.quote.tradeIso, plan: { direction: c.direction, entry: c.entry, stop: c.stop, target: c.target, shares: c.shares } };
  }
  return out;
}

/** Why an automated candidate may NOT be presented as a new entry right now (null = authorized). Fails closed. */
export function authorizationRefusal(c: Candidate, auth: Record<string, ExecutionAuthorization> | null, now: number, maxAgeMs: number): string | null {
  if (!auth) return 'NO CURRENT EXECUTION AUTHORIZATION — LIVE QUEUE NOT EVALUATED';
  if (!NEW_ENTRY.includes(c.status)) return 'NOT A NEW ENTRY';
  const a = auth[c.id];
  if (!a || a.recordId !== c.id) return 'NOT AUTHORIZED BY THE LIVE QUEUE';
  const age = now - a.evaluatedAtMs;
  if (!(age >= 0 && age <= maxAgeMs)) return 'EXECUTION AUTHORIZATION EXPIRED';
  const p = a.plan;
  if (p.direction !== c.direction || p.entry !== c.entry || p.stop !== c.stop || p.target !== c.target || p.shares !== c.shares) return 'AUTHORIZATION DOES NOT MATCH THIS CANDIDATE';
  return null;
}

