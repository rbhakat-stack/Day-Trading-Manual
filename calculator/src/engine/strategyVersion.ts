/**
 * Strategy-definition versioning — RB v1.1 is FROZEN FOR PAPER TESTING.
 *
 * The "core" strategy definition is every setting that changes which setups are eligible, how they are
 * sized or how they are scored: calculator formulas and hard-rule thresholds, score weights, bands,
 * thresholds, time buckets, risk limits, capital policy and correlation policy. Account equity, broker
 * buying power, labels and candidate/position data are NOT core and can always be edited.
 *
 * Any change to the core definition must become a new named version (RB v1.2, …). Historical candidates
 * keep the version stored in their snapshots; nothing is ever re-scored.
 */
import { RB_V1_DEFAULTS, type RbSettings } from './settings';
import { RANKER_DEFAULTS, type RankerSettings } from './ranker/rankerSettings';
import { SCORING_VERSION } from './rules';

export const FROZEN_VERSION = SCORING_VERSION; // 'RB v1.1'
export const FROZEN_LABEL = `${FROZEN_VERSION} — FROZEN FOR PAPER TESTING`;

export interface StrategyVersionState {
  /** Name of the active strategy definition, e.g. "RB v1.1" or "RB v1.2". */
  name: string;
  /** Core settings are read-only until the user deliberately unlocks them. */
  locked: boolean;
}

export const DEFAULT_VERSION_STATE: StrategyVersionState = { name: FROZEN_VERSION, locked: true };

/** The core strategy definition only (order-stable JSON). */
export function coreDefinition(rb: RbSettings, rk: RankerSettings) {
  return {
    calculator: {
      minBuffer: rb.minBuffer,
      bufferPct: rb.bufferPct,
      atrStopMultiple: rb.atrStopMultiple,
      rewardMultiple: rb.rewardMultiple,
      chaseThresholdAtr: rb.chaseThresholdAtr,
      riskPct: rb.riskPct,
      investmentCap: rb.investmentCap,
      alertWindowMinutes: rb.alertWindowMinutes,
      timeframeMinutes: rb.timeframeMinutes,
      entryWindowStart: rb.entryWindowStart,
      entryWindowEnd: rb.entryWindowEnd,
      allowPyramiding: rb.allowPyramiding,
      strategyMode: rb.strategyMode,
    },
    ranker: {
      weights: rk.weights,
      rvolBands: rk.rvolBands.map((b) => ({ min: b.min, points: b.points })),
      rsiBandsLong: rk.rsiBandsLong,
      timeBuckets: rk.timeBuckets.map((b) => ({ start: b.start, points: b.points })),
      grades: rk.grades,
      replacementAdvantage: rk.replacementAdvantage,
      maxPositionValue: rk.portfolio.maxPositionValue,
      maxPositions: rk.portfolio.maxPositions,
      riskPerTradePct: rk.portfolio.riskPerTradePct,
      heatPct: rk.portfolio.heatPct,
      liquidityReservePct: rk.portfolio.liquidityReservePct,
      correlation: rk.correlation,
      minCandidatesForRelative: rk.minCandidatesForRelative,
    },
  };
}

export const coreFingerprint = (rb: RbSettings, rk: RankerSettings) => JSON.stringify(coreDefinition(rb, rk));

export const FROZEN_FINGERPRINT = coreFingerprint(RB_V1_DEFAULTS, RANKER_DEFAULTS);

/** True when the settings are exactly the frozen RB v1.1 definition. */
export const isFrozenDefinition = (rb: RbSettings, rk: RankerSettings) => coreFingerprint(rb, rk) === FROZEN_FINGERPRINT;

/** True when the core definition differs between two settings pairs. */
export const coreChanged = (a: [RbSettings, RankerSettings], b: [RbSettings, RankerSettings]) => coreFingerprint(...a) !== coreFingerprint(...b);

/** Human-readable list of the core fields that differ (for the version prompt). */
export function changedCoreFields(a: [RbSettings, RankerSettings], b: [RbSettings, RankerSettings]): string[] {
  const x = coreDefinition(...a);
  const y = coreDefinition(...b);
  const out: string[] = [];
  for (const part of ['calculator', 'ranker'] as const) {
    for (const k of Object.keys(x[part]) as (keyof (typeof x)[typeof part])[]) {
      if (JSON.stringify(x[part][k]) !== JSON.stringify(y[part][k])) out.push(String(k));
    }
  }
  return out;
}

/** "RB v1.1" → "RB v1.2"; "RB v1.9" → "RB v1.10"; anything else → name + " (modified)". */
export function nextVersion(name: string): string {
  const m = /^(.*v\d+)\.(\d+)$/.exec(name.trim());
  return m ? `${m[1]}.${Number(m[2]) + 1}` : `${name} (modified)`;
}

/** Display label for the active version. */
export function versionLabel(v: StrategyVersionState, rb: RbSettings, rk: RankerSettings): string {
  if (v.name === FROZEN_VERSION && isFrozenDefinition(rb, rk)) return FROZEN_LABEL;
  return `${v.name} — CUSTOM STRATEGY VERSION`;
}

/**
 * Restore a stored version state. A stored definition that is not the frozen one is never called RB v1.1.
 */
export function resolveVersion(stored: StrategyVersionState | null, rb: RbSettings, rk: RankerSettings): StrategyVersionState {
  const frozen = isFrozenDefinition(rb, rk);
  if (!stored || typeof stored.name !== 'string') return frozen ? { ...DEFAULT_VERSION_STATE } : { name: nextVersion(FROZEN_VERSION), locked: true };
  if (stored.name === FROZEN_VERSION && !frozen) return { name: nextVersion(FROZEN_VERSION), locked: stored.locked !== false };
  return { name: stored.name, locked: stored.locked !== false };
}
