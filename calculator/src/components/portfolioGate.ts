/**
 * Portfolio verification gate — display layer for the Opportunity Ranker. The ranking (scores, tiers, allocation,
 * recommendations) is unchanged; only a TRADE NOW status is shown as withheld while the portfolio is unverified.
 */
import type { RankingResult } from '../engine/ranker/candidateRanker';
import { PORTFOLIO_UNVERIFIED, type PortfolioVerification } from '../engine/automation/lifecycle/portfolioExposure';
import { executionShortLabel, type ExecutionStatus } from '../engine/automation/lifecycle/executionStatus';
import { authorizationRefusal, type ExecutionAuthorization } from '../engine/automation/lifecycle/executionState';

export function gateRankingDisplay(result: RankingResult, v: PortfolioVerification): RankingResult {
  if (!v.gated || !result.ranked.some((r) => r.displayStatus.startsWith('TRADE NOW'))) return result;
  return { ...result, ranked: result.ranked.map((r) => (r.displayStatus.startsWith('TRADE NOW') ? { ...r, displayStatus: PORTFOLIO_UNVERIFIED } : r)) };
}

/** Submitted / filled candidates: the table status names the execution (e.g. EXECUTED — NO NEW ENTRY), not a trade signal. */
export function withExecutionDisplay(result: RankingResult, executions: Record<string, ExecutionStatus> | undefined): RankingResult {
  if (!executions) return result;
  let changed = false;
  const ranked = result.ranked.map((r) => {
    const label = executions[r.candidate.id] ? executionShortLabel(executions[r.candidate.id]) : null;
    if (!label || label === r.displayStatus) return r;
    changed = true;
    return { ...r, displayStatus: label };
  });
  return changed ? { ...result, ranked } : result;
}

/**
 * S2a — execution authorization gate for the Opportunity Ranker. An AUTOMATED (alert-derived) candidate is presented as
 * TRADE NOW only while the Live Queue — the single execution authority — currently authorizes that exact alert and plan
 * (executionAuthorizations / authorizationRefusal). Otherwise its status shows why it is not authorized and the
 * recommendation is withheld (null), so no new-entry path exists. Scores, tiers, ranks and allocation are untouched; the
 * ranker's own recommendation is kept as `qualityRecommendation` for diagnosis. Manual candidates are unchanged (their
 * hard rules and the portfolio-verification gate already apply).
 */
export function gateRankingByAuthorization(result: RankingResult, auth: Record<string, ExecutionAuthorization> | null, now: number, maxAgeMs: number): RankingResult {
  let changed = false;
  const ranked = result.ranked.map((r) => {
    if (!r.recommendation?.startsWith('TRADE NOW')) return r;
    // S2a.2 — a manual candidate is the user's own calculation: its TRADE NOW is the Ranker's informational assessment,
    // never an RB authorization, and says so.
    if (r.candidate.source !== 'AUTO') {
      changed = true;
      return { ...r, displayStatus: `${r.displayStatus} · MANUAL — NOT RB-AUTHORIZED` };
    }
    const refusal = authorizationRefusal(r.candidate, auth, now, maxAgeMs);
    if (!refusal) return r;
    changed = true;
    return { ...r, recommendation: null, displayStatus: `NOT AUTHORIZED — ${refusal}`, qualityRecommendation: r.recommendation } as RankingResult['ranked'][number];
  });
  return changed ? { ...result, ranked } : result;
}

/**
 * S2a.2 — Calculator → Ranker handoff. A calculation opened from an automated alert keeps that alert's identity: it is
 * never turned into a separate manual candidate (which would escape the alert's Queue authorization, terminal chase,
 * SETUP FAILED, data, broker, portfolio and freshness restrictions). It opens the alert's own candidate, whatever its
 * status; if that alert has no candidate it is refused. A calculation with no alert origin is a manual candidate.
 */
export type CalculatorHandoff = { kind: 'SELECT_ALERT_CANDIDATE'; id: string } | { kind: 'REFUSE_ALERT_DERIVED'; recordId: string } | { kind: 'MANUAL' };
export function calculatorHandoff(origin: { recordId: string } | null, candidates: { id: string }[]): CalculatorHandoff {
  if (!origin) return { kind: 'MANUAL' };
  const own = candidates.find((c) => c.id === origin.recordId);
  return own ? { kind: 'SELECT_ALERT_CANDIDATE', id: own.id } : { kind: 'REFUSE_ALERT_DERIVED', recordId: origin.recordId };
}

