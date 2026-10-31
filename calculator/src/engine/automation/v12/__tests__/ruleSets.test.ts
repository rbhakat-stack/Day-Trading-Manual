import { describe, expect, it } from 'vitest';
import { classifyRuleSet, qualify, readRuleSet, TRUSTED_RULE_SETS, type RuleSetEntry } from '../ruleSets';

/** Test-only registry. The production registry is EMPTY until the TrendSpider audit is complete. */
const REG: RuleSetEntry[] = [
  { id: 'RBTS-L-901', direction: 'LONG', rulesVersion: 'RB v1.2', audited: '2026-01-01', checklistRef: 'test', active: true, rules: ['5m Close > VWAP', 'RVOL(20,SMA,1) > 1.5'] },
  { id: 'RBTS-S-901', direction: 'SHORT', rulesVersion: 'RB v1.2', audited: '2026-01-01', checklistRef: 'test', active: true, rules: ['5m Close < VWAP'] },
  { id: 'RBTS-L-900', direction: 'LONG', rulesVersion: 'RB v1.2', audited: '2025-12-01', checklistRef: 'test', active: false, rules: ['old'] },
];
const ok = { authenticated: true, test: false, registry: REG };

describe('rule-set registry', () => {
  it('starts EMPTY — no production webhook is trusted until the TrendSpider audit is done', () => {
    expect(TRUSTED_RULE_SETS).toHaveLength(0);
    expect(Object.isFrozen(TRUSTED_RULE_SETS)).toBe(true);
    // Even a well-formed id is UNKNOWN against the production registry.
    expect(classifyRuleSet('RBTS-L-001', 'LONG').status).toBe('UNKNOWN');
    expect(classifyRuleSet('RBTS-S-001', 'SHORT').status).toBe('UNKNOWN');
    expect(qualify({ authenticated: true, test: false, ruleSet: 'RBTS-L-001', direction: 'LONG' }).status).toBe('NOT_QUALIFIED');
  });

  it('readRuleSet: trimmed string or null (absent, empty, non-string, non-object body)', () => {
    expect(readRuleSet({ rule_set: ' RBTS-L-901 ' })).toBe('RBTS-L-901');
    expect(readRuleSet({})).toBeNull();
    expect(readRuleSet({ rule_set: '   ' })).toBeNull();
    expect(readRuleSet({ rule_set: 901 })).toBeNull();
    expect(readRuleSet(null)).toBeNull();
    expect(readRuleSet(['rule_set'])).toBeNull();
    expect(readRuleSet({ rule_set: 'X'.repeat(500) })).toHaveLength(40);
  });
});

describe('trust boundary', () => {
  it('recognised rule set + matching direction + authenticated → QUALIFIED with the registered rules', () => {
    const q = qualify({ ...ok, ruleSet: 'RBTS-L-901', direction: 'LONG' });
    expect(q.status).toBe('QUALIFIED');
    expect(q.ruleSet.status).toBe('RECOGNISED');
    expect(q.rulesAssumedPassed).toEqual(['5m Close > VWAP', 'RVOL(20,SMA,1) > 1.5']);
    expect(q.numericValuesProvided).toBe(false);
  });
  it('missing rule set → NOT_QUALIFIED (MISSING)', () => {
    const q = qualify({ ...ok, ruleSet: null, direction: 'LONG' });
    expect([q.status, q.ruleSet.status]).toEqual(['NOT_QUALIFIED', 'MISSING']);
    expect(q.rulesAssumedPassed).toEqual([]);
  });
  it('unknown rule set (well-formed or malformed) → NOT_QUALIFIED (UNKNOWN)', () => {
    expect(qualify({ ...ok, ruleSet: 'RBTS-L-777', direction: 'LONG' }).ruleSet.status).toBe('UNKNOWN');
    const bad = qualify({ ...ok, ruleSet: 'my-alert', direction: 'LONG' });
    expect([bad.status, bad.ruleSet.status]).toEqual(['NOT_QUALIFIED', 'UNKNOWN']);
    expect(bad.reason).toMatch(/not a valid rule-set id/);
  });
  it('retired rule set → NOT_QUALIFIED (RETIRED), still resolvable for history', () => {
    const q = qualify({ ...ok, ruleSet: 'RBTS-L-900', direction: 'LONG' });
    expect([q.status, q.ruleSet.status]).toEqual(['NOT_QUALIFIED', 'RETIRED']);
    expect(q.ruleSet.entry?.id).toBe('RBTS-L-900');
  });
  it('direction conflict → NOT_QUALIFIED (CONFLICT)', () => {
    const q = qualify({ ...ok, ruleSet: 'RBTS-S-901', direction: 'LONG' });
    expect([q.status, q.ruleSet.status]).toEqual(['NOT_QUALIFIED', 'CONFLICT']);
  });
  it('unauthenticated webhook → NOT_QUALIFIED even with a recognised rule set', () => {
    const q = qualify({ authenticated: false, test: false, registry: REG, ruleSet: 'RBTS-L-901', direction: 'LONG' });
    expect(q.status).toBe('NOT_QUALIFIED');
    expect(q.reason).toMatch(/not authenticated/);
  });
  it('test webhook → NOT_QUALIFIED even with a recognised rule set', () => {
    const q = qualify({ authenticated: true, test: true, registry: REG, ruleSet: 'RBTS-L-901', direction: 'LONG' });
    expect(q.status).toBe('NOT_QUALIFIED');
    expect(q.reason).toMatch(/Test webhook/);
  });
});
