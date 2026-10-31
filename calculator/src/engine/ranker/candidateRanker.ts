/**
 * Candidate ranker — RB v1.1 decision engine. Order (never changes):
 *
 *   1  STRATEGY hard rules (central rules.ts): calculator validity, candle direction, entry window,
 *      15m confirmation, chase, structure, same ticker, per-trade risk.
 *      Any failure → NOT ELIGIBLE — CANNOT BE RANKED. The candidate is NOT scored and NOT ranked.
 *   2  Required inputs. Anything missing → SCORING INCOMPLETE (fields listed). No score is fabricated.
 *   3  Score: Setup Quality /70 + Portfolio Fit /30 (vs the real portfolio: open + pending).
 *   4  PORTFOLIO hard rules (slot, capital, heat, correlation) → BLOCKED — …
 *   5  ABSOLUTE threshold via classifyScore() (central): < 85 can never be a trade, whatever its rank.
 *   6  Capital allocation, HIGHEST SCORE FIRST (never arrival order), consuming capital/slots/heat/correlation.
 *   7  Final recommendation; relative rank is reported separately from absolute eligibility.
 *
 * Pure and deterministic. Filled positions are never suggested for replacement.
 */
import {
  check15mConfirmation,
  checkCandleDirection,
  checkChase,
  checkStructure,
  checkTimeWindow,
  fail,
  HARD_FAIL_LABELS,
  RULES_VERSION,
  SCORING_VERSION,
  sortFails,
  type EntryWindow,
  type HardFail,
  type HardFailCode,
} from '../rules';
import { RB_V1_DEFAULTS } from '../settings';
import { clean } from '../rounding';
import {
  FIT_KEYS,
  POOL_STATUSES,
  SETUP_KEYS,
  TIER_LABELS,
  type Candidate,
  type ComponentKey,
  type ComponentScore,
  type HardRule,
  type ManualPosition,
  type QualityTier,
  type Recommendation,
  type ScoreSnapshot,
} from './opportunityTypes';
import { allocate, buildPortfolio, checkFit, compareCandidates, type AllocationResult, type PortfolioSnapshot } from './portfolioAllocator';
import {
  asClassified,
  scoreCandle,
  scoreCapitalAvailability,
  scoreCapitalEfficiency,
  scoreCorrelation,
  scoreLocation,
  scoreMomentum,
  scorePortfolioRisk,
  scoreRvol,
  scoreTime,
  scoreTrend,
} from './opportunityScorer';
import { assessCorrelation } from './correlationRules';
import type { RankerSettings } from './rankerSettings';

/** Strategy-rule settings shared with the Trade Calculator (single source: calculator Settings). */
export type StrategyRules = EntryWindow & { chaseThresholdAtr: number };
export const DEFAULT_STRATEGY_RULES: StrategyRules = {
  entryWindowStart: RB_V1_DEFAULTS.entryWindowStart,
  entryWindowEnd: RB_V1_DEFAULTS.entryWindowEnd,
  chaseThresholdAtr: RB_V1_DEFAULTS.chaseThresholdAtr,
};

export interface RankedCandidate {
  candidate: Candidate;
  hardRules: HardRule[];
  /** All failed hard rules (strategy + portfolio), highest priority first. */
  hardFails: HardFail[];
  strategyEligible: boolean;
  /** No hard rule of any kind failed. */
  eligible: boolean;
  missing: string[];
  complete: boolean;
  components: ComponentScore[];
  /** null when not scored (strategy hard fail or incomplete inputs). */
  setup: number | null;
  fit: number | null;
  total: number | null;
  tier: QualityTier | null;
  /** Absolute eligibility label, shown separately from the relative rank. */
  eligibilityLabel: string;
  recommendation: Recommendation | null;
  displayStatus: string;
  rank: number | null;
  rankOf: number;
  allocation: AllocationResult | null;
  reasonsFor: string[];
  reasonsAgainst: string[];
  portfolio: PortfolioSnapshot;
  capitalRequiredPct: number;
}

export interface ReplacementSuggestion {
  kind: 'STRONGER' | 'SIMILAR';
  pendingId: string;
  pendingTicker: string;
  pendingScore: number;
  candidateId: string;
  candidateTicker: string;
  candidateScore: number;
  difference: number;
  message: string;
}

