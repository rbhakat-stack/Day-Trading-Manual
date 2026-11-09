/**
 * Live Alert Queue PRESENTATION MODEL (display only). Every value here is read from a QueueRow the engine already
 * produced — the v1.1 ranking/decision, the v1.2 shadow decision, the shared calculator's live result and the
 * record's v1.2 audit. Nothing is scored, thresholded, allocated or re-decided here: the functions only choose which
 * existing value to show and which existing state a badge names.
 *
 * Strategy columns are driven by metadata (`queueLayout`), not by hard-coded version positions, so the same table can
 * show "RB v1.1 ACTIVE + RB v1.2 SHADOW" today, "RB v1.2 ACTIVE + RB v1.1 COMPARISON" after an approved promotion, and
 * "RB v1.2 ACTIVE" alone once v1.1 is retired. The layout follows ACTIVE_LOGIC_VERSION; it never changes it.
 */
import { PORTFOLIO_UNVERIFIED, UNPROTECTED_BROKER_POSITION, type PortfolioVerification } from '../../engine/automation/lifecycle/portfolioExposure';
import type { QueueRow } from '../../engine/automation/liveQueue';
import type { AutoAlertRecordV12 } from '../../engine/automation/v12/audit';
import type { PortfolioSnapshot } from '../../engine/ranker/portfolioAllocator';
import type { QualityTier } from '../../engine/ranker/opportunityTypes';
import type { HardFailCode } from '../../engine/rules';
import { DEFAULT_AUTOMATION, quoteAges } from '../../engine/automation/alertDecision';
import { fmtEt, mmss } from '../../engine/automation/etTime';
import { SNAPSHOT_FINALIZE_MS, type AlertTimeSnapshot } from '../../engine/automation/lifecycle/alertTimeSnapshot';
import { RB_V1_DEFAULTS } from '../../engine/settings';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'shadow' | 'elite' | 'muted';
export interface Status { label: string; tone: Tone; detail: string }

/* ───────────────────────── strategy columns (metadata-driven) ───────────────────────── */

export type StrategyRole = 'ACTIVE' | 'SHADOW' | 'COMPARISON';

export interface StrategyCell {
  score: number | null;
  /** One entry per tier column of the strategy (v1.1: Tier; v1.2: Option B, Option A). */
  tiers: (QualityTier | null)[];
  /** The strategy's decision text — only for the ACTIVE strategy, whose decision is the executable one. */
  decision: string | null;
  /** CR-06 — the score is the FROZEN alert-time score shown for reference after a hard fail / expiry (not ranked). */
  frozen?: boolean;
  /** Label under a frozen score (default "Frozen · not ranked"). */
  frozenLabel?: string;
  /** The current (live) re-evaluation when a frozen score is shown instead; never presented as the frozen value. */
  live?: number | null;
}

export interface StrategyColumn {
  version: string;
  role: StrategyRole;
  /** Header, e.g. "RB v1.1 (ACTIVE)". */
  title: string;
  scoreLabel: string;
  tierLabels: string[];
  cell: (row: QueueRow) => StrategyCell;
}

export interface LayoutContext {
  /** Raw v1.2 maximum (the score header shows "Score (91)"). */
  v12MaxScore: number;
}

interface Presenter {
  scoreLabel: (ctx: LayoutContext) => string;
  tierLabels: string[];
  cell: (row: QueueRow, role: StrategyRole) => StrategyCell;
}

/**
 * One presenter per logic version. Each reads only the engine output that carries that version's result:
 *   RB v1.1 → the Opportunity Ranker result (`row.ranked`: total, tier) and, when active, `row.decision`;
 *   RB v1.2 → the v1.2 score summary on `row.shadow` (raw total, Option B tier, Option A tier).
 */
const USER_LIFECYCLE = ['SUBMITTED', 'IN POSITION', 'CLOSED'];

