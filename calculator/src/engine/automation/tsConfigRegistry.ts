/**
 * RVOL Policy A — VERIFIED TRENDSPIDER CONFIGURATION REGISTRY (fail closed).
 *
 * Policy A may accept TrendSpider's RVOL qualification only for an alert whose SAVED TrendSpider configuration was
 * inspected by a person (screenshots of the condition editor and alert settings) and recorded here in a code-reviewed
 * commit. The webhook carries no alert id, configuration id, version or hash, so a label in the webhook note
 * (rule_set, or any manually typed config id) is NEVER treated as proof: it only selects which audited entry the
 * alert claims to belong to, and the alert must also match that entry's direction, exact alert name and an explicitly
 * listed symbol, and its alert time must fall inside the audit's validity window.
 *
 * The registry is EMPTY until the owner's audit evidence has been reviewed → Policy A cannot accept any alert, even
 * with RB_RVOL_POLICY_A_ENABLED=true (output identical to OFF).
 *
 * Residual risk that RB cannot detect (documented, procedural): a saved TrendSpider definition edited after the audit
 * without the note being changed. The validity window (≤ 30 days) bounds that exposure and forces a re-audit.
 */
import type { AutoAlertRecord } from './alertDecision';

export const MAX_AUDIT_VALIDITY_DAYS = 30;

/** The required saved conditions, verbatim (all combined with AND). An entry must list exactly these. */
export const EXPECTED_CONDITIONS: Record<'LONG' | 'SHORT', readonly string[]> = {
  LONG: ['5m Close > VWAP', 'EMA9 > EMA20', 'RSI(14) > 55', 'RVOL(20, SMA, 1) > 1.5', '5m Close > Open', 'Completed 15m Close > EMA20(15m)'],
  SHORT: ['5m Close < VWAP', 'EMA9 < EMA20', 'RSI(14) < 45', 'RVOL(20, SMA, 1) > 1.5', '5m Close < Open', 'Completed 15m Close < EMA20(15m)'],
};

export interface VerifiedTsConfiguration {
  /** Registry id, e.g. "RBTS-L-001@2026-11-09". Never read from the webhook. */
  id: string;
  /** The rule_set label the audited alert sends in its webhook note. */
  ruleSet: string;
  direction: 'LONG' | 'SHORT';
  /** The exact alert_name the audited alert sends. */
  alertName: string;
  /** Symbols whose saved alert (or watchlist alert) was inspected. Explicit list; no wildcard. */
  symbols: readonly string[];
  /** Conditions exactly as seen in the condition editor screenshot (must equal EXPECTED_CONDITIONS[direction]). */
  conditionsAsSaved: readonly string[];
  /** VWAP basis seen in the indicator settings. Must be RB's basis (session VWAP) or RB cannot reproduce the condition. */
  vwapBasis: 'SESSION' | 'OTHER';
  /** Alert settings seen in the screenshots — every one must be true. */
  settings: { allConditionsAnd: boolean; signalTimeframe5m: boolean; confirmation15mCompletedCandle: boolean; triggerOnCandleClose: boolean; extendedHoursOff: boolean; webhookToRbEndpoint: boolean };
  /** Audit window (ET dates as epoch ms). validUntilMs − auditedAtMs ≤ MAX_AUDIT_VALIDITY_DAYS. */
  auditedAtMs: number;
  validUntilMs: number;
  /** Reference to the screenshot set reviewed (file names / hashes). */
  evidence: string;
  auditedBy: string;
}

/** EMPTY by design until the TrendSpider audit evidence is reviewed and approved. */
export const VERIFIED_TS_CONFIGURATIONS: readonly VerifiedTsConfiguration[] = [];

export interface ConfigurationCheck { pass: boolean; configId: string | null; detail: string }

/** Why an entry is unusable (malformed entries are ignored entirely — fail closed). Pure. */
export function entryProblems(e: VerifiedTsConfiguration): string[] {
  const p: string[] = [];
  const want = EXPECTED_CONDITIONS[e.direction];
  if (!want) p.push('direction');
  else if (e.conditionsAsSaved.length !== want.length || want.some((c, i) => e.conditionsAsSaved[i] !== c)) p.push('conditions differ from the required rule set');
  if (e.vwapBasis !== 'SESSION') p.push('VWAP basis is not RB session VWAP');
  for (const [k, v] of Object.entries(e.settings ?? {})) if (v !== true) p.push(`setting ${k} not verified`);
  if (Object.keys(e.settings ?? {}).length !== 6) p.push('settings incomplete');
  if (!e.symbols?.length || e.symbols.some((s) => !s || s.includes('*'))) p.push('symbols must be an explicit list');
  if (!(Number.isFinite(e.auditedAtMs) && Number.isFinite(e.validUntilMs) && e.validUntilMs > e.auditedAtMs)) p.push('audit window invalid');
  else if (e.validUntilMs - e.auditedAtMs > MAX_AUDIT_VALIDITY_DAYS * 86_400_000) p.push(`audit window longer than ${MAX_AUDIT_VALIDITY_DAYS} days`);
  if (!e.evidence?.trim() || !e.auditedBy?.trim() || !e.ruleSet?.trim() || !e.alertName?.trim() || !e.id?.trim()) p.push('evidence / auditor / identity missing');
  return p;
}

/** Does this alert belong to an audited, currently valid TrendSpider configuration? Pure; fail closed. */
export function checkConfiguration(rec: AutoAlertRecord, registry: readonly VerifiedTsConfiguration[] = VERIFIED_TS_CONFIGURATIONS): ConfigurationCheck {
  const ruleSet = typeof rec.payload?.rule_set === 'string' ? (rec.payload.rule_set as string) : null;
  if (!ruleSet) return { pass: false, configId: null, detail: 'No rule_set in the webhook note — configuration cannot be identified.' };
  const valid = registry.filter((e) => entryProblems(e).length === 0);
  if (!valid.length) return { pass: false, configId: null, detail: 'No audited TrendSpider configuration is registered.' };
  const byLabel = valid.filter((e) => e.ruleSet === ruleSet);
  if (!byLabel.length) return { pass: false, configId: null, detail: `rule_set ${ruleSet} has no audited configuration.` };
  const e = byLabel.find((x) => x.direction === rec.alert.direction && x.alertName === rec.alert.alertName && x.symbols.includes(rec.alert.symbol));
  if (!e) return { pass: false, configId: null, detail: `${rec.alert.symbol} ${rec.alert.direction} "${rec.alert.alertName}" is not covered by the audited ${ruleSet} configuration (direction, alert name or symbol differs).` };
  const t = rec.alert.alertTimeMs;
  if (!(t >= e.auditedAtMs && t <= e.validUntilMs)) return { pass: false, configId: e.id, detail: `Alert time is outside the audit validity window of ${e.id} — re-audit required.` };
  return { pass: true, configId: e.id, detail: `Audited configuration ${e.id} (${e.evidence}).` };
}
