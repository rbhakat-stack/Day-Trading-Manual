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
import type { QueueRow } from '../../engine/automation/liveQueue';
import type { AutoAlertRecordV12 } from '../../engine/automation/v12/audit';
import type { PortfolioSnapshot } from '../../engine/ranker/portfolioAllocator';
import type { QualityTier } from '../../engine/ranker/opportunityTypes';
import type { HardFailCode } from '../../engine/rules';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'shadow' | 'muted';
export interface Status { label: string; tone: Tone; detail: string }

/* ───────────────────────── strategy columns (metadata-driven) ───────────────────────── */

export type StrategyRole = 'ACTIVE' | 'SHADOW' | 'COMPARISON';

export interface StrategyCell {
  score: number | null;
  /** One entry per tier column of the strategy (v1.1: Tier; v1.2: Option B, Option A). */
  tiers: (QualityTier | null)[];
  /** The strategy's decision text — only for the ACTIVE strategy, whose decision is the executable one. */
  decision: string | null;
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
const PRESENTERS: Record<string, Presenter> = {
  'RB v1.1': {
    scoreLabel: () => 'Score',
    tierLabels: ['Tier'],
    cell: (r, role) => ({ score: r.ranked?.total ?? null, tiers: [r.ranked?.tier ?? null], decision: role === 'ACTIVE' ? r.decision.decision : null }),
  },
  'RB v1.2': {
    scoreLabel: (ctx) => `Score (${ctx.v12MaxScore})`,
    tierLabels: ['Option B', 'Option A'],
    cell: (r, role) => ({
      score: r.shadow?.score?.total ?? null,
      tiers: [r.shadow?.score?.tierOptionB ?? null, r.shadow?.score?.tierOptionA ?? null],
      decision: role === 'ACTIVE' ? r.decision.decision : null,
    }),
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
export const TIER_TONE: Record<QualityTier, Tone> = { ELITE: 'ok', HIGH_PRIORITY: 'info', WATCHLIST: 'shadow', LOW_PRIORITY: 'muted', SKIP: 'muted' };

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

/** Portfolio header from the allocator's snapshot. One ranking shares one snapshot; returns null when none exists yet. */
export function portfolioSummary(rows: QueueRow[]): { pf: PortfolioSnapshot; consistent: boolean } | null {
  const pfs = rows.map((r) => r.ranked?.portfolio).filter((p): p is PortfolioSnapshot => !!p);
  if (!pfs.length) return null;
  const key = (p: PortfolioSnapshot) => `${p.equity}|${p.slotsUsed}|${p.maxPositions}|${p.heatCommitted}|${p.heatLimit}`;
  return { pf: pfs[0], consistent: pfs.every((p) => key(p) === key(pfs[0])) };
}

/** Values for the four expanded panels (all read from the row). */
export function detailFields(r: QueueRow) {
  const rec = r.record as AutoAlertRecordV12;
  const a = rec.v12;
  const m = a?.signalMapping;
  const plan = r.live?.plan;
  const c = r.candidate;
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
    entry: c?.entry ?? plan?.entry ?? null,
    stop: c?.stop ?? plan?.stop ?? null,
    target: c?.target ?? plan?.target ?? null,
    shares: c?.shares ?? plan?.shares ?? null,
    plannedRisk: c?.plannedRisk ?? plan?.maxLoss ?? null,
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