const PRESENTERS: Record<string, Presenter> = {
  'RB v1.1': {
    scoreLabel: () => 'Score',
    tierLabels: ['Tier'],
    cell: (r, role) => {
      const sc = r.lifecycle?.score;
      // Submitted / filled / closed: the alert-time score is the one that led to the trade. It is shown frozen and
      // labelled; the live re-evaluation (portfolio fit and price-location points move) is kept separately.
      if (sc?.basis === 'FROZEN — REFERENCE ONLY' && sc.value !== null && USER_LIFECYCLE.includes(r.lifecycle.executionState) && (r.ranked?.total ?? null) !== null) {
        return { score: sc.value, tiers: [(r.lifecycle.alertTimeTier as QualityTier | null) ?? null], decision: role === 'ACTIVE' ? r.decision.decision : null, frozen: true, frozenLabel: 'Alert-time · frozen', live: r.ranked?.total ?? null };
      }
      // Blocked as DUPLICATE: the alert's own diagnostic score (scored alone, never ranked) — NOT ACTIONABLE.
      if (r.blocked) {
        return { score: r.blocked.score ?? sc?.value ?? null, tiers: [r.blocked.tier ?? ((r.lifecycle?.alertTimeTier as QualityTier | null) ?? null)], decision: role === 'ACTIVE' ? r.decision.decision : null, frozen: true, frozenLabel: 'NOT ACTIONABLE · diagnostic' };
      }
      if (sc?.basis === 'FROZEN — REFERENCE ONLY' && (r.ranked?.total ?? null) === null) {
        return { score: sc.value, tiers: [(r.lifecycle.alertTimeTier as QualityTier | null) ?? null], decision: role === 'ACTIVE' ? r.decision.decision : null, frozen: true };
      }
      return { score: r.ranked?.total ?? null, tiers: [r.ranked?.tier ?? null], decision: role === 'ACTIVE' ? r.decision.decision : null };
    },
  },
  'RB v1.2': {
    scoreLabel: (ctx) => `Score (${ctx.v12MaxScore})`,
    tierLabels: ['Option B', 'Option A'],
    // The v1.2 score shown is the FROZEN alert-time score and tiers (snapshot); it never changes during the alert's
    // lifecycle. Before the snapshot is frozen (first pass) the alert-time evaluation itself is shown. A snapshot
    // without a v1.2 score shows unavailable — never a later live score. "Frozen · not ranked" when the alert is no
    // longer scored / terminally failed, so the frozen value is never mistaken for a current recommendation.
    cell: (r, role) => {
      const f = r.lifecycle?.frozenV12;
      const decision = role === 'ACTIVE' ? r.decision.decision : null;
      if (f) {
        const notRanked = !!r.lifecycle.setupFailed || r.lifecycle.terminal || (r.shadow?.score?.total ?? null) === null;
        return { score: f.total, tiers: [(f.tierOptionB as QualityTier | null) ?? null, (f.tierOptionA as QualityTier | null) ?? null], decision, frozen: f.total !== null && notRanked };
      }
      return { score: r.shadow?.score?.total ?? null, tiers: [r.shadow?.score?.tierOptionB ?? null, r.shadow?.score?.tierOptionA ?? null], decision };
    },
  },
};

export interface PresentationConfig {
  /** The active logic version (pass ACTIVE_LOGIC_VERSION). */
  activeVersion: string;
  /** Versions with a presenter, in display order after the active one. */
  versions?: string[];
  /** Non-active versions shown as SHADOW (under evaluation); any other non-active version is a COMPARISON column. */
  shadow?: string[];
  /** Versions to leave out entirely (e.g. a retired v1.1). */
  hidden?: string[];
}

/** Default presentation for an active version: today RB v1.1 ACTIVE + RB v1.2 SHADOW. */
export function presentationFor(activeVersion: string): PresentationConfig {
  return activeVersion === 'RB v1.1' ? { activeVersion, versions: ['RB v1.2'], shadow: ['RB v1.2'] } : { activeVersion, versions: Object.keys(PRESENTERS).filter((v) => v !== activeVersion) };
}

export function queueLayout(cfg: PresentationConfig, ctx: LayoutContext): StrategyColumn[] {
  const order = [cfg.activeVersion, ...(cfg.versions ?? Object.keys(PRESENTERS)).filter((v) => v !== cfg.activeVersion)];
  return order
    .filter((v) => PRESENTERS[v] && !(cfg.hidden ?? []).includes(v))
    .map((version) => {
      const p = PRESENTERS[version];
      const role: StrategyRole = version === cfg.activeVersion ? 'ACTIVE' : (cfg.shadow ?? []).includes(version) ? 'SHADOW' : 'COMPARISON';
      return { version, role, title: `${version} (${role})`, scoreLabel: p.scoreLabel(ctx), tierLabels: p.tierLabels, cell: (r: QueueRow) => p.cell(r, role) };
    });
}

export const ROLE_NOTE: Record<StrategyRole, string> = {
  ACTIVE: 'executable decision — tickets and actions come from this version only',
  SHADOW: 'comparison only, not used for execution',
  COMPARISON: 'previous logic, comparison only, not used for execution',
};

/* ───────────────────────── tiers & labels ───────────────────────── */

export const TIER_SHORT: Record<QualityTier, string> = { ELITE: 'ELITE', HIGH_PRIORITY: 'HIGH', WATCHLIST: 'WATCHLIST', LOW_PRIORITY: 'LOW', SKIP: 'SKIP' };
export const TIER_TONE: Record<QualityTier, Tone> = { ELITE: 'elite', HIGH_PRIORITY: 'ok', WATCHLIST: 'info', LOW_PRIORITY: 'muted', SKIP: 'muted' };
/** Colour of a score number, by the tier the ranker already assigned. */
export const scoreTone = (t: QualityTier): Tone => (t === 'ELITE' ? 'elite' : t === 'HIGH_PRIORITY' ? 'ok' : t === 'WATCHLIST' ? 'warn' : 'bad');

