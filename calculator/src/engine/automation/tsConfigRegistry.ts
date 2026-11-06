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

/** TrendSpider VWAP settings an audited entry may record (see vwapBasis). Everything else is rejected. */
export const ACCEPTED_TS_VWAP_BASES: readonly string[] = ['SESSION', 'TS_VWAP_14_0_HLC3'];

/** Recorded TrendSpider 15m candle semantics an audited entry may carry (see ts15mCandle). Anything else → rejected. */
export const ACCEPTED_TS_15M_CANDLE: readonly string[] = ['COMPLETED', 'FORMING', 'UNCONFIRMED'];
/** Alert settings every audited entry must have verified as true (exactly these keys). */
export const REQUIRED_SETTINGS = ['allConditionsAnd', 'signalTimeframe5m', 'triggerOnCandleClose', 'extendedHoursOff', 'webhookToRbEndpoint'] as const;

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
  /**
   * The VWAP indicator configured on the TrendSpider alert, recorded EXACTLY as seen in its settings dialog:
   *   'SESSION'            — a session-anchored VWAP;
   *   'TS_VWAP_14_0_HLC3'  — TrendSpider "VWAP" with Length 14, Offset 0, Price Source HLC3. Its semantics are NOT
   *                          confirmed (TrendSpider's help defines Length only as the "number of periods used in the
   *                          calculation"; no reset / anchor rule is documented) and it is NOT assumed equal to RB's
   *                          session VWAP;
   *   'OTHER'              — anything else → the entry is rejected.
   * Whatever is recorded here, Policy A additionally requires RB's OWN session-VWAP condition to pass on SIP data
   * (rvolPolicy.ts: RB_SESSION_VWAP_PASSED). Both VWAP conditions therefore hold for an accepted alert, so the
   * TrendSpider setting can only make acceptance stricter, never looser.
   */
  vwapBasis: 'SESSION' | 'TS_VWAP_14_0_HLC3' | 'OTHER';
  /**
   * Which 15-minute candle TrendSpider's "15m Close vs 15m EMA20" condition evaluates, recorded honestly:
   *   'COMPLETED'   — independently verified: the last completed 15m candle;
   *   'FORMING'     — independently verified: the still-forming 15m candle;
   *   'UNCONFIRMED' — not established (TrendSpider documents neither; RB's archive cannot distinguish them).
   * Never record UNCONFIRMED as COMPLETED. Whatever is recorded, Policy A additionally requires RB's OWN last
   * COMPLETED regular-session 15m confirmation, frozen at alert time, to have passed (rvolPolicy.ts:
   * RB_COMPLETED_15M_PASSED), so the TrendSpider semantics can only make acceptance stricter.
   */
  ts15mCandle: 'COMPLETED' | 'FORMING' | 'UNCONFIRMED';
  /** Alert settings verified by the audit — every one must be true. */
  settings: { allConditionsAnd: boolean; signalTimeframe5m: boolean; triggerOnCandleClose: boolean; extendedHoursOff: boolean; webhookToRbEndpoint: boolean };
  /** Audit window (ET dates as epoch ms). validUntilMs − auditedAtMs ≤ MAX_AUDIT_VALIDITY_DAYS. */
  auditedAtMs: number;
  validUntilMs: number;
  /** Reference to the screenshot set reviewed (file names / hashes). */
  evidence: string;
  auditedBy: string;
}

/**
 * Owner-approved audited configurations (approval 2026-11-06, "Option 2"). One entry per separately saved TrendSpider
 * alert. Evidence: the owner's manual inspection of each saved alert on 2026-11-06 after the close — six conditions as
 * required, VWAP(14, 0, HLC3), all conditions AND, 5-minute candle-close evaluation, regular session / extended hours
 * off; CR-012 template audit 2026-10-31; webhook delivery to RB proven at runtime by authenticated stored alerts.
 * NOT established (recorded, not assumed): TrendSpider 15m candle semantics (UNCONFIRMED); alert repeat / expiry.
 * HIG and SWKS: rule_set notes saved by the owner after the close on 2026-11-06 — first labelled live alerts PENDING
 * (until they arrive with the rule_set, Policy A cannot match them). The audit window starts 2026-11-06 17:00 ET (after
 * every Nov 6 alert) and lasts the maximum 30 days: re-audit before 2026-12-06 17:00 ET or the entries lapse.
 * FTNT, KKR, HCA and every other configuration are deliberately absent.
 */
const AUDIT_2026_11_06 = {
  vwapBasis: 'TS_VWAP_14_0_HLC3',
  ts15mCandle: 'UNCONFIRMED',
  settings: { allConditionsAnd: true, signalTimeframe5m: true, triggerOnCandleClose: true, extendedHoursOff: true, webhookToRbEndpoint: true },
  auditedAtMs: Date.parse('2026-11-06T22:00:00Z'),
  validUntilMs: Date.parse('2026-12-06T22:00:00Z'),
  evidence: 'Owner manual inspection of the saved TrendSpider alert, 2026-11-06 (six conditions, VWAP(14,0,HLC3), AND, 5m candle close, extended hours off); CR-012 audit 2026-10-31; authenticated webhook deliveries in the RB alert archive',
  auditedBy: 'Owner (rbhakat-stack)',
} as const;
export const VERIFIED_TS_CONFIGURATIONS: readonly VerifiedTsConfiguration[] = Object.freeze([
  { ...AUDIT_2026_11_06, id: 'RBTS-L-001@2026-11-06/Q', ruleSet: 'RBTS-L-001', direction: 'LONG', alertName: 'RB v1 LONG Setup', symbols: ['Q'], conditionsAsSaved: EXPECTED_CONDITIONS.LONG },
  { ...AUDIT_2026_11_06, id: 'RBTS-S-001@2026-11-06/HIG', ruleSet: 'RBTS-S-001', direction: 'SHORT', alertName: 'RB v1 SHORT Setup', symbols: ['HIG'], conditionsAsSaved: EXPECTED_CONDITIONS.SHORT },
  { ...AUDIT_2026_11_06, id: 'RBTS-L-001@2026-11-06/SWKS', ruleSet: 'RBTS-L-001', direction: 'LONG', alertName: 'RB v1 LONG Setup', symbols: ['SWKS'], conditionsAsSaved: EXPECTED_CONDITIONS.LONG },
] satisfies VerifiedTsConfiguration[]);

export interface ConfigurationCheck { pass: boolean; configId: string | null; detail: string }

/** Why an entry is unusable (malformed entries are ignored entirely — fail closed). Pure. */
export function entryProblems(e: VerifiedTsConfiguration): string[] {
  const p: string[] = [];
  const want = EXPECTED_CONDITIONS[e.direction];
  if (!want) p.push('direction');
  else if (e.conditionsAsSaved.length !== want.length || want.some((c, i) => e.conditionsAsSaved[i] !== c)) p.push('conditions differ from the required rule set');
  if (!ACCEPTED_TS_VWAP_BASES.includes(e.vwapBasis)) p.push('VWAP setting is not a recognized audited configuration');
  if (!ACCEPTED_TS_15M_CANDLE.includes(e.ts15mCandle)) p.push('15m candle semantics not recorded');
  for (const [k, v] of Object.entries(e.settings ?? {})) if (v !== true) p.push(`setting ${k} not verified`);
  const keys = Object.keys(e.settings ?? {});
  if (keys.length !== REQUIRED_SETTINGS.length || REQUIRED_SETTINGS.some((k) => !keys.includes(k))) p.push('settings incomplete');
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
