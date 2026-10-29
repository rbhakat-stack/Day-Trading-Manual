/**
 * RB v1 Opportunity Ranker — shared types.
 *
 * The ranker never decides whether a breakout is technically valid (the Trade
 * Calculator already did). It answers: "Among valid setups, should this one get
 * my limited capital?"
 */
import type { Action, Direction } from '../tradeCalculator';
import type { HardFail, HardFailCode } from '../rules';

/** Lifecycle of a candidate in the daily opportunity queue (user-controlled). */
export type LifecycleStatus =
  | 'NEW' // sent from the calculator, not yet acted on
  | 'WATCHLIST' // deliberately watching
  | 'PENDING' // stop order submitted, not triggered → capital RESERVED
  | 'FILLED' // active position → capital DEPLOYED
  | 'SKIPPED'
  | 'STALE'
  | 'CANCELED'
  | 'EXPIRED'
  | 'STOPPED_OUT'
  | 'TARGET_HIT'
  | 'MANUAL_EXIT';

export const LIFECYCLE_LABELS: Record<LifecycleStatus, string> = {
  NEW: 'New',
  WATCHLIST: 'Watchlist',
  PENDING: 'Pending order (capital reserved)',
  FILLED: 'Filled (active position)',
  SKIPPED: 'Skipped',
  STALE: 'Stale',
  CANCELED: 'Canceled',
  EXPIRED: 'Expired',
  STOPPED_OUT: 'Stopped out',
  TARGET_HIT: 'Target hit',
  MANUAL_EXIT: 'Manual exit',
};

/** Statuses that compete for new capital. */
export const POOL_STATUSES: LifecycleStatus[] = ['NEW', 'WATCHLIST'];
/** Statuses that are closed trades with an outcome (used for analytics). */
export const OUTCOME_STATUSES: LifecycleStatus[] = ['STOPPED_OUT', 'TARGET_HIT', 'MANUAL_EXIT'];

/** The standardized final recommendations (RB v1.1). */
export type Recommendation =
  | 'TRADE NOW — ELITE'
  | 'TRADE NOW — HIGH PRIORITY'
  | 'CAPITAL WAITLIST'
  | 'WATCHLIST / RESERVE'
  | 'LOW PRIORITY'
  | 'SKIP — QUALITY BELOW THRESHOLD'
  | 'BLOCKED — CAPITAL'
  | 'BLOCKED — NO POSITION SLOT'
  | 'BLOCKED — PORTFOLIO HEAT'
  | 'BLOCKED — CORRELATED EXPOSURE'
  | 'NOT ELIGIBLE — CANNOT BE RANKED'
  | 'SCORING INCOMPLETE';

/** Absolute quality tier from the score alone (central classifier, RB v1.1). */
export type QualityTier = 'ELITE' | 'HIGH_PRIORITY' | 'WATCHLIST' | 'LOW_PRIORITY' | 'SKIP';

export const TIER_LABELS: Record<QualityTier, string> = {
  ELITE: 'ELITE — PREFERRED CAPITAL ALLOCATION',
  HIGH_PRIORITY: 'HIGH PRIORITY — TRADE CONSIDERATION',
  WATCHLIST: 'WATCHLIST / RESERVE',
  LOW_PRIORITY: 'LOW PRIORITY',
  SKIP: 'SKIP — QUALITY BELOW THRESHOLD',
};

export type ComponentKey =
  | 'trend'
  | 'rvol'
  | 'momentum'
  | 'candle'
  | 'location'
  | 'time'
  | 'capitalEfficiency'
  | 'capitalAvailability'
  | 'correlation'
  | 'portfolioRisk';

export const SETUP_KEYS: ComponentKey[] = ['trend', 'rvol', 'momentum', 'candle', 'location', 'time'];
export const FIT_KEYS: ComponentKey[] = ['capitalEfficiency', 'capitalAvailability', 'correlation', 'portfolioRisk'];

export const COMPONENT_LABELS: Record<ComponentKey, string> = {
  trend: 'Trend alignment',
  rvol: 'Relative volume',
  momentum: 'Momentum (RSI)',
  candle: 'Signal candle',
  location: 'Location / extension',
  time: 'Time of day',
  capitalEfficiency: 'Capital efficiency',
  capitalAvailability: 'Capital availability',
  correlation: 'Diversification',
  portfolioRisk: 'Portfolio risk',
};