/* ───────────────────────── row statuses (existing states only) ───────────────────────── */

const v12 = (r: QueueRow) => (r.record as AutoAlertRecordV12).v12;

/** TS Qualified = trusted rule set recognised and direction matched (the v1.2 audit's qualification). */
export function qualificationStatus(r: QueueRow): Status {
  const q = v12(r)?.qualification;
  if (!q) return { label: '—', tone: 'muted', detail: 'No v1.2 audit on this record.' };
  if (q.status === 'QUALIFIED') return { label: 'QUALIFIED', tone: 'ok', detail: q.reason };
  return { label: 'NOT QUALIFIED', tone: q.ruleSet.status === 'CONFLICT' ? 'bad' : 'muted', detail: q.reason };
}

export function ruleSetText(r: QueueRow): { id: string; status: string } {
  const rs = v12(r)?.qualification.ruleSet;
  return rs ? { id: rs.ruleSet ?? 'none', status: rs.status } : { id: '—', status: '' };
}

/** Existing integrity/data state: record status, snapshot issues, and the decision's DATA REVIEW section. */
export function dataStatus(r: QueueRow): Status {
  const rec = r.record;
  if (rec.status === 'DATA_ERROR') return { label: 'DATA ERROR', tone: 'bad', detail: rec.errors.join(' · ') || 'Market data fetch failed.' };
  if (rec.status === 'RECEIVED' || rec.status === 'ENRICHING') return { label: 'PENDING', tone: 'muted', detail: 'Waiting for market data.' };
  const issues = rec.snapshot?.issues ?? [];
  if (issues.some((i) => i.kind === 'REVIEW')) return { label: 'REVIEW', tone: 'warn', detail: issues.map((i) => i.code).join(', ') };
  if (issues.length) return { label: 'INCOMPLETE', tone: 'warn', detail: issues.map((i) => i.code).join(', ') };
  if (r.decision.section === 'DATA_REVIEW') return { label: 'REVIEW', tone: 'warn', detail: r.decision.detail };
  return { label: 'PASS', tone: 'ok', detail: 'Snapshot complete; no integrity issue.' };
}

/** Existing chase state from the shared calculator (action / hard fail / ChaseInfo). */
export function chaseStatus(r: QueueRow): Status {
  const l = r.live;
  if (!l?.chase) return { label: '—', tone: 'muted', detail: 'No live trade plan.' };
  const c = l.chase;
  const dist = `${c.distance >= 0 ? '+' : ''}${c.distance.toFixed(2)} (${c.distanceAtr.toFixed(2)} ATR)`;
  if (l.action === 'SKIP_CHASED' || l.hardFails.some((f) => f.code === 'CHASED_SETUP')) return { label: 'CHASED', tone: 'bad', detail: `${dist} beyond the trigger; limit ${c.thresholdAtr} ATR` };
  if (l.action === 'MARKET_LATE_ENTRY') return { label: 'LATE — REVIEW', tone: 'warn', detail: `${dist} past the trigger, within the ${c.thresholdAtr} ATR limit` };
  return { label: 'PASS', tone: 'ok', detail: c.crossed ? `${dist} past the trigger` : `trigger not crossed · ${dist}` };
}

const PORTFOLIO_FAILS: HardFailCode[] = ['NO_POSITION_SLOT', 'CAPITAL_LIMIT', 'PORTFOLIO_HEAT_LIMIT', 'CORRELATION_LIMIT'];

/** Existing allocator result: portfolio hard fails, then the allocation outcome. */
export function portfolioStatus(r: QueueRow): Status {
  const k = r.ranked;
  if (!k) return { label: '—', tone: 'muted', detail: 'Not ranked.' };
  // CR-10 — a failed score gate with no portfolio hard fail: the portfolio is not evaluated.
  if (r.lifecycle?.gates.portfolio === 'NOT EVALUATED — NOT REQUIRED' && r.lifecycle.gates.score === 'FAIL') return { label: 'NOT EVALUATED', tone: 'muted', detail: 'Score gate failed — portfolio check not required; capital not attempted.' };
  const fails = [...new Set(k.hardFails.filter((f) => PORTFOLIO_FAILS.includes(f.code)).map((f) => f.code))];
  if (fails.length) return { label: 'BLOCKED', tone: 'bad', detail: fails.join(', ') };
  // A row held for data review is ranked for display only (rank null); its allocation is not a real one.
  if (k.rank === null) return { label: 'N/A', tone: 'muted', detail: 'Not allocated (not eligible, not scored or held for data review).' };
  if (k.allocation?.allocated) return { label: 'OK', tone: 'ok', detail: `Allocated · rank #${k.rank}` };
  if (k.allocation) return { label: 'NOT ALLOCATED', tone: 'warn', detail: `${k.allocation.reason}${k.allocation.correlatedWith.length ? ` (${k.allocation.correlatedWith.join(', ')})` : ''}` };
  return { label: 'N/A', tone: 'muted', detail: 'Not allocated (not eligible, not scored or held for data review).' };
}

