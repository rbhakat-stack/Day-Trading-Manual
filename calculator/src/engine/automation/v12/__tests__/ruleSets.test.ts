import { describe, expect, it } from 'vitest';
import { classifyRuleSet, qualify, readRuleSet, TRUSTED_RULE_SETS, type RuleSetEntry } from '../ruleSets';

/** Test-only registry (TEST ids). The production registry holds only the audited RBTS-L-001 / RBTS-S-001. */
const REG: RuleSetEntry[] = [
  { id: 'RBTS-L-901', direction: 'LONG', rulesVersion: 'RB v1.2', audited: '2026-01-01', checklistRef: 'test', active: true, rules: ['5m Close > VWAP', 'RVOL(20,SMA,1) > 1.5'] },
  { id: 'RBTS-S-901', direction: 'SHORT', rulesVersion: 'RB v1.2', audited: '2026-01-01', checklistRef: 'test', active: true, rules: ['5m Close < VWAP'] },
  { id: 'RBTS-L-900', direction: 'LONG', rulesVersion: 'RB v1.2', audited: '2025-12-01', checklistRef: 'test', active: false, rules: ['old'] },
];
const ok = { authenticated: true, test: false, registry: REG };

describe('rule-set registry', () => {
  it('production registry: exactly the audited RBTS-L-001 (LONG) and RBTS-S-001 (SHORT), frozen', () => {
    expect(TRUSTED_RULE_SETS.map((e) => [e.id, e.direction, e.active])).toEqual([['RBTS-L-001', 'LONG', true], ['RBTS-S-001', 'SHORT', true]]);
    expect(Object.isFrozen(TRUSTED_RULE_SETS)).toBe(true);
    for (const e of TRUSTED_RULE_SETS) {
      expect(Object.isFrozen(e)).toBe(true);
      expect(Object.isFrozen(e.rules)).toBe(true);
      expect(e.checklistRef).toMatch(/CR-012/);
      expect(e.checklistRef).toMatch(/Extended Hours OFF/);
    }
    expect(TRUSTED_RULE_SETS[0].rules).toEqual(['5m Close > VWAP(14, 0, hlc3)', '5m EMA9 > EMA20', '5m RSI14 > 55', '5m RVOL(20, SMA, 1) > 1.5', '5m Close > Open', '15m Close > 15m EMA20']);
    expect(TRUSTED_RULE_SETS[1].rules).toEqual(['5m Close < VWAP(14, 0, hlc3)', '5m EMA9 < EMA20', '5m RSI14 < 45', '5m RVOL(20, SMA, 1) > 1.5', '5m Close < Open', '15m Close < 15m EMA20']);
  });

  it.each([
    ['(1) RBTS-L-001 + LONG', 'RBTS-L-001', 'LONG', 'RECOGNISED', 'QUALIFIED'],
    ['(2) RBTS-S-001 + SHORT', 'RBTS-S-001', 'SHORT', 'RECOGNISED', 'QUALIFIED'],
    ['(3) LONG rule set + SHORT direction', 'RBTS-L-001', 'SHORT', 'CONFLICT', 'NOT_QUALIFIED'],
    ['(4) SHORT rule set + LONG direction', 'RBTS-S-001', 'LONG', 'CONFLICT', 'NOT_QUALIFIED'],
    ['(5) missing rule set', null, 'LONG', 'MISSING', 'NOT_QUALIFIED'],
    ['(6) unknown well-formed id', 'RBTS-L-002', 'LONG', 'UNKNOWN', 'NOT_QUALIFIED'],
    ['(6) unknown malformed id', 'RB-LONG', 'LONG', 'UNKNOWN', 'NOT_QUALIFIED'],
    ['(6) ids are case-sensitive', 'rbts-l-001', 'LONG', 'UNKNOWN', 'NOT_QUALIFIED'],
  ] as const)('production registry: %s → %s / %s', (_n, ruleSet, direction, status, q) => {
    expect(classifyRuleSet(ruleSet, direction).status).toBe(status);
    expect(qualify({ authenticated: true, test: false, ruleSet, direction }).status).toBe(q);
  });

  it('production registry: retired revision → NOT QUALIFIED; test or unauthenticated webhooks never qualify', () => {
    const retired = TRUSTED_RULE_SETS.map((e) => ({ ...e, active: false }));
    expect(classifyRuleSet('RBTS-L-001', 'LONG', retired).status).toBe('RETIRED');
    expect(qualify({ authenticated: true, test: false, ruleSet: 'RBTS-L-001', direction: 'LONG', registry: retired }).status).toBe('NOT_QUALIFIED');
    expect(qualify({ authenticated: true, test: true, ruleSet: 'RBTS-L-001', direction: 'LONG' }).status).toBe('NOT_QUALIFIED');
    expect(qualify({ authenticated: false, test: false, ruleSet: 'RBTS-S-001', direction: 'SHORT' }).status).toBe('NOT_QUALIFIED');
  });

  it('a qualified production alert records the audited conditions as assumed passed, never numeric values', () => {
    const q = qualify({ authenticated: true, test: false, ruleSet: readRuleSet({ rule_set: ' RBTS-S-001 ' }), direction: 'SHORT' });
    expect(q).toMatchObject({ status: 'QUALIFIED', numericValuesProvided: false });
    expect(q.rulesAssumedPassed).toContain('5m RSI14 < 45');
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
