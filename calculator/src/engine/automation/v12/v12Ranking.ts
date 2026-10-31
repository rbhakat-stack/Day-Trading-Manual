/**
 * RB v1.2 — shadow ranking pass (RB_V1_2_ARCHITECTURE.md §12, Phase 3B step 6).
 *
 * Builds RB v1.2 candidates as COPIES of the v1.1 candidates for TrendSpider-qualified records and ranks them with
 * the unchanged ranker. The persisted v1.1 candidates are never modified and v1.2 candidates are never persisted.
 *
 *   • qualification flag → the ranker scores the RVOL component at the proven floor (QUALIFIED_FLOOR, 6/15) and does
 *     not fail the candle-direction / 15m rules (TrendSpider-owned; the SIP re-check stays diagnostic)
 *   • calculator state → the shared calculator's own result with its SIP candle / 15m hard rules removed. The branch
 *     logic mirrors evaluateTrade exactly: no remaining fail + not crossed → BUY/SELL STOP (ready);
 *     no remaining fail + crossed (within the chase limit) → MARKET_LATE_ENTRY (not ready); any remaining fail →
 *     not ready, highest-priority remaining fail first. The plan (entry/stop/target/shares) is unchanged.
 * Only records whose v1.2 decision reached the scoring stage enter the pool (qualified, mapped, integrity-clean, not a
 * duplicate, valid current-state ticket): unqualified records never compete for capital.
 */
import { rankCandidates, type RankedCandidate, type RankingResult, type StrategyRules } from '../../ranker/candidateRanker';
import type { Candidate, ManualPosition } from '../../ranker/opportunityTypes';
import type { RankerSettings } from '../../ranker/rankerSettings';
import { sortFails, type HardFailCode } from '../../rules';
import type { TradeResult } from '../../tradeCalculator';
import type { V12Audit } from './audit';
import { WAIVED_SIP_RULES } from './decideAlertV12';

/** RVOL threshold a qualified alert proves (the RB rule RVOL(20, SMA, 1) > 1.5). */
export const RVOL_PROVEN_MIN = 1.5;

const POOL = ['NEW', 'WATCHLIST'];

/** The shared calculator's result with its SIP re-checks of TrendSpider conditions removed (see header). */
export function waivedCalcState(r: TradeResult, direction: 'LONG' | 'SHORT'): { calcAction: TradeResult['action']; calcReady: boolean; calcHardFails: TradeResult['hardFails']; waived: HardFailCode[] } {
  const waived = r.hardFails.filter((f) => (WAIVED_SIP_RULES as readonly string[]).includes(f.code)).map((f) => f.code);
  const remaining = sortFails(r.hardFails.filter((f) => !(WAIVED_SIP_RULES as readonly string[]).includes(f.code)));
  if (!waived.length) return { calcAction: r.action, calcReady: r.ready, calcHardFails: r.hardFails, waived };
  if (remaining.length) return { calcAction: r.action, calcReady: false, calcHardFails: remaining, waived };
  if (!r.plan || !r.chase) return { calcAction: r.action, calcReady: false, calcHardFails: remaining, waived };
  if (!r.chase.crossed) return { calcAction: direction === 'LONG' ? 'BUY_STOP' : 'SELL_STOP', calcReady: true, calcHardFails: [], waived };
  return { calcAction: 'MARKET_LATE_ENTRY', calcReady: false, calcHardFails: [], waived };
}

/** A v1.2 copy of a v1.1 candidate for a TrendSpider-qualified record. */
export function v12Candidate(c: Candidate, live: TradeResult, audit: V12Audit): Candidate {
  const calc = waivedCalcState(live, c.direction);
  return {
    ...c,
    calcAction: calc.calcAction,
    calcReady: calc.calcReady,
    calcHardFails: calc.calcHardFails,
    qualification: { source: 'TRENDSPIDER', ruleSet: audit.qualification.ruleSet.ruleSet ?? '', rvolProvenMin: RVOL_PROVEN_MIN, waivedRules: calc.waived },
  };
}

/**
 * Rank the v1.2 pool: qualified candidates that reached scoring (`poolIds`, as v1.2 copies), every non-pool candidate
 * (pending / filled / closed — the portfolio) and manual candidates unchanged. Automated pool candidates that are NOT
 * in `poolIds` are left out: they are not v1.2-qualified (or are blocked before scoring) and must not compete.
 */
export function shadowRanking(args: {
  candidates: Candidate[];
  poolIds: Set<string>;
  lives: Map<string, TradeResult | null>;
  audits: Map<string, V12Audit>;
  positions: ManualPosition[];
  rk: RankerSettings;
  today: string;
  window: StrategyRules;
}): { ranking: RankingResult; byId: Map<string, RankedCandidate> } {
  const list: Candidate[] = [];
  for (const c of args.candidates) {
    const auto = c.source === 'AUTO' && POOL.includes(c.status);
    if (!auto) list.push(c);
    else if (args.poolIds.has(c.id)) {
      const live = args.lives.get(c.id);
      const audit = args.audits.get(c.id);
      if (live && audit) list.push(v12Candidate(c, live, audit));
    }
  }
  const ranking = rankCandidates(list, args.positions, args.rk, args.today, args.window);
  return { ranking, byId: new Map(ranking.ranked.map((r) => [r.candidate.id, r])) };
}
