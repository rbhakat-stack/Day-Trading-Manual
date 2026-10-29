/**
 * Portfolio state and capital allocation.
 *
 * RB v1 capital policy (paper-testing assumptions):
 *   Usable allocation = Equity × (1 − liquidity reserve)          $100,000 × 80% = $80,000
 *   Deployed          = Σ position value of active positions (manual OPEN + candidates FILLED)
 *   Reserved          = Σ position value of PENDING stop orders (not yet triggered)
 *   Available         = Usable − Deployed − Reserved
 *   Slots used        = active positions + pending orders          (≤ max positions)
 *   Heat (open)       = Σ planned risk of active positions
 *   Heat (committed)  = open heat + planned risk of pending orders (pending orders may fill)
 *   Heat limit        = Equity × heat %                             $1,000
 *
 * Broker buying power is NEVER used as the budget (shown for information only).
 * Pending orders reserve capital, so the same dollars cannot be allocated twice.
 */
import { clean } from '../rounding';
import { assessCorrelation, type Classified } from './correlationRules';
import type { Candidate, ManualPosition } from './opportunityTypes';
import type { RankerSettings } from './rankerSettings';

export interface Exposure extends Classified {
  id: string;
  kind: 'POSITION' | 'PENDING';
  positionValue: number;
  plannedRisk: number;
}

export interface PortfolioSnapshot {
  equity: number;
  usableAllocation: number;
  maxPositionValue: number;
  maxPositions: number;
  deployed: number;
  reserved: number;
  available: number;
  openPositions: number;
  pendingOrders: number;
  slotsUsed: number;
  heatOpen: number;
  heatCommitted: number;
  heatLimit: number;
  perTradeRiskLimit: number;
  brokerBuyingPower: number | null;
  exposures: Exposure[];
}

export function candidateExposure(c: Candidate, kind: Exposure['kind']): Exposure {
  return {
    id: c.id, kind, ticker: c.ticker, direction: c.direction,
    sector: c.inputs.sector, industry: c.inputs.industry, theme: c.inputs.theme,
    positionValue: c.positionValue, plannedRisk: c.plannedRisk,
  };
}

/** Build the current portfolio. `excludeId` removes one candidate (to evaluate it as if it were new). */
export function buildPortfolio(
  positions: ManualPosition[],
  candidates: Candidate[],
  s: RankerSettings,
  excludeId?: string,
): PortfolioSnapshot {
  const p = s.portfolio;
  const exposures: Exposure[] = [
    ...positions.filter((x) => x.status === 'OPEN').map<Exposure>((x) => ({
      id: x.id, kind: 'POSITION', ticker: x.ticker, direction: x.direction, sector: x.sector, industry: x.industry,
      theme: x.theme, positionValue: x.positionValue, plannedRisk: x.plannedRisk,
    })),
    ...candidates.filter((c) => !c.archived && c.id !== excludeId && c.status === 'FILLED').map((c) => candidateExposure(c, 'POSITION')),
    ...candidates.filter((c) => !c.archived && c.id !== excludeId && c.status === 'PENDING').map((c) => candidateExposure(c, 'PENDING')),
  ];
  const sum = (k: Exposure['kind'], f: (e: Exposure) => number) => clean(exposures.filter((e) => e.kind === k).reduce((a, e) => a + f(e), 0));
  const usableAllocation = clean(p.accountEquity * (1 - p.liquidityReservePct));
  const deployed = sum('POSITION', (e) => e.positionValue);
  const reserved = sum('PENDING', (e) => e.positionValue);
  const heatOpen = sum('POSITION', (e) => e.plannedRisk);
  const heatPending = sum('PENDING', (e) => e.plannedRisk);
  const openPositions = exposures.filter((e) => e.kind === 'POSITION').length;
  const pendingOrders = exposures.filter((e) => e.kind === 'PENDING').length;
  return {
    equity: p.accountEquity,
    usableAllocation,
    maxPositionValue: p.maxPositionValue,
    maxPositions: p.maxPositions,
    deployed,
    reserved,
    available: clean(usableAllocation - deployed - reserved),
    openPositions,
    pendingOrders,
    slotsUsed: openPositions + pendingOrders,
    heatOpen,
    heatCommitted: clean(heatOpen + heatPending),
    heatLimit: clean(p.accountEquity * p.heatPct),
    perTradeRiskLimit: clean(p.accountEquity * p.riskPerTradePct),
    brokerBuyingPower: p.brokerBuyingPower,
    exposures,
  };
}

