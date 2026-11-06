/**
 * RVOL eligibility POLICY A (owner, 2026-11-06) — server flag RB_RVOL_POLICY_A_ENABLED, default OFF.
 *
 * A validated TrendSpider alert whose ONLY unreproduced requirement is RVOL20 > 1.5 is not sent to DATA REVIEW: the
 * TrendSpider qualification is accepted for that one gate and the alert is scored and decided by the unchanged v1.1
 * engine. RB's independent Alpaca SIP RVOL still determines the RVOL score points (existing bands; nothing awarded, no
 * floor, no synthetic TrendSpider value). The minimum actionable score stays 85. A non-blocking RVOL SOURCE DIFFERENCE
 * warning is shown. Prerequisites are those of rvolPolicyV1.ts (fail closed).
 *
 * Isolation rules (enforced in liveQueue and tested):
 *   • Policy A is applied to a COPY of the record (only the RVOL-only ALERT_NOT_REPRODUCED review issue withdrawn).
 *     RB SIP RVOL, the RVOL condition (still recorded as not reproduced) and every other value are unchanged.
 *   • An accepted alert never joins OTHER candidates' capital-efficiency peer pool (peerExclude), so no unrelated score
 *     changes; its own score uses the existing formula against the existing pool.
 *   • v1.2 SHADOW keeps reading the ORIGINAL record (unchanged comparison).
 *   • Applied only when the alert's frozen alert-time decision was not already settled without the policy (an alert
 *     frozen as DATA REVIEW before activation stays DATA REVIEW — no revival by a later policy change).
 *   • CONFIGURATION_VERIFIED (7th prerequisite, Policy A only): the alert must belong to an audited TrendSpider
 *     configuration in tsConfigRegistry.ts (code-reviewed; EMPTY until the audit evidence is approved → fail closed).
 *     A webhook label alone never qualifies. The observation verdict (rvolPolicyV1) is unchanged.
 */
import type { AutoAlertRecord } from './alertDecision';
import type { AlertSnapshotMap } from './lifecycle/alertTimeSnapshot';
import { applyRvolPolicyV1, evaluateRvolPolicyV1, type RvolV1Verdict } from './rvolPolicyV1';
import { checkConfiguration, VERIFIED_TS_CONFIGURATIONS, type ConfigurationCheck, type VerifiedTsConfiguration } from './tsConfigRegistry';

export interface RvolPolicyFlags {
  a: boolean;
  /** TESTS / REPLAY ONLY — the App never supplies it (source-guarded); production always uses VERIFIED_TS_CONFIGURATIONS. */
  registry?: readonly VerifiedTsConfiguration[];
}
export interface EffectiveRvolPolicy extends RvolPolicyFlags { warning: string | null }

/** Flag state → effective policy. Unknown (null) = OFF. */
export function effectiveRvolPolicy(flags: { a?: boolean | null } | null | undefined): EffectiveRvolPolicy {
  return { a: flags?.a === true, warning: null };
}

export interface RvolPolicyRowInfo {
  policy: 'A';
  verdict: RvolV1Verdict;
  /** The audited TrendSpider configuration this alert was matched to. */
  configuration: ConfigurationCheck;
  /** Effective minimum actionable score for THIS alert (85 under Policy A). */
  effectiveMinScore: number;
}

export interface PreparedRvolPolicy {
  /** Records the v1.1 path decides on (accepted ones are copies with the RVOL-only review issue withdrawn). */
  records: AutoAlertRecord[];
  /** Original records by id (v1.2 SHADOW and audit). */
  original: ReadonlyMap<string, AutoAlertRecord>;
  /** Accepted alerts and their audit info. */
  accepted: ReadonlyMap<string, RvolPolicyRowInfo>;
}

const FROZEN_DATA_REVIEW = 'DATA REVIEW REQUIRED';

/** Pure. Never mutates inputs. Returns null when Policy A is OFF (callers then run the unchanged engine). */
export function prepareRvolPolicy(records: AutoAlertRecord[], policy: RvolPolicyFlags | null | undefined, frozen: AlertSnapshotMap | undefined): PreparedRvolPolicy | null {
  const eff = effectiveRvolPolicy(policy);
  if (!eff.a) return null;
  const original = new Map(records.map((r) => [r.id, r]));
  const accepted = new Map<string, RvolPolicyRowInfo>();
  const out = records.map((r) => {
    const fz = frozen?.[r.id];
    if (fz && fz.v11.decision === FROZEN_DATA_REVIEW) return r; // settled at alert time without the policy
    const v = evaluateRvolPolicyV1(r);
    if (!v.accepted) return r;
    const cfg = checkConfiguration(r, policy?.registry ?? VERIFIED_TS_CONFIGURATIONS);
    if (!cfg.pass) return r; // configuration not verified → Policy A does not apply (fail closed)
    accepted.set(r.id, { policy: 'A', verdict: v, configuration: cfg, effectiveMinScore: 85 });
    return applyRvolPolicyV1(r, v);
  });
  return { records: out, original, accepted };
}

export const RVOL_SOURCE_DIFFERENCE_TOOLTIP = 'RVOL source difference: TrendSpider qualified this alert under its RVOL > 1.5 rule, but RB calculated RVOL below 1.5 from Alpaca SIP. RB’s independent RVOL calculation determines score points. All other required conditions must pass.';
