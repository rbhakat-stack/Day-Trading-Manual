/**
 * Portfolio verification gate — display layer for the Opportunity Ranker. The ranking (scores, tiers, allocation,
 * recommendations) is unchanged; only a TRADE NOW status is shown as withheld while the portfolio is unverified.
 */
import type { RankingResult } from '../engine/ranker/candidateRanker';
import { PORTFOLIO_UNVERIFIED, type PortfolioVerification } from '../engine/automation/lifecycle/portfolioExposure';

export function gateRankingDisplay(result: RankingResult, v: PortfolioVerification): RankingResult {
  if (!v.gated || !result.ranked.some((r) => r.displayStatus.startsWith('TRADE NOW'))) return result;
  return { ...result, ranked: result.ranked.map((r) => (r.displayStatus.startsWith('TRADE NOW') ? { ...r, displayStatus: PORTFOLIO_UNVERIFIED } : r)) };
}
