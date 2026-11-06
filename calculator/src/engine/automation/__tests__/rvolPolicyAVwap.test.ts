/**
 * Policy A registry: the audited TrendSpider VWAP(14, 0, HLC3) setting is recorded exactly, while RB's own SESSION-VWAP
 * condition stays mandatory. Real 2026-11-06 records (FTNT 10:30 RVOL-only, Q 14:40 RVOL + candle, CTVA); variants SYNTHETIC.
 */
import { describe, expect, it } from 'vitest';
import FX from './rvol-v1-observation-2026-11-06.json';
import FXQ from './phase-c-q-2026-11-06.json';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue, type QueueRow } from '../liveQueue';
import { prepareRvolPolicy, rbSessionVwapPassed } from '../rvolPolicy';
import { ACCEPTED_TS_VWAP_BASES, checkConfiguration, entryProblems, EXPECTED_CONDITIONS, VERIFIED_TS_CONFIGURATIONS, type VerifiedTsConfiguration } from '../tsConfigRegistry';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import { KNOWN_CLASSIFICATIONS } from '../../ranker/correlationRules';
import { RB_V1_DEFAULTS } from '../../settings';

const ALL = [...(FX.records as unknown as AutoAlertRecord[]), ...(FXQ.records as unknown as AutoAlertRecord[])];
const rec = (p: string) => structuredClone(ALL.find((r) => r.id.startsWith(p))!) as AutoAlertRecord;
const AUDIT = { auditedAtMs: Date.parse('2026-11-05T05:00:00Z'), validUntilMs: Date.parse('2026-11-20T05:00:00Z'), evidence: 'SYNTHETIC', auditedBy: 'TEST', settings: { allConditionsAnd: true, signalTimeframe5m: true, confirmation15mCompletedCandle: true, triggerOnCandleClose: true, extendedHoursOff: true, webhookToRbEndpoint: true } };
const S = (vwapBasis: VerifiedTsConfiguration['vwapBasis'], symbols = ['FTNT', 'CTVA']): VerifiedTsConfiguration => ({ ...AUDIT, vwapBasis, id: 'RBTS-S-001@TEST', ruleSet: 'RBTS-S-001', direction: 'SHORT', alertName: 'RB v1 SHORT Setup', symbols, conditionsAsSaved: EXPECTED_CONDITIONS.SHORT });
const L = (vwapBasis: VerifiedTsConfiguration['vwapBasis']): VerifiedTsConfiguration => ({ ...AUDIT, vwapBasis, id: 'RBTS-L-001@TEST', ruleSet: 'RBTS-L-001', direction: 'LONG', alertName: 'RB v1 LONG Setup', symbols: ['Q'], conditionsAsSaved: EXPECTED_CONDITIONS.LONG });
const accepted = (r: AutoAlertRecord, reg: VerifiedTsConfiguration[]) => prepareRvolPolicy([r], { a: true, registry: reg }, {})!.accepted.size === 1;
function row(r: AutoAlertRecord, policy: null | { a: true; registry: VerifiedTsConfiguration[] }): QueueRow {
  const now = Date.parse(r.processedIso!) + 4_000;
  const quotes: Record<string, LiveQuote> = { [r.alert.symbol]: { ...r.initialQuote!, tradeIso: new Date(now - 1500).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 } };
  return buildQueue({ records: [structuredClone(r)], candidates: [], positions: [], quotes, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify: (s) => KNOWN_CLASSIFICATIONS[s] ?? { sector: `S-${s}`, industry: `I-${s}`, theme: '' }, parity: {}, strategyVersion: 'RB v1.1', frozen: {}, terminal: {}, rvolPolicy: policy }).rows[0];
}
const auth = (x: QueueRow) => JSON.stringify([x.decision, x.ranked, x.candidate, x.live, x.lifecycle, x.blocked ?? null, x.shadow]);

describe('registry: recognized TrendSpider VWAP settings', () => {
  it('release gate: the production registry is still EMPTY', () => expect(VERIFIED_TS_CONFIGURATIONS).toEqual([]));
  it('exactly SESSION and TS_VWAP_14_0_HLC3 are recognized; OTHER (and anything else) is rejected', () => {
    expect(ACCEPTED_TS_VWAP_BASES).toEqual(['SESSION', 'TS_VWAP_14_0_HLC3']);
    expect(entryProblems(S('TS_VWAP_14_0_HLC3'))).toEqual([]);
    expect(entryProblems(S('SESSION'))).toEqual([]);
    expect(entryProblems(S('OTHER'))).toContain('VWAP setting is not a recognized audited configuration');
    expect(entryProblems(S('ROLLING_14' as never)).length).toBeGreaterThan(0);
    expect(accepted(rec('FTNT-S-1030'), [S('OTHER')])).toBe(false);
  });
  it('an audited TS_VWAP_14_0_HLC3 entry accepts a validated RVOL-only alert (FTNT 10:30): RB session VWAP passed', () => {
    const r = rec('FTNT-S-1030');
    expect(rbSessionVwapPassed(r)).toBe(true);
    expect(checkConfiguration(r, [S('TS_VWAP_14_0_HLC3')]).pass).toBe(true);
    expect(accepted(r, [S('TS_VWAP_14_0_HLC3')])).toBe(true);
  });
});

