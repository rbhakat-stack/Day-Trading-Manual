/**
 * RB v1.2 — TrendSpider rule-set registry and trust boundary (RB_V1_2_ARCHITECTURE.md §3).
 *
 * A TrendSpider webhook may qualify an RB v1.2 setup ONLY if
 *   • it is authenticated (the webhook token check passed),
 *   • it is not a test webhook,
 *   • its static `rule_set` id is in the registry below, active, and
 *   • its direction matches the registered rule set.
 * Anything else is NOT QUALIFIED and never falls back to SIP re-qualification.
 *
 * The registry starts EMPTY on purpose: the live TrendSpider LONG/SHORT alert definitions have not been audited
 * (§3.1). An id is added only after its audit checklist is completed — a versioned code change with a change-log
 * record. Ids follow RBTS-<L|S>-<NNN>; the format is accepted structurally, but a well-formed id that is not
 * registered is UNKNOWN.
 */
import type { Direction } from '../../tradeCalculator';

export const RULE_SET_PATTERN = /^RBTS-(L|S)-(\d{3})$/;
export const RULE_SET_MAX_LENGTH = 40;

export interface RuleSetEntry {
  id: string;
  direction: Direction;
  /** Strategy definition the rule set belongs to. */
  rulesVersion: string;
  /** ISO date the live TrendSpider alert was audited against the checklist. */
  audited: string;
  /** Where the completed checklist / screenshots are kept. */
  checklistRef: string;
  /** Retired revisions stay listed (inactive) so historical records still resolve. */
  active: boolean;
  /** Conditions the audited alert evaluates; recorded as "assumed passed" when it fires. */
  rules: readonly string[];
}

/** Audited rule sets. EMPTY until the TrendSpider alert-definition audit is complete. */
export const TRUSTED_RULE_SETS: readonly RuleSetEntry[] = Object.freeze([]);

export type RuleSetStatus = 'RECOGNISED' | 'MISSING' | 'UNKNOWN' | 'RETIRED' | 'CONFLICT';

export interface RuleSetVerdict {
  status: RuleSetStatus;
  /** The id as received (trimmed, length-capped), or null when absent. */
  ruleSet: string | null;
  entry: RuleSetEntry | null;
  reason: string;
}

/** The `rule_set` field from a decoded webhook body: a trimmed string, or null when absent / not a string / empty. */
export function readRuleSet(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const v = (body as Record<string, unknown>).rule_set;
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, RULE_SET_MAX_LENGTH);
  return s || null;
}

/** Classify a rule-set id against the registry for an alert of the given direction. */
export function classifyRuleSet(ruleSet: string | null, direction: Direction, registry: readonly RuleSetEntry[] = TRUSTED_RULE_SETS): RuleSetVerdict {
  if (!ruleSet) return { status: 'MISSING', ruleSet: null, entry: null, reason: 'The webhook carries no rule_set id.' };
  const entry = registry.find((e) => e.id === ruleSet) ?? null;
  if (!entry) {
    const shape = RULE_SET_PATTERN.test(ruleSet) ? 'is not an audited rule set' : 'is not a valid rule-set id (expected RBTS-<L|S>-<NNN>)';
    return { status: 'UNKNOWN', ruleSet, entry: null, reason: `rule_set "${ruleSet}" ${shape}.` };
  }
  if (!entry.active) return { status: 'RETIRED', ruleSet, entry, reason: `rule_set "${ruleSet}" has been retired.` };
  if (entry.direction !== direction) {
    return { status: 'CONFLICT', ruleSet, entry, reason: `rule_set "${ruleSet}" is a ${entry.direction} rule set but the alert is ${direction}.` };
  }
  return { status: 'RECOGNISED', ruleSet, entry, reason: `Audited ${entry.direction} rule set (${entry.audited}).` };
}

export type QualificationStatus = 'QUALIFIED' | 'NOT_QUALIFIED';

export interface Qualification {
  status: QualificationStatus;
  source: 'TRENDSPIDER';
  ruleSet: RuleSetVerdict;
  /** Conditions the audited alert evaluated TRUE (from the registry); empty when not qualified. */
  rulesAssumedPassed: readonly string[];
  /** TrendSpider's webhook carries no calculated values (Phase 2.5). */
  numericValuesProvided: false;
  reason: string;
}

/**
 * The trust boundary. `authenticated` is true only after the webhook token check passed; `test` webhooks are never
 * stored and never qualify.
 */
export function qualify(args: { authenticated: boolean; test: boolean; ruleSet: string | null; direction: Direction; registry?: readonly RuleSetEntry[] }): Qualification {
  const verdict = classifyRuleSet(args.ruleSet, args.direction, args.registry);
  const no = (reason: string): Qualification => ({ status: 'NOT_QUALIFIED', source: 'TRENDSPIDER', ruleSet: verdict, rulesAssumedPassed: [], numericValuesProvided: false, reason });
  if (!args.authenticated) return no('Webhook not authenticated.');
  if (args.test) return no('Test webhook — never qualifies.');
  if (verdict.status !== 'RECOGNISED') return no(verdict.reason);
  return { status: 'QUALIFIED', source: 'TRENDSPIDER', ruleSet: verdict, rulesAssumedPassed: verdict.entry!.rules, numericValuesProvided: false, reason: verdict.reason };
}
