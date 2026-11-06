/**
 * RVOL policy V1 — PROPOSED, OBSERVATION ONLY. Never used by the authoritative RB v1.1 decision path.
 *
 * Policy (owner, 2026-11-06): a validated TrendSpider Multi-Factor Alert is authoritative for its configured
 * RVOL20 > 1.5 qualification, so an RVOL-ONLY disagreement with RB's Alpaca SIP RVOL is reported as
 * RVOL SOURCE DIFFERENCE instead of raising DATA REVIEW. RB's RVOL SCORE stays exactly what RB observed on Alpaca SIP
 * (existing bands): snapshot.values.rvol is never modified — no fixed award, no floor.
 *
 * The RVOL qualification is accepted ONLY when every prerequisite passes (fail closed otherwise):
 *   RECORD_OK                status OK with complete snapshot values
 *   DATA_COMPLETE            no INCOMPLETE data issue (OHLC, indicators, 15m confirmation, current price)
 *   RULE_SET_RECOGNISED      webhook rule_set is RECOGNISED for the alert's direction (missing / unknown / retired /
 *                            conflicting never qualifies). NOTE: this proves the LABEL, not the alert's real conditions.
 *   SIGNAL_CANDLE_VERIFIED   production enrichmentAudit proves the 5-minute signal candle was final (Step 3·A)
 *   OTHER_CONDITIONS_PASS    VWAP, EMA9/EMA20, RSI, candle colour and 15m trend were all reproduced by RB
 *   NO_OTHER_REVIEW_ISSUE    the RVOL-only ALERT_NOT_REPRODUCED is the only data-trust issue
 * Price-source and manual parity mismatches, time windows, chase, stale data, hard rules, score ≥ 85, portfolio,
 * correlation, terminal lifecycle states and trade construction are untouched (they are evaluated downstream by the
 * unchanged engine on the V1 copy, exactly as for production).
 */
import type { AutoAlertRecord } from './alertDecision';
import { isRvolOnlyMismatch } from './rvolDiagnostics';
import { classifyRuleSet } from './v12/ruleSets';

export const RVOL_POLICY_V1 = 'RVOL_POLICY_V1_TS_QUALIFIED_SIP_SCORED';
export type RvolV1Prerequisite = 'RECORD_OK' | 'DATA_COMPLETE' | 'RULE_SET_RECOGNISED' | 'SIGNAL_CANDLE_VERIFIED' | 'OTHER_CONDITIONS_PASS' | 'NO_OTHER_REVIEW_ISSUE';
export interface RvolV1Check { code: RvolV1Prerequisite; pass: boolean; detail: string }
export interface RvolV1Verdict {
  policy: typeof RVOL_POLICY_V1;
  /** The alert has an RVOL-only disagreement (RB SIP RVOL ≤ 1.5 while TrendSpider fired). */
  applicable: boolean;
  /** All prerequisites pass → the RVOL-only DATA REVIEW would be replaced by RVOL SOURCE DIFFERENCE. */
  accepted: boolean;
  checks: RvolV1Check[];
  warnings: 'RVOL_SOURCE_DIFFERENCE'[];
  rbRvol: number | null;
  tsFormulaSipRvol: number | null;
}

const verified = (rec: AutoAlertRecord) => (rec.enrichmentAudit ?? []).some((a) => a.outcome === 'OK' && /verified complete/.test(a.detail));

/** Pure evaluation of the V1 prerequisites. Never mutates the record. */
export function evaluateRvolPolicyV1(rec: AutoAlertRecord, extra?: { signalCandleVerified?: (r: AutoAlertRecord) => boolean }): RvolV1Verdict {
  const s = rec.snapshot;
  const rbRvol = s?.values && Number.isFinite(s.values.rvol) ? s.values.rvol : null;
  const tsFormulaSipRvol = rec.rvolDiagnostics?.tsFormulaSipRvol ?? null;
  const base = { policy: RVOL_POLICY_V1, rbRvol, tsFormulaSipRvol } as const;
  const rvolFailed = (s?.alertConditions ?? []).some((c) => c.label === 'RVOL20 > 1.5' && !c.pass);
  if (!rvolFailed) return { ...base, applicable: false, accepted: false, checks: [], warnings: [] };
  const ruleSet = typeof rec.payload?.rule_set === 'string' ? (rec.payload.rule_set as string) : null;
  const rs = classifyRuleSet(ruleSet, rec.alert.direction);
  const review = (s?.issues ?? []).filter((i) => i.kind === 'REVIEW');
  const checks: RvolV1Check[] = [
    { code: 'RECORD_OK', pass: rec.status === 'OK' && !!s?.values && rbRvol !== null, detail: `status ${rec.status}` },
    { code: 'DATA_COMPLETE', pass: !(s?.issues ?? []).some((i) => i.kind === 'INCOMPLETE'), detail: (s?.issues ?? []).filter((i) => i.kind === 'INCOMPLETE').map((i) => i.code).join(', ') || 'complete' },
    { code: 'RULE_SET_RECOGNISED', pass: rs.status === 'RECOGNISED', detail: `${rs.status}: ${rs.reason}` },
    { code: 'SIGNAL_CANDLE_VERIFIED', pass: verified(rec) || !!extra?.signalCandleVerified?.(rec), detail: verified(rec) ? 'enrichmentAudit: verified complete' : extra?.signalCandleVerified?.(rec) ? 'external evidence (replay only)' : 'no completeness proof' },
    { code: 'OTHER_CONDITIONS_PASS', pass: isRvolOnlyMismatch(s), detail: (s?.alertConditions ?? []).filter((c) => !c.pass).map((c) => c.label).join('; ') || '—' },
    { code: 'NO_OTHER_REVIEW_ISSUE', pass: review.every((i) => i.code === 'ALERT_NOT_REPRODUCED'), detail: review.map((i) => i.code).join(', ') || 'none' },
  ];
  const accepted = checks.every((c) => c.pass);
  return { ...base, applicable: true, accepted, checks, warnings: accepted ? ['RVOL_SOURCE_DIFFERENCE'] : [] };
}

/**
 * The V1 view of a record: a deep COPY with only the RVOL-only ALERT_NOT_REPRODUCED review issue withdrawn when the
 * policy accepts it. RVOL value, RVOL condition (still "not reproduced" — the SIP truth), all other data unchanged.
 */
export function applyRvolPolicyV1(rec: AutoAlertRecord, verdict: RvolV1Verdict): AutoAlertRecord {
  if (!verdict.accepted) return rec;
  const r = structuredClone(rec);
  r.snapshot!.issues = r.snapshot!.issues.filter((i) => i.code !== 'ALERT_NOT_REPRODUCED');
  return r;
}
