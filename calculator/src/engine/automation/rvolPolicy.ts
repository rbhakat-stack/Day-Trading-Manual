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
 *   • RB_SESSION_VWAP_PASSED (8th prerequisite, Policy A only, defence in depth): RB evaluated the VWAP condition on
 *     SESSION VWAP (snapshot vwapMode SESSION) and it passed. This keeps RB's independent session-VWAP gate mandatory
 *     regardless of the TrendSpider VWAP setting recorded in the registry (which is not assumed equivalent).
 *   • RB_COMPLETED_15M_PASSED (9th prerequisite, Policy A only): RB's OWN last COMPLETED regular-session 15m candle,
 *     frozen in the alert-time snapshot, is present, complete (3/3 five-minute bars), not stale (ended at or before the
 *     alert and < 15 min before it), its values are valid, and "15m Close >/< 15m EMA20" passed (re-verified from the
 *     values). Never a forming or later value. Required regardless of the TrendSpider 15m semantics in the registry.
 */
import type { AutoAlertRecord } from './alertDecision';
import type { AlertSnapshotMap } from './lifecycle/alertTimeSnapshot';
import { applyRvolPolicyV1, evaluateRvolPolicyV1, type RvolV1Verdict } from './rvolPolicyV1';
import { checkConfiguration, VERIFIED_TS_CONFIGURATIONS, type ConfigurationCheck, type VerifiedTsConfiguration } from './tsConfigRegistry';

export interface RvolPolicyFlags {
  a: boolean;
  /** Policy B (RB_RVOL_POLICY_B_ENABLED, default OFF). Effective only together with Policy A. */
  b?: boolean;
  /** TESTS / REPLAY ONLY — the App never supplies it (source-guarded); production always uses VERIFIED_TS_CONFIGURATIONS. */
  registry?: readonly VerifiedTsConfiguration[];
}
export interface EffectiveRvolPolicy { a: boolean; b: boolean; warning: string | null }
/**
 * POLICY B — minimum actionable score for a Policy-A-ACCEPTED RVOL-only alert (audited configuration, RB session
 * VWAP and completed-15m passed, every other condition reproduced). Every other alert keeps grades.high (85). No points
 * are added; tiers are unchanged (an 82 stays WATCHLIST).
 */
export const RVOL_EXCEPTION_MIN_SCORE = 80;

/**
 * Flag state → effective policy. Unknown (null) = OFF. Policy B requires Policy A: B without A is an invalid
 * configuration → both OFF (STATE 1, standard v1.1) plus a configuration warning.
 */
export function effectiveRvolPolicy(flags: { a?: boolean | null; b?: boolean | null } | null | undefined): EffectiveRvolPolicy {
  const a = flags?.a === true;
  const b = flags?.b === true;
  if (b && !a) return { a: false, b: false, warning: 'RVOL Policy B is enabled without Policy A — invalid configuration; both RVOL policies are OFF (standard RB v1.1).' };
  return { a, b, warning: null };
}

export interface RvolPolicyRowInfo {
  policy: 'A' | 'A+B';
  verdict: RvolV1Verdict;
  /** The audited TrendSpider configuration this alert was matched to. */
  configuration: ConfigurationCheck;
  /** Effective minimum actionable score for THIS alert (85 under Policy A; 80 under Policy A + B). */
  effectiveMinScore: number;
}

export interface PreparedRvolPolicy {
  /** Records the v1.1 path decides on (accepted ones are copies with the RVOL-only review issue withdrawn). */
  records: AutoAlertRecord[];
  /** Original records by id (v1.2 SHADOW and audit). */
  original: ReadonlyMap<string, AutoAlertRecord>;
  /** Accepted alerts and their audit info. */
  accepted: ReadonlyMap<string, RvolPolicyRowInfo>;
  /** Policy B: accepted alerts whose minimum actionable score is RVOL_EXCEPTION_MIN_SCORE (subset of accepted). */
  exception: ReadonlySet<string>;
}

const FROZEN_DATA_REVIEW = 'DATA REVIEW REQUIRED';
/** Policy B is never applied to an alert frozen at alert time as below the 85 threshold (decided without Policy B). */
const FROZEN_BELOW_85 = /below the 85 trade threshold/;