/** The active decision as it stands: its FinalDecision text, and whether it carries a ticket. */
export function finalState(r: QueueRow): Status & { ticket: boolean } {
  const d = r.decision;
  const ticket = !!d.ticket;
  const tone: Tone = ticket ? 'ok' : d.decision === 'DATA REVIEW REQUIRED' ? 'warn' : d.decision === 'NOT ELIGIBLE' ? 'bad' : ['ORDER SUBMITTED', 'IN POSITION'].includes(d.decision) ? 'info' : 'muted';
  return { label: d.decision, tone, detail: d.detail, ticket };
}

/** Data Review filter: any non-PASS data state (the same states the Data badge names). */
export const isDataReview = (r: QueueRow) => !['PASS', 'PENDING'].includes(dataStatus(r).label);

/**
 * Compact label for the active decision (the full FinalDecision text stays in the tooltip and the expanded row).
 * TRADE READY = the active decision carries a ticket; CHASED = NOT ELIGIBLE because the calculator reported a chase.
 */
export function decisionBadge(r: QueueRow): Status {
  const d = r.decision;
  // Terminal SETUP FAILED: any v1.1 ticket is withheld (the v1.1 decision itself is unchanged).
  if (d.ticket && r.lifecycle?.setupFailed) return { label: 'v1.1 TICKET — SETUP FAILED', tone: 'bad', detail: r.lifecycle.reason };
  if (d.ticket && r.lifecycle?.chaseLatched) return { label: 'v1.1 TICKET — CHASED', tone: 'bad', detail: r.lifecycle.reason }; // S2a terminal chase
  if (d.ticket && r.lifecycle?.triggerMissed) return { label: 'v1.1 TICKET — MISSED', tone: 'bad', detail: r.lifecycle.reason }; // D terminal missed trigger
  if (d.ticket && r.lifecycle?.heldBy) return { label: 'HELD — TICKER RESERVED', tone: 'warn', detail: r.lifecycle.reason }; // D4 one actionable alert per ticker
  if (d.ticket && r.lifecycle?.observationWithheld) return { label: 'DATA REVIEW', tone: 'warn', detail: r.lifecycle.reason }; // S2a.2 continuity / clock
  // CR-13 — after the 15:30 cutoff the v1.1 ticket is historical: never labelled as ready to trade.
  if (d.ticket && r.lifecycle?.entryWindowClosed) return { label: 'v1.1 TICKET — AFTER CUTOFF', tone: 'bad', detail: r.lifecycle.reason };
  if (d.ticket && r.lifecycle?.portfolioUnverified) return { label: 'v1.1 TICKET — PORTFOLIO UNVERIFIED', tone: 'bad', detail: r.lifecycle.reason };
  if (d.ticket) return { label: 'TRADE READY', tone: 'ok', detail: d.decision };
  // CR-05 / CR-07 — a late or expired setup is named by its execution state, never WATCHLIST.
  const ex = r.lifecycle?.executionState;
  if (ex === 'EXPIRED — STALE') return { label: 'EXPIRED — STALE', tone: 'bad', detail: r.lifecycle.reason };
  if (ex === 'LATE — REVIEW') return { label: 'LATE — REVIEW', tone: 'warn', detail: r.lifecycle.reason };
  switch (d.decision) {
    case 'DATA REVIEW REQUIRED': return { label: 'DATA REVIEW', tone: 'warn', detail: d.detail };
    case 'NOT ELIGIBLE': return chaseStatus(r).label === 'CHASED' ? { label: 'CHASED', tone: 'bad', detail: d.detail } : { label: 'NOT ELIGIBLE', tone: 'bad', detail: d.detail };
    case 'TRADE NOW — ELITE': return { label: 'TRADE NOW', tone: 'ok', detail: d.detail };
    case 'HIGH PRIORITY — TRADE CONSIDERATION': return { label: 'HIGH PRIORITY', tone: 'info', detail: d.detail };
    case 'WATCHLIST': return { label: 'WATCHLIST', tone: 'info', detail: d.detail };
    case 'ORDER SUBMITTED': return { label: 'SUBMITTED', tone: 'info', detail: d.detail };
    case 'IN POSITION': return { label: 'IN POSITION', tone: 'info', detail: d.detail };
    default: return { label: d.decision, tone: 'muted', detail: d.detail };
  }
}