export interface RankingResult {
  ranked: RankedCandidate[];
  portfolio: PortfolioSnapshot;
  suggestions: ReplacementSuggestion[];
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const VALID_ACTIONS = new Set(['BUY_STOP', 'SELL_STOP', 'MARKET_LATE_ENTRY']);

/* ───────────────────────── central classification ───────────────────────── */

/** THE score → tier function (spec §40). Thresholds come only from settings.grades. */
export function classifyScore(total: number, s: RankerSettings): QualityTier {
  const g = s.grades;
  if (total >= g.elite) return 'ELITE';
  if (total >= g.high) return 'HIGH_PRIORITY';
  if (total >= g.watchlist) return 'WATCHLIST';
  if (total >= g.low) return 'LOW_PRIORITY';
  return 'SKIP';
}

const TIER_RECOMMENDATION: Record<Exclude<QualityTier, 'ELITE' | 'HIGH_PRIORITY'>, Recommendation> = {
  WATCHLIST: 'WATCHLIST / RESERVE',
  LOW_PRIORITY: 'LOW PRIORITY',
  SKIP: 'SKIP — QUALITY BELOW THRESHOLD',
};

const PORTFOLIO_RECOMMENDATION: Partial<Record<HardFailCode, Recommendation>> = {
  NO_POSITION_SLOT: 'BLOCKED — NO POSITION SLOT',
  CAPITAL_LIMIT: 'BLOCKED — CAPITAL',
  PORTFOLIO_HEAT_LIMIT: 'BLOCKED — PORTFOLIO HEAT',
  CORRELATION_LIMIT: 'BLOCKED — CORRELATED EXPOSURE',
};

/**
 * THE final decision function. Hard rules first, then completeness, then the ABSOLUTE threshold,
 * then capital allocation. Relative rank never enters this function.
 */
export function decide(args: {
  strategyFails: HardFail[];
  missing: string[];
  portfolioFails: HardFail[];
  tier: QualityTier | null;
  allocation: AllocationResult | null;
}): Recommendation {
  if (args.strategyFails.length) return 'NOT ELIGIBLE — CANNOT BE RANKED';
  if (args.missing.length || !args.tier) return 'SCORING INCOMPLETE';
  if (args.portfolioFails.length) return PORTFOLIO_RECOMMENDATION[sortFails(args.portfolioFails)[0].code] ?? 'BLOCKED — CAPITAL';
  if (args.tier !== 'ELITE' && args.tier !== 'HIGH_PRIORITY') return TIER_RECOMMENDATION[args.tier];
  if (args.allocation?.allocated) return args.tier === 'ELITE' ? 'TRADE NOW — ELITE' : 'TRADE NOW — HIGH PRIORITY';
  if (args.allocation?.reason === 'CORRELATION') return 'BLOCKED — CORRELATED EXPOSURE';
  return 'CAPITAL WAITLIST';
}

/* ───────────────────────── hard rules ───────────────────────── */

function rule(key: string, label: string, code: HardFailCode, portfolio: boolean, f: HardFail | null, okDetail = 'OK'): HardRule {
  return { key, label, code: f?.code ?? code, portfolio, pass: !f, detail: f ? f.reason : okDetail, failLabel: f ? f.label : HARD_FAIL_LABELS[code] };
}

const CALC_ACTION_CODE: Partial<Record<string, HardFailCode>> = {
  SKIP_STALE: 'STALE_SETUP',
  SKIP_CHASED: 'CHASED_SETUP',
  SKIP_SETUP_FAILED: 'SETUP_FAILED',
  INVALID_STRUCTURE: 'INVALID_TRADE_STRUCTURE',
  DO_NOT_ADD: 'EXISTING_SAME_TICKER_POSITION',
  MANAGE_EXISTING: 'EXISTING_SAME_TICKER_POSITION',
};

/** Strategy hard rules — use the same central functions as the Trade Calculator. */
export function strategyRules(c: Candidate, pf: PortfolioSnapshot, w: StrategyRules): HardRule[] {
  const calcOk = c.calcReady && VALID_ACTIONS.has(c.calcAction);
  const calcFail = calcOk
    ? null
    : c.calcHardFails?.[0] ?? fail(CALC_ACTION_CODE[c.calcAction] ?? 'SETUP_FAILED', `Trade Calculator result is not tradeable (${c.calcAction.replace(/_/g, ' ')}).`);
  const has15m = isNum(c.inputs.close15m) && isNum(c.inputs.ema20_15m);
  const sameTicker = pf.exposures.filter((e) => e.ticker.toUpperCase() === c.ticker.toUpperCase());
  const chaseAtr = c.chaseDistanceAtr ?? 0;
  const candleFail = checkCandleDirection(c.direction, c.open, c.close);
  const htfFail = has15m ? check15mConfirmation(c.direction, c.inputs.close15m as number, c.inputs.ema20_15m as number) : null;
  // RB v1.2 (shadow): a TrendSpider-qualified candidate's candle-direction and 15m conditions were proved by the
  // alert; the SIP re-check is diagnostic only and never fails the rule. RB v1.1 candidates have no qualification.
  const tsOwned = !!c.qualification;
  const owned = (f: HardFail | null) => `TrendSpider-qualified (rule set ${c.qualification?.ruleSet}) — SIP check ${f ? `differs, diagnostic only: ${f.reason}` : 'agrees'}`;
  return [
    rule('calc', 'Trade Calculator: eligible setup', 'SETUP_FAILED', false, calcFail, c.calcAction.replace(/_/g, ' ')),
    tsOwned
      ? rule('candle', 'Signal candle direction', 'INVALID_CANDLE_DIRECTION', false, null, owned(candleFail))
      : rule('candle', 'Signal candle direction', 'INVALID_CANDLE_DIRECTION', false, candleFail, c.direction === 'LONG' ? 'Close > Open' : 'Close < Open'),
    rule('time', `Entry window ${w.entryWindowStart}–${w.entryWindowEnd} ET`, 'OUTSIDE_ENTRY_WINDOW', false, checkTimeWindow(c.alertTime, w), `Alert ${c.alertTime} ET`),
    tsOwned
      ? rule('htf', 'Last completed 15m trend confirmation', 'HTF_CONFIRMATION_FAILED', false, null, owned(htfFail))
      : rule('htf', 'Last completed 15m trend confirmation', 'HTF_CONFIRMATION_FAILED', false, htfFail,
        has15m ? 'Confirmed' : 'Not evaluated — 15m inputs missing (scoring incomplete)'),
    rule('chase', 'Not chased', 'CHASED_SETUP', false, checkChase(chaseAtr > 0, chaseAtr, w.chaseThresholdAtr)),
    rule('structure', 'Valid entry structure', 'INVALID_TRADE_STRUCTURE', false, checkStructure(c.direction, c.stop, c.entry, c.target, c.shares), c.direction === 'LONG' ? 'Stop < Entry < Target' : 'Target < Entry < Stop'),
    rule('ticker', 'No existing position or order in this ticker', 'EXISTING_SAME_TICKER_POSITION', false,
      sameTicker.length ? fail('EXISTING_SAME_TICKER_POSITION', `Already ${sameTicker[0].kind === 'PENDING' ? 'a pending order' : 'an open position'} in ${c.ticker}.`) : null),
    rule('risk', 'Planned risk ≤ per-trade maximum', 'RISK_LIMIT', false,
      c.plannedRisk <= pf.perTradeRiskLimit + 0.005 ? null : fail('RISK_LIMIT', `Planned risk $${c.plannedRisk.toFixed(2)} exceeds the $${pf.perTradeRiskLimit.toFixed(2)} per-trade maximum.`),
      `$${c.plannedRisk.toFixed(2)} ≤ $${pf.perTradeRiskLimit.toFixed(2)}`),
  ];
}

/** Portfolio hard rules — evaluated against the portfolio WITHOUT this candidate. */
export function portfolioRules(c: Candidate, pf: PortfolioSnapshot, s: RankerSettings): HardRule[] {
  const fit = checkFit(asClassified(c), pf, s, { maxPositions: pf.maxPositions, heatLimit: pf.heatLimit, maxPositionValue: pf.maxPositionValue });
  const corr = assessCorrelation(asClassified(c), pf.exposures, s.correlation);
  const usd = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return [
    rule('slots', 'Position slot available', 'NO_POSITION_SLOT', true,
      fit.slotOk ? null : fail('NO_POSITION_SLOT', `${pf.slotsUsed} / ${pf.maxPositions} slots used (open + pending).`), `${pf.slotsUsed} / ${pf.maxPositions} used`),
    rule('size', 'Within max single position', 'CAPITAL_LIMIT', true,
      fit.sizeOk ? null : fail('CAPITAL_LIMIT', `${usd(c.positionValue)} exceeds the ${usd(pf.maxPositionValue)} maximum position.`), `${usd(c.positionValue)} ≤ ${usd(pf.maxPositionValue)}`),
    rule('capital', 'Fits RB v1 allocatable capital', 'CAPITAL_LIMIT', true,
      fit.capitalOk ? null : fail('CAPITAL_LIMIT', `Needs ${usd(c.positionValue)}; only ${usd(pf.available)} allocatable (broker buying power is not used).`), `${usd(pf.available)} available`),
    rule('heat', 'Portfolio heat within limit', 'PORTFOLIO_HEAT_LIMIT', true,
      fit.heatOk ? null : fail('PORTFOLIO_HEAT_LIMIT', `Projected heat ${usd(fit.projectedHeat)} exceeds ${usd(pf.heatLimit)}.`), `Projected ${usd(fit.projectedHeat)} / ${usd(pf.heatLimit)}`),
    rule('correlation', 'Correlation cap not exceeded', 'CORRELATION_LIMIT', true,
      corr.blocked ? fail('CORRELATION_LIMIT', `HIGH CORRELATION WITH ${corr.highWith.join(', ')}.`) : null),
  ];
}

/** Required ranking inputs. Missing values are listed; they are never treated as 0 or as strong. */
export function missingInputs(c: Candidate): string[] {
  const m: string[] = [];
  const need: [unknown, string][] = [
    [c.inputs.rvol, 'RVOL(20)'], [c.inputs.rsi, 'RSI(14)'], [c.inputs.vwap, 'VWAP'], [c.inputs.ema9, 'EMA9'], [c.inputs.ema20, 'EMA20'],
    [c.inputs.close15m, 'Last completed 15m Close'], [c.inputs.ema20_15m, 'Last completed 15m EMA20'],
  ];
  for (const [v, name] of need) {
    // RB v1.2: a TrendSpider-qualified candidate scores the proven RVOL floor, so SIP RVOL is not a required input.
    if (name === 'RVOL(20)' && c.qualification) continue;
    if (!isNum(v) || (v as number) <= 0) m.push(name);
  }
  if (!c.inputs.sector.trim()) m.push('Sector');
  if (!(c.atr > 0)) m.push('ATR');
  if (!(c.positionValue > 0)) m.push('Position value');
  return m;
}

export function scoreComponents(c: Candidate, pf: PortfolioSnapshot, peerEfficiencies: number[], s: RankerSettings): ComponentScore[] {
  return [
    scoreTrend(c, s),
    scoreRvol(c, s),
    scoreMomentum(c, s),
    scoreCandle(c, s),
    scoreLocation(c, s),
    scoreTime(c, s),
    scoreCapitalEfficiency(c, peerEfficiencies, pf.available, s),
    scoreCapitalAvailability(c, pf, s),
    scoreCorrelation(c, pf, s),
    scorePortfolioRisk(c, pf, s),
  ];
}

/**
 * Components that a failed STRATEGY hard rule directly invalidates are shown as N/A, never as points
 * (e.g. a 16:04 alert must not display "8/10 — Afternoon"). Raw inputs stay visible for learning.
 */
export function hardFailNA(c: Candidate, strategyFails: HardFail[]): Partial<Record<ComponentKey, { label: string; raw: string }>> {
  const out: Partial<Record<ComponentKey, { label: string; raw: string }>> = {};
  const has = (code: HardFailCode) => strategyFails.find((f) => f.code === code);
  const afterHours = has('AFTER_HOURS');
  if (afterHours) {
    out.time = { label: afterHours.label.includes('BEFORE') ? 'N/A — BEFORE REGULAR SESSION' : 'N/A — AFTER REGULAR SESSION', raw: `Alert ${c.alertTime} ET` };
  } else if (has('OUTSIDE_ENTRY_WINDOW')) {
    out.time = { label: 'N/A — OUTSIDE ELIGIBLE ENTRY WINDOW', raw: `Alert ${c.alertTime} ET` };
  }
  if (has('INVALID_CANDLE_DIRECTION')) out.candle = { label: `N/A — INVALID ${c.direction} CANDLE`, raw: `Open ${c.open} · Close ${c.close}` };
  if (has('HTF_CONFIRMATION_FAILED')) {
    out.trend = { label: 'N/A — HIGHER-TIMEFRAME CONFIRMATION FAILED', raw: `Last completed 15m Close ${c.inputs.close15m ?? '—'} vs 15m EMA20 ${c.inputs.ema20_15m ?? '—'}` };
  }
  if (has('CHASED_SETUP')) out.location = { label: 'N/A — CHASED ENTRY', raw: `Price ${(c.chaseDistanceAtr ?? 0).toFixed(2)} ATR beyond the entry` };
  return out;
}

function applyNA(components: ComponentScore[], na: ReturnType<typeof hardFailNA>): ComponentScore[] {
  return components.map((x) => {
    const n = na[x.key];
    return n ? { ...x, points: 0, na: n.label, summary: n.label, calc: [`${n.label}: no points are assigned to a hard-failed value.`, `Raw input (learning only): ${n.raw}`], positives: [], negatives: [] } : x;
  });
}

const sumKeys = (cs: ComponentScore[], keys: ComponentKey[]) => round1(cs.filter((x) => keys.includes(x.key)).reduce((a, x) => a + x.points, 0));

/** Audit snapshot (frozen copy of everything that produced the decision). */
export function snapshotOf(r: RankedCandidate, at: number, s: RankerSettings, w: StrategyRules = DEFAULT_STRATEGY_RULES, strategyVersion: string = SCORING_VERSION): ScoreSnapshot {
  const components = {} as Record<ComponentKey, number>;
  const maxes = {} as Record<ComponentKey, number>;
  const na: Partial<Record<ComponentKey, string>> = {};
  for (const c of r.components) {
    components[c.key] = c.points;
    maxes[c.key] = c.max;
    if (c.na) na[c.key] = c.na;
  }
  return {
    at,
    rulesVersion: RULES_VERSION,
    scoringVersion: SCORING_VERSION,
    strategyVersion,
    na,
    total: r.total,
    setup: r.setup,
    fit: r.fit,
    tier: r.tier,
    decision: r.displayStatus,
    components,
    maxes,
    hardRules: r.hardRules.map((h) => ({ code: h.code, label: h.label, pass: h.pass, detail: h.detail })),
    missing: [...r.missing],
    settings: JSON.parse(JSON.stringify(s)),
    entryWindow: { start: w.entryWindowStart, end: w.entryWindowEnd },
  };
}

/* ───────────────────────── main ───────────────────────── */

export function rankCandidates(
  candidates: Candidate[],
  positions: ManualPosition[],
  s: RankerSettings,
  today: string,
  w: StrategyRules = DEFAULT_STRATEGY_RULES,
): RankingResult {
  const portfolio = buildPortfolio(positions, candidates, s);
  const queue = candidates.filter((c) => c.date === today && !c.archived);

  // Steps 1–2 for every queue candidate
  const pre = queue.map((c) => {
    const pf = buildPortfolio(positions, candidates, s, c.id);
    const sRules = strategyRules(c, pf, w);
    const pRules = portfolioRules(c, pf, s);
    const strategyFails = sortFails(sRules.filter((r) => !r.pass).map((r) => fail(r.code, r.detail, r.failLabel)));
    const portfolioFails = sortFails(pRules.filter((r) => !r.pass).map((r) => fail(r.code, r.detail, r.failLabel)));
    const missing = missingInputs(c);
    return { c, pf, rules: [...sRules, ...pRules], strategyFails, portfolioFails, missing };
  });

  // Peers for relative capital efficiency: competing, strategy-eligible, complete candidates only.
  const competes = (x: (typeof pre)[number]) => (POOL_STATUSES.includes(x.c.status) || x.c.status === 'PENDING') && !x.strategyFails.length && !x.missing.length;
  const peerEff = pre.filter(competes).map((x) => clean(x.c.expectedReward / x.c.positionValue));

  // Step 3 — score only strategy-eligible, complete candidates
  const scored = pre.map((x) => {
    const components = applyNA(scoreComponents(x.c, x.pf, peerEff, s), hardFailNA(x.c, x.strategyFails));
    const canScore = !x.strategyFails.length && !x.missing.length;
    const setup = canScore ? Math.min(70, sumKeys(components, SETUP_KEYS)) : null;
    const fit = canScore ? Math.min(30, sumKeys(components, FIT_KEYS)) : null;
    const total = setup !== null && fit !== null ? Math.min(100, round1(setup + fit)) : null;
    const tier = total !== null ? classifyScore(total, s) : null;
    return { ...x, components, setup, fit, total, tier };
  });

  // Steps 5–6 — allocate scarce capital, best first, among trade-tier candidates with no hard failure
  const allocInputs = scored
    .filter((x) => POOL_STATUSES.includes(x.c.status) && x.total !== null && !x.portfolioFails.length && (x.tier === 'ELITE' || x.tier === 'HIGH_PRIORITY'))
    .map((x) => ({ ...asClassified(x.c), id: x.c.id, score: x.total as number, setupScore: x.setup as number, alertTime: x.c.alertTime, createdAt: x.c.createdAt }));
  const allocations = new Map(allocate(allocInputs, portfolio, s).map((a) => [a.id, a]));

  // Relative rank: strategy-eligible, scored, competing candidates (pool + pending)
  const rankable = scored
    .filter((x) => x.total !== null && (POOL_STATUSES.includes(x.c.status) || x.c.status === 'PENDING'))
    .sort((a, b) =>
      Number(a.portfolioFails.length > 0) - Number(b.portfolioFails.length > 0) ||
      compareCandidates(
        { score: a.total as number, setupScore: a.setup as number, alertTime: a.c.alertTime, createdAt: a.c.createdAt, id: a.c.id },
        { score: b.total as number, setupScore: b.setup as number, alertTime: b.c.alertTime, createdAt: b.c.createdAt, id: b.c.id },
      ));
  const rankOfId = new Map(rankable.map((x, i) => [x.c.id, i + 1]));

  const ranked: RankedCandidate[] = scored.map((x) => {
    const { c, pf, rules, strategyFails, portfolioFails, missing, components, setup, fit, total, tier } = x;
    const allocation = allocations.get(c.id) ?? null;
    const inPool = POOL_STATUSES.includes(c.status);
    const recommendation = inPool ? decide({ strategyFails, missing, portfolioFails, tier, allocation }) : null;
    const reasonsFor = total !== null ? components.flatMap((k) => k.positives) : [];
    const reasonsAgainst: string[] = [];
    for (const f of strategyFails) reasonsAgainst.push(`${f.label}: ${f.reason}`);
    if (!strategyFails.length && missing.length) reasonsAgainst.push(`MISSING INPUT — SCORE INCOMPLETE: ${missing.join(', ')}`);
    for (const f of portfolioFails) reasonsAgainst.push(`${f.label}: ${f.reason}`);
    if (total !== null) {
      if (tier !== 'ELITE' && tier !== 'HIGH_PRIORITY') reasonsAgainst.push(`Score ${total} is below the ${s.grades.high} minimum trade threshold — do not trade, regardless of rank.`);
      if (allocation && !allocation.allocated) {
        reasonsAgainst.push(
          allocation.reason === 'CORRELATION'
            ? `BLOCKED — HIGH CORRELATION WITH ${allocation.correlatedWith.join(', ')} (higher-ranked candidate)`
            : `Higher-ranked candidates use the available ${allocation.reason === 'SLOTS' ? 'position slots' : allocation.reason === 'HEAT' ? 'portfolio heat' : 'allocatable capital'}`,
        );
      }
      reasonsAgainst.push(...components.flatMap((k) => k.negatives));
    }
    const eligibilityLabel = strategyFails.length
      ? 'NOT ELIGIBLE'
      : missing.length
        ? 'SCORING INCOMPLETE'
        : portfolioFails.length
          ? `${TIER_LABELS[tier as QualityTier]} — PORTFOLIO BLOCKED`
          : tier === 'ELITE' || tier === 'HIGH_PRIORITY'
            ? TIER_LABELS[tier]
            : `${TIER_LABELS[tier as QualityTier]} — BELOW TRADE THRESHOLD`;
    const displayStatus = recommendation ?? (c.status === 'PENDING' ? 'PENDING ORDER' : c.status.replace(/_/g, ' '));
    return {
      candidate: c,
      hardRules: rules,
      hardFails: sortFails([...strategyFails, ...portfolioFails]),
      strategyEligible: !strategyFails.length,
      eligible: !strategyFails.length && !portfolioFails.length,
      missing,
      complete: !missing.length,
      components,
      setup,
      fit,
      total,
      tier,
      eligibilityLabel,
      recommendation,
      displayStatus,
      rank: rankOfId.get(c.id) ?? null,
      rankOf: rankable.length,
      allocation,
      reasonsFor,
      reasonsAgainst,
      portfolio: pf,
      capitalRequiredPct: pf.available > 0 ? c.positionValue / pf.available : Infinity,
    };
  });

  // Display order: ranked (by rank) → active positions → other scored → not eligible / incomplete
  const group = (r: RankedCandidate) => (r.rank !== null ? 0 : r.candidate.status === 'FILLED' ? 1 : r.total !== null ? 2 : 3);
  ranked.sort((a, b) => group(a) - group(b) || (a.rank ?? 0) - (b.rank ?? 0) || (b.total ?? -1) - (a.total ?? -1) || a.candidate.createdAt - b.candidate.createdAt || a.candidate.id.localeCompare(b.candidate.id));

  return { ranked, portfolio, suggestions: replacementSuggestions(ranked, candidates, positions, s, peerEff) };
}

/**
 * "Best use of capital": a PENDING (unfilled) order may be replaced by a materially stronger candidate
 * that is blocked only by capital / slots / heat. Never for FILLED positions. Never automatic.
 * The new candidate is re-scored as if the pending order's capital were released (fair comparison).
 */
function replacementSuggestions(ranked: RankedCandidate[], candidates: Candidate[], positions: ManualPosition[], s: RankerSettings, peerEff: number[]): ReplacementSuggestion[] {
  const pendings = ranked
    .filter((r) => r.candidate.status === 'PENDING' && r.total !== null)
    .sort((a, b) => (a.total as number) - (b.total as number) || a.candidate.id.localeCompare(b.candidate.id));
  const capitalBlocked: Recommendation[] = ['CAPITAL WAITLIST', 'BLOCKED — CAPITAL', 'BLOCKED — NO POSITION SLOT', 'BLOCKED — PORTFOLIO HEAT'];
  const out: ReplacementSuggestion[] = [];
  for (const x of ranked) {
    if (!x.recommendation || !capitalBlocked.includes(x.recommendation) || !x.strategyEligible || !x.complete) continue;
    for (const p of pendings) {
      if (p.candidate.keptAgainst.includes(x.candidate.id)) continue;
      const without = buildPortfolio(positions, candidates.filter((c) => c.id !== p.candidate.id), s, x.candidate.id);
      const f = checkFit(asClassified(x.candidate), without, s, { maxPositions: without.maxPositions, heatLimit: without.heatLimit, maxPositionValue: without.maxPositionValue });
      if (!(f.slotOk && f.capitalOk && f.sizeOk && f.heatOk && f.correlationOk)) continue;
      const xTotal = round1(scoreComponents(x.candidate, without, peerEff, s).reduce((a, c) => a + c.points, 0));
      if (xTotal < s.grades.high) continue; // absolute threshold first
      const diff = round1(xTotal - (p.total as number));
      if (diff <= 0) continue;
      const stronger = diff >= s.replacementAdvantage;
      out.push({
        kind: stronger ? 'STRONGER' : 'SIMILAR',
        pendingId: p.candidate.id,
        pendingTicker: p.candidate.ticker,
        pendingScore: p.total as number,
        candidateId: x.candidate.id,
        candidateTicker: x.candidate.ticker,
        candidateScore: xTotal,
        difference: diff,
        message: stronger
          ? `${x.candidate.ticker} ${xTotal} is materially stronger than ${p.candidate.ticker} ${p.total} (+${diff}). Reallocation is available for review.`
          : `Similar quality (+${diff} < ${s.replacementAdvantage}) — keep existing candidate ${p.candidate.ticker}.`,
      });
      break;
    }
  }
  return out;
}