describe('RB session-VWAP gate stays mandatory (defence in depth)', () => {
  it('SYNTHETIC: RB session VWAP condition failed → not accepted, even with an audited TS VWAP entry', () => {
    const r = rec('FTNT-S-1030');
    r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (/^5m Close [<>] VWAP/.test(c.label) ? { ...c, pass: false } : c));
    expect(rbSessionVwapPassed(r)).toBe(false);
    expect(accepted(r, [S('TS_VWAP_14_0_HLC3')])).toBe(false);
    expect(accepted(r, [S('SESSION')])).toBe(false);
  });
  it('SYNTHETIC: snapshot evaluated on a non-session VWAP mode → not accepted', () => {
    const r = rec('FTNT-S-1030');
    r.snapshot!.config = { ...r.snapshot!.config, vwapMode: 'ROLLING_14' };
    expect(rbSessionVwapPassed(r)).toBe(false);
    expect(accepted(r, [S('TS_VWAP_14_0_HLC3')])).toBe(false);
  });
  it('SYNTHETIC: missing VWAP condition or no values → not accepted', () => {
    const noCond = rec('FTNT-S-1030'); noCond.snapshot!.alertConditions = noCond.snapshot!.alertConditions.filter((c) => !/VWAP/.test(c.label));
    const noVals = rec('FTNT-S-1030'); noVals.snapshot!.values = null;
    for (const r of [noCond, noVals]) { expect(rbSessionVwapPassed(r)).toBe(false); expect(accepted(r, [S('TS_VWAP_14_0_HLC3')])).toBe(false); }
  });
});

describe('everything else unchanged', () => {
  it('Q LONG 14:40 (invalid candle) stays blocked with an audited TS VWAP entry; output identical to OFF', () => {
    const q = rec('Q-L-144006');
    expect(accepted(q, [L('TS_VWAP_14_0_HLC3')])).toBe(false);
    const on = row(q, { a: true, registry: [L('TS_VWAP_14_0_HLC3')] });
    expect(auth(on)).toBe(auth(row(q, null)));
    expect(on.decision.decision).toBe('DATA REVIEW REQUIRED');
    expect(on.decision.ticket).toBeNull();
  });
  it('missing rule_set (HIG / SWKS legacy notes) stays excluded', () => {
    const r = rec('FTNT-S-1030'); delete (r.payload as Record<string, unknown>).rule_set;
    expect(accepted(r, [S('TS_VWAP_14_0_HLC3')])).toBe(false);
  });
  it('accepted FTNT equals production on its RVOL-reproduced twin (score, tier, SIP RVOL 0/15, plan, lifecycle); no ticket', () => {
    const r = rec('FTNT-S-1030');
    const twin = structuredClone(r);
    twin.snapshot!.alertConditions = twin.snapshot!.alertConditions.map((c) => (c.label === 'RVOL20 > 1.5' ? { ...c, pass: true } : c));
    twin.snapshot!.issues = twin.snapshot!.issues.filter((i) => i.code !== 'ALERT_NOT_REPRODUCED');
    const on = row(r, { a: true, registry: [S('TS_VWAP_14_0_HLC3')] });
    const t = row(twin, null);
    expect(on.rvolPolicy?.configuration.configId).toBe('RBTS-S-001@TEST');
    expect(JSON.stringify([on.decision, on.ranked, on.candidate, on.lifecycle])).toBe(JSON.stringify([t.decision, t.ranked, t.candidate, t.lifecycle]));
    expect(on.ranked!.components.find((k) => k.key === 'rvol')!.points).toBe(0);
    expect(on.decision.ticket).toBeNull();
  });
  it('RVOL reproduced (CTVA): Policy A not applicable; identical to OFF', () => {
    const c = rec('CTVA');
    expect(auth(row(c, { a: true, registry: [S('TS_VWAP_14_0_HLC3')] }))).toBe(auth(row(c, null)));
  });
});