/** Final State column: READY (ticket), NO TRADE (hard-rule NOT ELIGIBLE), the lifecycle state once submitted, else NO TICKET. */
export function finalBadge(r: QueueRow): Status {
  const d = r.decision;
  const lc = r.lifecycle;
  // CR-13 — after 15:30 ET the execution layer withholds READY (flag only; the v1.1 ticket itself is unchanged).
  if (lc?.setupFailed) return { label: 'NO TRADE — SETUP FAILED', tone: 'bad', detail: lc.reason };
  if (d.ticket && lc?.chaseLatched) return { label: 'NO TRADE', tone: 'bad', detail: lc.reason }; // S2a terminal chase
  if (d.ticket && lc?.triggerMissed && lc.finalActionability !== 'READY') return { label: 'NO TRADE', tone: 'bad', detail: lc.reason }; // D terminal missed trigger
  if (d.ticket && lc?.heldBy) return { label: 'NO TICKET — HELD', tone: 'warn', detail: lc.reason }; // D4 ticker reserved by another alert
  if (d.ticket && lc?.observationWithheld) return { label: 'NO TICKET', tone: 'warn', detail: lc.reason }; // S2a.2 continuity / clock
  if (lc?.entryWindowClosed) return { label: 'NO TICKET — ENTRY WINDOW CLOSED', tone: 'bad', detail: lc.reason };
  if (lc?.portfolioUnverified) return { label: lc.reason.startsWith(UNPROTECTED_BROKER_POSITION) ? UNPROTECTED_BROKER_POSITION : PORTFOLIO_UNVERIFIED, tone: 'bad', detail: lc.reason };
  if (d.ticket && lc && lc.finalActionability !== 'READY') return { label: lc.finalActionability, tone: 'warn', detail: lc.reason };
  if (d.ticket) return { label: 'READY', tone: 'ok', detail: d.detail };
  if (lc?.terminal && !['CLOSED'].includes(lc.executionState)) return { label: 'NO TRADE', tone: 'bad', detail: lc.reason };
  if (d.decision === 'NOT ELIGIBLE') return { label: 'NO TRADE', tone: 'bad', detail: d.detail };
  if (d.decision === 'ORDER SUBMITTED' || d.decision === 'IN POSITION') return { label: d.decision === 'IN POSITION' ? 'IN POSITION' : 'SUBMITTED', tone: 'info', detail: d.detail };
  if (d.decision === 'CLOSED') return { label: 'CLOSED', tone: 'muted', detail: d.detail };
  return { label: 'NO TICKET', tone: 'muted', detail: d.detail };
}

const EXEC_TONE: Record<string, Tone> = {
  ACTIVE: 'ok', 'ENTRY WINDOW CLOSED': 'bad', 'SETUP FAILED': 'bad', 'NOT CROSSED': 'info', SCORING: 'muted', 'LATE — REVIEW': 'warn', CHASED: 'bad', 'EXPIRED — STALE': 'bad', 'PORTFOLIO BLOCKED': 'warn',
  'MISSED — TRIGGER CROSSED': 'bad', 'HELD — TICKER RESERVED': 'warn',
  'BELOW THRESHOLD': 'muted', 'NOT ELIGIBLE': 'bad', 'DATA REVIEW': 'warn', SUBMITTED: 'info', 'IN POSITION': 'info', CLOSED: 'muted',
};

/** CR-07 — Current Execution State (separate from the alert-time tier and from Final Actionability). */
export function executionBadge(r: QueueRow): Status {
  const lc = r.lifecycle;
  if (!lc) return { label: '—', tone: 'muted', detail: '' };
  return { label: lc.executionState, tone: EXEC_TONE[lc.executionState] ?? 'muted', detail: lc.reason };
}

/** CR-10 — gate sequence text, e.g. "Score PASS → Portfolio BLOCKED — NO_POSITION_SLOT → Capital NOT ATTEMPTED". */
export function gateText(r: QueueRow): string {
  const g = r.lifecycle?.gates;
  return g ? `Score ${g.score} → Portfolio ${g.portfolio} → Capital ${g.capital}` : '—';
}

/** Portfolio header from the allocator's snapshot. One ranking shares one snapshot; returns null when none exists yet. */
/** Portfolio summary card values. Every total is read from the COMPLETE portfolio snapshot (never recomputed here). */
export interface PortfolioSummaryView {
  pf: PortfolioSnapshot;
  /** Display arithmetic only: maxPositions − slotsUsed, never below 0. */
  slotsRemaining: number;
  atSlotLimit: boolean;
  atHeatLimit: boolean;
  /** Whether the broker side of these totals is confirmed (from the existing portfolio verification state). */
  capacity: 'VERIFIED' | 'UNVERIFIED' | 'BROKER_SYNC_OFF' | 'UNKNOWN';
  /** Shown whenever the totals are not broker-verified: available capacity may be overstated. */
  capacityNote: string | null;
}

/**
 * Portfolio summary from the complete reconciled portfolio of the evaluation (`QueueOutput.portfolio`) — independent of
 * which alert row is listed first, of sorting and of filters. Rows' own `ranked.portfolio` snapshots exclude that row's
 * candidate (fit evaluation) and must never be used here.
 */
