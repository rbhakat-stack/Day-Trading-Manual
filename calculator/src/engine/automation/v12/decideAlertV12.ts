/**
 * RB v1.2 — decision for one alert record (RB_V1_2_ARCHITECTURE.md §8). Pure and deterministic for a given `now`.
 *
 *   TrendSpider qualifies · SIP reconstructs · SIP does NOT re-qualify · RB owns the ticket and current-state safety.
 *
 * Order: PROCESSING → user lifecycle → NOT QUALIFIED → outside session / entry window → DATA REVIEW (integrity only)
 *        → duplicate → ticket structure and current-state safety → scoring / portfolio.
 *
 * Invariants enforced here:
 *   A  only an authenticated webhook with a recognised rule set of the same direction can qualify (audit.qualification)
 *   B  nothing is decided without a stored webhook record — SIP data alone never produces a decision or a candidate
 *   C  SIP indicator disagreement (VWAP, EMA, RSI, RVOL, candle direction, 15m) never rejects or de-qualifies; the
 *      shared calculator's SIP candle-direction / 15m hard rules are waived for qualified alerts and kept as warnings
 *   D  DATA REVIEW only for integrity problems (integrityCodes)
 *   E  ticket = the shared calculator's unchanged plan (same formulas; nothing recomputed here)
 *
 * Scoring comes from the v1.2 shadow ranking pass (v12Ranking.ts: QUALIFIED_FLOOR RVOL, TrendSpider-owned candle /
 * 15m rules). Without a v1.2 ranking row the decision stops at QUALIFIED — SCORE PENDING (no ticket); the queue uses
 * that pre-pass to decide which records enter the v1.2 pool.
 */
import { freshness, quoteAges, ticketFor, type AlertDecision, type AutomationConfig, type FinalDecision, type Freshness, type LiveQuote, type QueueSection, type TrendSpiderTicket } from '../alertDecision';
import { etParts } from '../etTime';
import type { RankedCandidate, StrategyRules } from '../../ranker/candidateRanker';
import type { LifecycleStatus } from '../../ranker/opportunityTypes';
import { checkTimeWindow, sortFails, type HardFail } from '../../rules';
import type { TradeResult } from '../../tradeCalculator';
import { integrityCodes, RB_V1_2, v12Snapshot, type AutoAlertRecordV12 } from './audit';

/** Shared-calculator / ranker hard rules that re-check TrendSpider conditions on SIP data — waived in v1.2. */
export const WAIVED_SIP_RULES = ['INVALID_CANDLE_DIRECTION', 'HTF_CONFIRMATION_FAILED'] as const;
const PORTFOLIO_CODES = ['NO_POSITION_SLOT', 'CAPITAL_LIMIT', 'PORTFOLIO_HEAT_LIMIT', 'CORRELATION_LIMIT'];
const CLOSED: LifecycleStatus[] = ['TARGET_HIT', 'STOPPED_OUT', 'MANUAL_EXIT', 'SKIPPED', 'CANCELED', 'EXPIRED', 'STALE'];

export type V12FinalDecision = FinalDecision | 'NOT QUALIFIED' | 'QUALIFIED — SCORE PENDING';
export type V12Scoring = 'V12_RANKING' | 'PENDING_V12_RANKING' | 'NOT_REACHED';

/** v1.2 ranking summary for comparison with v1.1 (null until the alert is scored). */
export interface V12ScoreSummary {
  total: number | null;
  tier: string | null;
  rvolPoints: number | null;
  rvolMode: 'QUALIFIED_FLOOR';
  /** SIP re-checks of TrendSpider conditions that were waived (calculator) — diagnostic. */
  waivedRules: string[];
}

export interface V12Decision {
  logicVersion: typeof RB_V1_2;
  mode: 'SHADOW' | 'ACTIVE';
  decision: V12FinalDecision;
  detail: string;
  section: QueueSection;
  reasons: string[];
  /** Non-blocking: parity warnings, knife-edge notes, delayed delivery, waived SIP vetoes, SIP RVOL note. */
  warnings: string[];
  /** Integrity codes behind a DATA REVIEW (empty otherwise). */
  dataReview: string[];
  qualified: boolean;
  ticket: TrendSpiderTicket | null;
  scoring: V12Scoring;
  score: V12ScoreSummary | null;
  freshness: Freshness;
}

export interface V12DecideArgs {
  record: AutoAlertRecordV12;
  mode: 'SHADOW' | 'ACTIVE';
  released: boolean;
  /** Lifecycle status of the candidate created for this record, if any (user-controlled). */
  candidateStatus: LifecycleStatus | null;
  /** Shared calculator at the current price (plan, chase, hard fails). */
  live: TradeResult | null;
  /** v1.2 shadow ranking row for this record (null in the pre-pass, or when it could not be ranked). */
  ranked: RankedCandidate | null;
  quote: LiveQuote | null;
  now: number;
  cfg: AutomationConfig;
  /** Existing live candidate / position for the ticker (RB duplicate & pyramiding rule), from the v1.1 pass. */
  duplicateOf: string | null;
  window: StrategyRules;
}