/** Manually entered (or later TrendSpider-fed) ranking inputs. */
export interface RankingInputs {
  rvol: number | null;
  rsi: number | null;
  vwap: number | null;
  ema9: number | null;
  ema20: number | null;
  close15m: number | null;
  ema20_15m: number | null;
  sector: string;
  industry: string;
  theme: string;
}

/**
 * Audit-trail snapshot. Frozen when taken; later rule or weight changes never alter it.
 */
export interface ScoreSnapshot {
  at: number; // epoch ms
  rulesVersion: string;
  scoringVersion: string;
  /** Strategy-definition version active when the snapshot was taken (e.g. "RB v1.1"). Older snapshots lack it. */
  strategyVersion?: string;
  total: number | null; // null = not scored (hard fail or incomplete)
  setup: number | null;
  fit: number | null;
  tier: QualityTier | null;
  decision: string;
  components: Record<ComponentKey, number>;
  /** Component maxima at the time (weights may change later). */
  maxes: Record<ComponentKey, number>;
  /** Components invalidated by a hard rule at the time (shown as N/A, never as points). */
  na?: Partial<Record<ComponentKey, string>>;
  hardRules: { code: HardFailCode; label: string; pass: boolean; detail: string }[];
  missing: string[];
  settings: unknown; // full ranker settings at the time
  entryWindow: { start: string; end: string };
}

export interface Candidate {
  id: string;
  date: string; // YYYY-MM-DD (ET)
  alertTime: string; // HH:MM (ET)
  createdAt: number; // epoch ms — deterministic tie-break
  ticker: string;
  direction: Direction;
  // ── from the Trade Calculator ──
  open: number;
  high: number;
  low: number;
  close: number;
  atr: number;
  currentPrice: number;
  entry: number;
  stop: number;
  target: number;
  shares: number;
  positionValue: number;
  plannedRisk: number;
  expectedReward: number;
  orderType: string;
  calcAction: Action;
  calcReady: boolean;
  /** Hard failures reported by the Trade Calculator when the candidate was sent. */
  calcHardFails?: HardFail[];
  /** Calculator rules version at transfer time. */
  rulesVersion?: string;
  chaseDistanceAtr: number | null; // + = beyond trigger; − = not yet reached
  minutesSinceAlert: number | null;
  // ── ranker inputs ──
  inputs: RankingInputs;
  scored: boolean; // user pressed SCORE OPPORTUNITY with complete inputs
  // ── lifecycle ──
  status: LifecycleStatus;
  initialScore: ScoreSnapshot | null; // frozen; never rewritten
  entryScore: ScoreSnapshot | null; // optional; captured when FILLED
  finalScore?: ScoreSnapshot | null; // captured when the candidate reaches a terminal status
  actualFill: number | null;
  exitPrice: number | null;
  notes: string;
  archived: boolean;
  keptAgainst: string[]; // candidate ids the user chose NOT to replace this pending order with
}

/** Manually maintained position (no broker API). */
export interface ManualPosition {
  id: string;
  ticker: string;
  direction: Direction;
  sector: string;
  industry: string;
  theme: string;
  positionValue: number;
  plannedRisk: number; // planned risk remaining
  entry: number;
  stop: number;
  target: number;
  status: 'OPEN' | 'CLOSED';
}

export interface ComponentScore {
  key: ComponentKey;
  label: string;
  points: number;
  max: number;
  /** One-line summary, e.g. "RVOL 3.1 — STRONG". */
  summary: string;
  /** Exact formula / numbers used (Show Score Calculation). */
  calc: string[];
  positives: string[];
  negatives: string[];
  missing?: boolean;
  /** Set when a hard rule directly invalidates this component, e.g. "N/A — AFTER REGULAR SESSION". No points are shown. */
  na?: string;
}

export interface HardRule {
  key: string;
  /** Rule description, e.g. "Signal candle direction". */
  label: string;
  pass: boolean;
  detail: string;
  code: HardFailCode;
  /** Label shown when the rule fails, e.g. "NOT ELIGIBLE — TOO EARLY". */
  failLabel: string;
  /** Portfolio rules (capital/slot/heat/correlation) vs strategy rules (setup validity). */
  portfolio: boolean;
}