export function portfolioSummary(
  pf: PortfolioSnapshot | null | undefined,
  verification?: Pick<PortfolioVerification, 'state' | 'verified' | 'keptFromSnapshot'> | null,
): PortfolioSummaryView | null {
  if (!pf) return null;
  const capacity: PortfolioSummaryView['capacity'] = !verification ? 'UNKNOWN' : verification.verified ? 'VERIFIED' : verification.state === 'OFF' ? 'BROKER_SYNC_OFF' : 'UNVERIFIED';
  const capacityNote = capacity === 'BROKER_SYNC_OFF'
    ? 'Broker sync off — totals from RB records and manual positions only; broker exposure is not independently verified, so available capacity may be overstated.'
    : capacity === 'UNVERIFIED'
      ? `Broker exposure unverified (${verification!.state.replace(/_/g, ' ').toLowerCase()}) — ${verification!.keptFromSnapshot ? 'previously verified broker exposure is still counted, but newer changes are not reflected' : 'no verified broker snapshot in this browser, so broker-only positions and orders may be missing'}; available capacity may be overstated.`
      : null;
  return {
    pf,
    slotsRemaining: Math.max(0, pf.maxPositions - pf.slotsUsed),
    atSlotLimit: pf.slotsUsed >= pf.maxPositions,
    atHeatLimit: pf.heatCommitted >= pf.heatLimit,
    capacity,
    capacityNote,
  };
}

/** Values for the four expanded panels (all read from the row). */
export function detailFields(r: QueueRow) {
  const rec = r.record as AutoAlertRecordV12;
  const a = rec.v12;
  const m = a?.signalMapping;
  const plan = r.live?.plan;
  const c = r.candidate;
  // Alert blocked as DUPLICATE: its NOT ACTIONABLE diagnostic plan (no candidate, no live plan).
  const bp = !c && !plan ? r.blocked?.plan ?? null : null;
  const ch = r.live?.chase ?? null;
  const pf = r.ranked?.portfolio ?? null;
  const parity = (r.shadow?.warnings ?? []).filter((w) => w.startsWith('PARITY'));
  const sip = a?.reconstruction?.sipRvol;
  return {
    alertTimeMs: rec.alert.alertTimeMs,
    timeSource: rec.alert.timeSource,
    receivedMs: rec.receivedMs,
    signalCandle: rec.snapshot?.signal?.label ?? null,
    mappedCandle: m?.label ?? null,
    lagSec: m?.lagSec ?? null,
    mappingStatus: m?.status ?? null,
    entry: c?.entry ?? plan?.entry ?? bp?.entry ?? null,
    stop: c?.stop ?? plan?.stop ?? bp?.stop ?? null,
    target: c?.target ?? plan?.target ?? bp?.target ?? null,
    shares: c?.shares ?? plan?.shares ?? bp?.shares ?? null,
    plannedRisk: c?.plannedRisk ?? plan?.maxLoss ?? bp?.plannedRisk ?? null,
    /** The plan's own order instruction (same object as entry / stop / target / shares; never inferred from the side). */
    orderType: c?.orderType ?? plan?.orderType ?? bp?.orderType ?? null,
    /** Where the plan values above come from: the candidate's frozen plan, or (no candidate) the live calculator plan. */
    planSource: c ? ('CANDIDATE' as const) : plan ? ('LIVE_PLAN' as const) : bp ? ('BLOCKED_DIAGNOSTIC' as const) : null,
    atr: rec.snapshot?.values?.atr ?? null,
    currentPrice: r.quote?.price ?? c?.currentPrice ?? null,
    chase: ch,
    sipRvol: sip !== null && sip !== undefined && Number.isFinite(sip) ? sip : null,
    hardFails: [...new Set((r.ranked?.hardFails ?? r.live?.hardFails ?? []).map((f) => f.code))],
    parity,
    issues: rec.snapshot?.issues ?? [],
    errors: rec.errors,
    portfolio: pf,
  };
}

/* ───────────────────────── Live vs. alert-time comparison (display only) ───────────────────────── */
//
// Everything below READS existing values. Nothing is scored, decided, authorized or reconstructed. Alert-time values
// come only from records that were genuinely written once at alert time:
//   • the server record (immutable once status = OK): calcAtAlert (alert-time Calculator result), snapshot.issues;
//   • this browser's write-once AlertTimeSnapshot (rbv1.v12.alertSnapshots.v1): v1.1 score / tier / decision.
// A value that was not written at alert time is NOT CAPTURED — never the current value, never recomputed.

/**
 * A client snapshot counts as alert-time only if it was written while the alert was being processed: the snapshot
 * freezes on the first complete pass and at the latest SNAPSHOT_FINALIZE_MS (60 s) after receipt while the app is
 * open; 15 s covers poll/refresh scheduling. A snapshot written later (the app was opened after the alert) holds a
 * later evaluation, so its values are shown as NOT CAPTURED. Display classification only — no trading rule.
 */
export const ALERT_CAPTURE_TOLERANCE_MS = SNAPSHOT_FINALIZE_MS + 15_000;