export function decideAlertV12(a: V12DecideArgs): V12Decision {
  const rec = a.record;
  const audit = rec.v12;
  const fr = freshness(rec.alert.alertTimeMs, a.now);
  const warnings = [...(audit?.warnings ?? [])];
  const out = (decision: V12FinalDecision, detail: string, section: QueueSection, reasons: string[], o: Partial<Pick<V12Decision, 'ticket' | 'scoring' | 'dataReview' | 'qualified' | 'score'>> = {}): V12Decision => ({
    logicVersion: RB_V1_2, mode: a.mode, decision, detail, section, reasons, warnings, dataReview: o.dataReview ?? [], qualified: o.qualified ?? audit?.qualification.status === 'QUALIFIED', ticket: o.ticket ?? null, scoring: o.scoring ?? 'NOT_REACHED', score: o.score ?? null, freshness: fr,
  });

  // 0 still in the micro-batch / being enriched
  if (!a.released || rec.status === 'RECEIVED' || rec.status === 'ENRICHING') return out('SCORING', 'Processing — waiting for simultaneous alerts', 'SCORING', ['Alerts arriving together are scored together before display.']);

  // 1 lifecycle the user controls — never re-decided
  const st = a.candidateStatus;
  if (st === 'PENDING') return out('ORDER SUBMITTED', 'PENDING — marked submitted by you; not necessarily filled', 'ACTIVE', []);
  if (st === 'FILLED') return out('IN POSITION', 'FILLED — governed by its stop and target', 'ACTIVE', []);
  if (st && CLOSED.includes(st)) return out('CLOSED', st.replace(/_/g, ' '), 'CLOSED', []);

  // 2 trust boundary (Invariant A). No audit = no v1.2 qualification.
  if (!audit) return out('NOT QUALIFIED', 'NOT QUALIFIED — NO v1.2 AUDIT', 'IGNORE', ['This record has no RB v1.2 audit (created before v1.2 shadow mode).'], { qualified: false });
  if (audit.qualification.status !== 'QUALIFIED') {
    return out('NOT QUALIFIED', `NOT QUALIFIED — RULE SET ${audit.qualification.ruleSet.status}`, 'IGNORE', [audit.qualification.reason, 'Only an authenticated TrendSpider webhook with an audited rule set can qualify an RB v1.2 setup. SIP never qualifies one.'], { qualified: false });
  }

  // 3 session / entry window, on the mapped signal candle (TrendSpider evaluates at its close)
  const m = audit.signalMapping;
  if (m.status === 'BEFORE_FIRST_CANDLE' || m.status === 'AFTER_SESSION') return out('NOT ELIGIBLE', 'OUTSIDE REGULAR SESSION', 'IGNORE', [m.reason]);
  if (m.candleEndMs !== null) {
    const tw = checkTimeWindow(etParts(m.candleEndMs).hhmm, a.window, 'Signal candle close');
    if (tw) return out('NOT ELIGIBLE', tw.label, 'IGNORE', [tw.reason]);
  }

  // 4 integrity only (Invariant D) — indicator disagreement is never here
  const integrity = [...integrityCodes({ status: rec.status, snapshot: v12Snapshot(rec) }, m), ...(audit.error ? ['AUDIT_ERROR'] : [])];
  if (integrity.length) {
    return out('DATA REVIEW REQUIRED', rec.status === 'DATA_ERROR' ? 'DATA ERROR — MANUAL REVIEW REQUIRED' : 'DATA REVIEW — RECONSTRUCTION INCOMPLETE OR AMBIGUOUS', 'DATA_REVIEW',
      [...integrity.map((c) => `Integrity: ${c}`), ...(rec.errors ?? [])], { dataReview: integrity });
  }

  // 5 one live candidate / position per ticker; one record per mapped candle (v1.2 dedupe)
  if (a.duplicateOf || audit.duplicateOf) {
    return out('NOT ELIGIBLE', 'DUPLICATE / EXISTING CANDIDATE', 'IGNORE', [a.duplicateOf ? `${rec.alert.symbol} already has a live candidate, pending order or position. RB never pyramids.` : `Redelivery of the ${m.label} signal already recorded as ${audit.duplicateOf}.`]);
  }

  // 6 ticket structure and current-state safety (shared calculator, unchanged formulas — Invariant E)
  const live = a.live;
  if (!live || !live.plan || !live.chase) {
    return out('DATA REVIEW REQUIRED', 'STALE DATA — REFRESHING', 'DATA_REVIEW', ['No current price yet — the ticket cannot be evaluated against the market.'], { dataReview: ['NO_CURRENT_PRICE'] });
  }
  const waived = live.hardFails.filter((f) => (WAIVED_SIP_RULES as readonly string[]).includes(f.code));
  for (const f of waived) warnings.push(`SIP_VETO_WAIVED:${f.code}`);
  const fails: HardFail[] = sortFails(live.hardFails.filter((f) => !(WAIVED_SIP_RULES as readonly string[]).includes(f.code)));
  if (fails.length) {
    const top = fails[0];
    const detail = top.code === 'STALE_SETUP' ? 'STALE — DO NOT TRADE' : top.code === 'CHASED_SETUP' ? 'DO NOT CHASE' : top.label;
    return out('NOT ELIGIBLE', detail, 'IGNORE', fails.map((f) => `${f.label}: ${f.reason}`));
  }
  if (fr.band === 'STALE') return out('NOT ELIGIBLE', 'STALE — DO NOT TRADE', 'IGNORE', ['No trigger within the alert window.']);
  if (live.chase.crossed) {
    return out('WATCHLIST', 'TRIGGER CROSSED — MANUAL REVIEW', 'WATCHLIST', ['Price is already past the entry by ≤ the chase threshold. RB does not convert a missed breakout into a Market, Limit or pullback order automatically.']);
  }
  const p = live.plan;
  const ticket = ticketFor(rec.alert.direction, { shares: p.shares, entry: p.entry, stop: p.stop, target: p.target });

  // 7 scoring / portfolio — v1.2 shadow ranking pass
  const r = a.ranked;
  if (!r) {
    return out('QUALIFIED — SCORE PENDING', 'TrendSpider-qualified · ticket valid · awaiting the v1.2 ranking pass', 'WATCHLIST', ['No ticket is offered until the alert is scored.'], { scoring: 'PENDING_V12_RANKING' });
  }
  const score: V12ScoreSummary = {
    total: r.total, tier: r.tier, rvolPoints: r.components.find((k) => k.key === 'rvol')?.points ?? null, rvolMode: 'QUALIFIED_FLOOR',
    waivedRules: r.candidate.qualification?.waivedRules ?? [],
  };
  const s = { scoring: 'V12_RANKING' as const, score };
  const strategyFails = r.strategyEligible ? [] : r.hardFails.filter((f) => !PORTFOLIO_CODES.includes(f.code) && !(WAIVED_SIP_RULES as readonly string[]).includes(f.code));
  if (strategyFails.length) return out('NOT ELIGIBLE', strategyFails[0].label, 'IGNORE', strategyFails.map((f) => `${f.label}: ${f.reason}`), s);
  if (r.missing.length) return out('DATA REVIEW REQUIRED', 'SCORING INCOMPLETE', 'DATA_REVIEW', [`Missing: ${r.missing.join(', ')}.`], s);
  if (r.tier === 'SKIP' || r.tier === 'LOW_PRIORITY') return out('SKIP', `Score ${r.total} — below the 80 watchlist threshold`, 'IGNORE', [r.eligibilityLabel], s);
  if (r.tier === 'WATCHLIST') return out('WATCHLIST', `Score ${r.total} — below the 85 trade threshold`, 'WATCHLIST', [r.eligibilityLabel], s);
  if (!r.recommendation?.startsWith('TRADE NOW')) return out('WATCHLIST', r.recommendation ?? 'NOT ALLOCATED', 'WATCHLIST', r.reasonsAgainst.slice(0, 3), s);
  const ages = quoteAges(a.quote, a.now);
  if (!ages || ages.dataAgeSec > a.cfg.maxDataAgeSec || ages.tradeAgeSec > a.cfg.maxTradeAgeSec) {
    return out('DATA REVIEW REQUIRED', 'STALE DATA — REFRESHING', 'DATA_REVIEW', ['TRADE NOW is never shown from stale current-price data.'], { ...s, dataReview: ['STALE_CURRENT_DATA'] });
  }
  return r.tier === 'ELITE'
    ? out('TRADE NOW — ELITE', `Score ${r.total} · rank #${r.rank}`, 'ACTION_NOW', [], { ...s, ticket })
    : out('HIGH PRIORITY — TRADE CONSIDERATION', `Score ${r.total} · rank #${r.rank}`, 'HIGH_PRIORITY', [], { ...s, ticket });
}

/** Shape a v1.2 decision for code that renders AlertDecision (used only if a record's logic version is RB v1.2). */
export function v12AsAlertDecision(d: V12Decision): AlertDecision {
  const decision: FinalDecision = d.decision === 'NOT QUALIFIED' ? 'NOT ELIGIBLE' : d.decision === 'QUALIFIED — SCORE PENDING' ? 'WATCHLIST' : d.decision;
  return { decision, detail: d.detail, section: d.section, reasons: d.reasons, ticket: d.ticket, freshness: d.freshness, gate: [], flags: [...d.warnings, `LOGIC ${d.logicVersion}`] };
}