export interface FitCheck {
  slotOk: boolean;
  capitalOk: boolean;
  sizeOk: boolean;
  heatOk: boolean;
  correlationOk: boolean;
  correlationBlockers: string[];
  projectedHeat: number;
  remainingAfter: number;
}

/** Can a trade of this size/risk/classification be added to this (possibly simulated) portfolio state? */
export function checkFit(
  trade: Classified & { positionValue: number; plannedRisk: number },
  state: { available: number; slotsUsed: number; heatCommitted: number; exposures: Classified[] },
  s: RankerSettings,
  limits: { maxPositions: number; heatLimit: number; maxPositionValue: number },
): FitCheck {
  const corr = assessCorrelation(trade, state.exposures, s.correlation);
  const projectedHeat = clean(state.heatCommitted + trade.plannedRisk);
  return {
    slotOk: state.slotsUsed < limits.maxPositions,
    capitalOk: trade.positionValue <= state.available + 1e-9,
    sizeOk: trade.positionValue <= limits.maxPositionValue + 1e-9,
    heatOk: projectedHeat <= limits.heatLimit + 1e-9,
    correlationOk: !corr.blocked,
    correlationBlockers: corr.highWith,
    projectedHeat,
    remainingAfter: clean(state.available - trade.positionValue),
  };
}

export interface AllocationInput extends Classified {
  id: string;
  score: number;
  setupScore: number;
  alertTime: string;
  createdAt: number;
  positionValue: number;
  plannedRisk: number;
}

export interface AllocationResult {
  id: string;
  allocated: boolean;
  /** Why not allocated: capital/slot/heat exhausted by higher-ranked candidates, or correlated with one. */
  reason: 'ALLOCATED' | 'CAPITAL' | 'SLOTS' | 'HEAT' | 'CORRELATION';
  correlatedWith: string[];
  availableBefore: number;
}

/** Deterministic ordering: score ↓, setup score ↓, alert time ↑, createdAt ↑, id ↑. Arrival order only breaks exact ties. */
export function compareCandidates(
  a: Pick<AllocationInput, 'score' | 'setupScore' | 'alertTime' | 'createdAt' | 'id'>,
  b: Pick<AllocationInput, 'score' | 'setupScore' | 'alertTime' | 'createdAt' | 'id'>,
): number {
  return (
    b.score - a.score ||
    b.setupScore - a.setupScore ||
    a.alertTime.localeCompare(b.alertTime) ||
    a.createdAt - b.createdAt ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Best-use-of-capital allocation. Candidates are taken HIGHEST SCORE FIRST (never by arrival order);
 * each allocated candidate consumes capital, a slot and heat, and becomes a correlation exposure for the
 * candidates below it. Nothing is placed or cancelled: this only produces recommendations.
 */
export function allocate(inputs: AllocationInput[], portfolio: PortfolioSnapshot, s: RankerSettings): AllocationResult[] {
  const state = {
    available: portfolio.available,
    slotsUsed: portfolio.slotsUsed,
    heatCommitted: portfolio.heatCommitted,
    exposures: [...portfolio.exposures] as Classified[],
  };
  const limits = { maxPositions: portfolio.maxPositions, heatLimit: portfolio.heatLimit, maxPositionValue: portfolio.maxPositionValue };
  const out: AllocationResult[] = [];
  for (const c of [...inputs].sort(compareCandidates)) {
    const f = checkFit(c, state, s, limits);
    const before = state.available;
    if (f.slotOk && f.capitalOk && f.sizeOk && f.heatOk && f.correlationOk) {
      state.available = clean(state.available - c.positionValue);
      state.slotsUsed += 1;
      state.heatCommitted = clean(state.heatCommitted + c.plannedRisk);
      state.exposures.push(c);
      out.push({ id: c.id, allocated: true, reason: 'ALLOCATED', correlatedWith: [], availableBefore: before });
    } else {
      const reason: AllocationResult['reason'] = !f.correlationOk ? 'CORRELATION' : !f.slotOk ? 'SLOTS' : !f.capitalOk || !f.sizeOk ? 'CAPITAL' : 'HEAT';
      out.push({ id: c.id, allocated: false, reason, correlatedWith: f.correlationBlockers, availableBefore: before });
    }
  }
  return out;
}