export interface AlertField {
  /** The recorded value (display text), or null = NOT CAPTURED. */
  value: string | null;
  /** Recorded numeric score (score field only). */
  num?: number | null;
  /** Recorded tier (tier field only). */
  tier?: QualityTier | null;
  /** Where the value comes from and when it was written (tooltip / provenance). */
  source: string;
  /** Epoch ms the value was written (null when not captured). */
  at: number | null;
}

export interface AlertTimeAssessment {
  /** The client snapshot is genuine for this alert (same alert ID, written at alert time). */
  snapshotOk: boolean;
  version: string;
  score: AlertField;
  tier: AlertField;
  decision: AlertField;
  executionState: AlertField;
  action: AlertField;
  dataStatus: AlertField;
  chaseStatus: AlertField;
  portfolioStatus: AlertField;
}

const notCaptured = (source: string): AlertField => ({ value: null, source, at: null });
const sinceReceipt = (ms: number, rec: QueueRow['record']) => {
  const s = Math.round((ms - rec.receivedMs) / 1000);
  return s < 120 ? `${s} s after receipt` : `${Math.round(s / 60)} min after receipt`;
};

export function alertTimeAssessment(r: QueueRow, snap: AlertTimeSnapshot | null | undefined, version: string): AlertTimeAssessment {
  const rec = r.record;
  const genuine = !!snap && snap.recordId === rec.id && snap.frozenAtMs - rec.receivedMs <= ALERT_CAPTURE_TOLERANCE_MS;
  const why = !snap
    ? 'no alert-time snapshot is recorded in this browser for this alert (it is written while the app is open at alert time).'
    : snap.recordId !== rec.id
      ? 'the stored snapshot belongs to a different alert ID.'
      : `this browser first wrote the snapshot at ${fmtEt(snap.frozenAtMs)}, ${sinceReceipt(snap.frozenAtMs, rec)} — the app was not open at alert time, so it holds a later evaluation, not the alert-time one.`;
  const v11 = version === 'RB v1.1';
  let score = notCaptured(`NOT CAPTURED — ${why}`);
  let tier = notCaptured(`NOT CAPTURED — ${why}`);
  let decision = notCaptured(`NOT CAPTURED — ${why}`);
  if (genuine && snap) {
    const src = `Write-once alert snapshot (${version}) for alert ${rec.id}, written ${fmtEt(snap.frozenAtMs)} (${sinceReceipt(snap.frozenAtMs, rec)})${snap.complete ? '' : ` · incomplete: ${snap.missing.join(', ')}`}`;
    const total = v11 ? snap.v11.total : snap.v12?.total ?? null;
    const t = (v11 ? snap.v11.tier : snap.v12?.tierOptionB ?? null) as QualityTier | null;
    const first = v11 && r.candidate?.initialScore && r.candidate.initialScore.total === total ? r.candidate.initialScore.at : null;
    score = { value: total === null ? 'NOT SCORED' : String(total), num: total, source: `${src}${first !== null ? ` · score first frozen ${fmtEt(first)}` : ''}${total === null ? ' · recorded as not scored' : ''}`, at: snap.frozenAtMs };
    tier = { value: t ? TIER_SHORT[t] : 'NOT SCORED', tier: t, source: src, at: snap.frozenAtMs };
    const d = v11 ? snap.v11.decision : snap.v12?.decision ?? null;
    decision = d === null ? notCaptured(`NOT CAPTURED — the snapshot holds no ${version} decision.`) : { value: d, source: `${src}${v11 && snap.v11.detail ? ` · ${snap.v11.detail}` : ''}`, at: snap.frozenAtMs };
  }
  const c = rec.calcAtAlert;
  const processed = Date.parse(rec.firstProcessedIso ?? rec.processedIso ?? '');
  const action: AlertField = c
    ? { value: c.headline, source: `Server Calculator result at alert processing (${c.action}; RB v1.1 rules, frozen defaults), recorded ${Number.isFinite(processed) ? fmtEt(processed) : 'at processing'} — immutable once the record is OK`, at: Number.isFinite(processed) ? processed : null }
    : notCaptured('NOT CAPTURED — the server recorded no alert-time Calculator result (no usable market-data snapshot).');
  const issues = rec.snapshot?.issues ?? [];
  return {
    snapshotOk: genuine,
    version,
    score,
    tier,
    decision,
    action,
    executionState: notCaptured('NOT CAPTURED — the execution state is evaluated live; no alert-time value is stored.'),
    dataStatus: notCaptured(`NOT CAPTURED — no data-status value is stored at alert time. Server-recorded data-integrity issues at processing: ${issues.length ? issues.map((i) => i.code).join(', ') : 'none'}.`),
    chaseStatus: notCaptured('NOT CAPTURED — the chase status is evaluated live; no alert-time value is stored (the alert-time Calculator result is shown as Alert Action).'),
    portfolioStatus: notCaptured('NOT CAPTURED — the portfolio status is evaluated live against the current portfolio; no alert-time value is stored.'),
  };
}

