/**
 * Portfolio verification gate — display layer for the Opportunity Ranker. The ranking (scores, tiers, allocation,
 * recommendations) is unchanged; only a TRADE NOW status is shown as withheld while the portfolio is unverified.
 */
import type { RankingResult } from '../engine/ranker/candidateRanker';
import { PORTFOLIO_UNVERIFIED, type PortfolioVerification } from '../engine/automation/lifecycle/portfolioExposure';
import { executionShortLabel, type ExecutionStatus } from '../engine/automation/lifecycle/executionStatus';

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