/** RB evaluated "5m Close > / < VWAP" on SESSION VWAP and the condition passed. Missing or other mode → false. */
export function rbSessionVwapPassed(r: AutoAlertRecord): boolean {
  const s = r.snapshot;
  if (!s?.values || s.config?.vwapMode !== 'SESSION') return false;
  const c = s.alertConditions.filter((x) => /^5m Close [<>] VWAP/.test(x.label));
  return c.length === 1 && c[0].pass === true;
}

const FIFTEEN_MIN_MS = 15 * 60_000;
const BAD_15M_ISSUES = ['NO_COMPLETED_15M', 'CONFIRM_15M_MISSING', 'CONFIRM_15M_PARTIAL', 'EMA20_15M_UNAVAILABLE'];
/**
 * RB's frozen alert-time confirmation on the last COMPLETED regular-session 15m candle passed. Missing, partial,
 * stale or invalid → false. Reads only the immutable alert-time snapshot (never a live or forming value).
 */
export function rbCompleted15mPassed(r: AutoAlertRecord): boolean {
  const s = r.snapshot;
  const v = s?.values;
  const c = s?.confirm15m;
  if (!s || !v || !c || c.bars5 !== 3) return false;
  if ((s.issues ?? []).some((i) => BAD_15M_ISSUES.includes(i.code))) return false;
  const endMs = Date.parse(c.endIso);
  const startMs = Date.parse(c.startIso);
  const alertMs = r.alert.alertTimeMs;
  if (!Number.isFinite(endMs) || !Number.isFinite(startMs) || endMs - startMs !== FIFTEEN_MIN_MS) return false;
  if (!(endMs <= alertMs && alertMs - endMs < FIFTEEN_MIN_MS)) return false; // the last completed candle, not stale
  if (!Number.isFinite(v.close15m) || !Number.isFinite(v.ema20_15m) || v.ema20_15m <= 0) return false;
  const long = r.alert.direction === 'LONG';
  const recomputed = long ? v.close15m > v.ema20_15m : v.close15m < v.ema20_15m;
  const cond = s.alertConditions.filter((x) => /^15m Close [<>] 15m EMA20/.test(x.label));
  return recomputed && cond.length === 1 && cond[0].pass === true && cond[0].label.includes(long ? '>' : '<');
}

/** Pure. Never mutates inputs. Returns null when Policy A is OFF (callers then run the unchanged engine). */
export function prepareRvolPolicy(records: AutoAlertRecord[], policy: RvolPolicyFlags | null | undefined, frozen: AlertSnapshotMap | undefined): PreparedRvolPolicy | null {
  const eff = effectiveRvolPolicy(policy);
  if (!eff.a) return null;
  const original = new Map(records.map((r) => [r.id, r]));
  const accepted = new Map<string, RvolPolicyRowInfo>();
  const exception = new Set<string>();
  const out = records.map((r) => {
    const fz = frozen?.[r.id];
    if (fz && fz.v11.decision === FROZEN_DATA_REVIEW) return r; // settled at alert time without the policy
    const v = evaluateRvolPolicyV1(r);
    if (!v.accepted) return r;
    const cfg = checkConfiguration(r, policy?.registry ?? VERIFIED_TS_CONFIGURATIONS);
    if (!cfg.pass) return r; // configuration not verified → Policy A does not apply (fail closed)
    if (!rbSessionVwapPassed(r)) return r; // RB's own session-VWAP condition must pass (fail closed)
    if (!rbCompleted15mPassed(r)) return r; // RB's own completed-15m confirmation must pass (fail closed)
    // Policy B: only for an alert Policy A accepted here, and never for one already decided at alert time without B.
    const b = eff.b && !(fz && fz.v11.decision === 'WATCHLIST' && FROZEN_BELOW_85.test(fz.v11.detail));
    accepted.set(r.id, { policy: b ? 'A+B' : 'A', verdict: v, configuration: cfg, effectiveMinScore: b ? RVOL_EXCEPTION_MIN_SCORE : 85 });
    if (b) exception.add(r.id);
    return applyRvolPolicyV1(r, v);
  });
  return { records: out, original, accepted, exception };
}

export const RVOL_SOURCE_DIFFERENCE_TOOLTIP = 'RVOL source difference: TrendSpider qualified this alert under its RVOL > 1.5 rule, but RB calculated RVOL below 1.5 from Alpaca SIP. RB’s independent RVOL calculation determines score points. All other required conditions must pass.';