export interface ChangeSinceAlert {
  score: string;
  tier: string;
  decision: string;
  scoreDelta: number | null;
}

/** Display-only differences between the recorded alert-time values and the current ones (same strategy version). */
export function changeSinceAlert(a: AlertTimeAssessment, cur: StrategyCell, currentDecision: string): ChangeSinceAlert {
  const live = !cur.frozen && cur.score !== null;
  let score: string;
  let scoreDelta: number | null = null;
  if (a.score.value === null) score = 'N/A — alert score not captured';
  else if (a.score.num === null || a.score.num === undefined) score = 'N/A — not scored at alert time';
  else if (!live) score = 'N/A — no live score now';
  else {
    scoreDelta = (cur.score as number) - a.score.num;
    score = `${cur.score} − ${a.score.num} = ${scoreDelta > 0 ? '+' : scoreDelta < 0 ? '−' : ''}${Math.abs(scoreDelta)}`;
  }
  const curTier = live ? cur.tiers[0] ?? null : null;
  const tier = a.tier.value === null ? 'NOT CAPTURED' : !live ? 'N/A — no live tier now' : a.tier.tier === curTier ? 'Unchanged' : `${a.tier.value} → ${curTier ? TIER_SHORT[curTier] : 'NOT SCORED'}`;
  const decision = a.decision.value === null ? 'NOT CAPTURED' : a.decision.value === currentDecision ? 'Unchanged' : `${a.decision.value} → ${currentDecision}`;
  return { score, tier, decision, scoreDelta };
}

/** Display-only: elapsed time inside the existing alert window (same alert time and window the lifecycle uses). */
export function timeSinceAlert(r: QueueRow, now: number): { text: string; fraction: number | null; elapsed: boolean; detail: string } {
  const a = r.record.alert;
  const win = RB_V1_DEFAULTS.alertWindowMinutes * 60_000;
  const W = mmss(win);
  const src = a.timeSource === 'RECEIVED' ? 'server receipt time' : 'TrendSpider payload alert time';
  if (!Number.isFinite(a.alertTimeMs)) return { text: `UNAVAILABLE / ${W}`, fraction: null, elapsed: false, detail: 'No alert timestamp.' };
  const ms = now - a.alertTimeMs;
  if (ms < 0) return { text: `UNAVAILABLE / ${W}`, fraction: null, elapsed: false, detail: `The alert time (${src}, ${fmtEt(a.alertTimeMs)}) is ahead of this clock — elapsed time cannot be shown. Informational only.` };
  if (ms >= win) return { text: `${W}+ / ${W}`, fraction: 1, elapsed: true, detail: `Alert window elapsed: ${Math.floor(ms / 60_000)} min since the alert (${src}, ${fmtEt(a.alertTimeMs)}). Informational only — the lifecycle decides expiry.` };
  return { text: `${mmss(ms)} / ${W}`, fraction: ms / win, elapsed: false, detail: `Elapsed since the alert (${src}, ${fmtEt(a.alertTimeMs)}) within the ${RB_V1_DEFAULTS.alertWindowMinutes}-minute alert window. Informational only — never an authorization.` };
}

/** Display-only: age of the price observation RB is evaluating (the same two ages the existing freshness rule checks). */
export function marketDataAge(r: QueueRow, now: number): { text: string; detail: string } {
  const q = r.quote;
  const ages = quoteAges(q, now);
  if (!q || !ages) return { text: 'UNAVAILABLE', detail: 'No current price observation yet.' };
  if (!Number.isFinite(ages.dataAgeSec) || ages.dataAgeSec < -DEFAULT_AUTOMATION.maxDataAgeSec) return { text: 'UNAVAILABLE', detail: 'The price receipt time is ahead of this clock by more than the existing clock tolerance — age cannot be shown.' };
  // The evaluation clock ticks once per second, so a quote that arrived after the current tick is slightly newer than
  // `now` (negative age, accepted by the existing freshness rule). It is shown as 0.0 s, with the exact offset.
  if (ages.dataAgeSec < 0) return { text: '0.0 s', detail: `Current price ${q.price} arrived ${(-ages.dataAgeSec).toFixed(1)} s after this evaluation's clock tick (fetched ${q.fetchedIso}); its last trade (${q.tradeIso}) was ${ages.tradeAgeSec.toFixed(0)} s old at fetch. Informational only.` };
  return {
    text: `${ages.dataAgeSec.toFixed(1)} s`,
    detail: `Current price ${q.price} received ${ages.dataAgeSec.toFixed(1)} s ago (fetched ${q.fetchedIso}); its last trade (${q.tradeIso}) was ${ages.tradeAgeSec.toFixed(0)} s old at fetch. Same two ages the existing data-freshness rule checks. Informational only.`,
  };
}
