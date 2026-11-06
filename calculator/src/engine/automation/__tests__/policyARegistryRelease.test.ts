/**
 * Policy A registry release (owner approval 2026-11-06, Option 2): exact Q / HIG / SWKS entries, TrendSpider 15m
 * semantics recorded honestly (COMPLETED / FORMING / UNCONFIRMED), RB's own frozen completed-15m confirmation mandatory.
 * Real 2026-11-06 records (FTNT 10:30 RVOL-only, Q 14:40 RVOL + candle); variants SYNTHETIC — relabelled as an
 * audited ticker and moved inside the audit window — to exercise the production entries before live alerts exist.
 */
import { describe, expect, it } from 'vitest';
import FX from './rvol-v1-observation-2026-11-06.json';
import FXQ from './phase-c-q-2026-11-06.json';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue, type QueueRow } from '../liveQueue';
import { prepareRvolPolicy, rbCompleted15mPassed } from '../rvolPolicy';
import { ACCEPTED_TS_15M_CANDLE, EXPECTED_CONDITIONS, MAX_AUDIT_VALIDITY_DAYS, REQUIRED_SETTINGS, VERIFIED_TS_CONFIGURATIONS, checkConfiguration, entryProblems, type VerifiedTsConfiguration } from '../tsConfigRegistry';
import type { AlertSnapshotMap } from '../lifecycle/alertTimeSnapshot';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import { KNOWN_CLASSIFICATIONS } from '../../ranker/correlationRules';
import { RB_V1_DEFAULTS } from '../../settings';

const ALL = [...(FX.records as unknown as AutoAlertRecord[]), ...(FXQ.records as unknown as AutoAlertRecord[])];
const rec = (p: string) => structuredClone(ALL.find((r) => r.id.startsWith(p))!) as AutoAlertRecord;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

/**
 * SYNTHETIC: a real record re-labelled as an audited ticker and shifted by whole weeks into the audit window (same
 * weekday and ET clock time; every timestamp, signal candle and frozen 15m candle shifted together, values unchanged).
 */
function asAudited(r: AutoAlertRecord, symbol: string, ruleSet: string, alertName: string, weeks = 1): AutoAlertRecord {
  const d = weeks * WEEK;
  const s = (iso: string | null | undefined) => (iso ? new Date(Date.parse(iso) + d).toISOString() : iso ?? undefined);
  r.alert = { ...r.alert, symbol, alertName, alertTimeMs: r.alert.alertTimeMs + d, alertTimeIso: s(r.alert.alertTimeIso)! };
  r.payload = { ...(r.payload as Record<string, unknown>), symbol, rule_set: ruleSet, alert_name: alertName };
  Object.assign(r, { receivedMs: r.receivedMs + d, receivedIso: s(r.receivedIso), processedIso: s(r.processedIso), firstProcessedIso: s((r as { firstProcessedIso?: string }).firstProcessedIso) });
  if (r.snapshot?.signal) r.snapshot.signal = { ...r.snapshot.signal, startIso: s(r.snapshot.signal.startIso)!, endIso: s(r.snapshot.signal.endIso)! };
  if (r.snapshot?.confirm15m) r.snapshot.confirm15m = { ...r.snapshot.confirm15m, startIso: s(r.snapshot.confirm15m.startIso)!, endIso: s(r.snapshot.confirm15m.endIso)! };
  return r;
}
/** FTNT 10:30 RVOL-only SHORT, presented as an audited HIG SHORT alert one week later (inside the window). */
const higRvolOnly = () => asAudited(rec('FTNT-S-1030'), 'HIG', 'RBTS-S-001', 'RB v1 SHORT Setup');
const accepted = (r: AutoAlertRecord, registry?: readonly VerifiedTsConfiguration[], frozen: AlertSnapshotMap = {}) => prepareRvolPolicy([r], registry ? { a: true, registry } : { a: true }, frozen)!.accepted.size === 1;
const set15m = (r: AutoAlertRecord, pass: boolean) => {
  const v = r.snapshot!.values!;
  const long = r.alert.direction === 'LONG';
  v.close15m = pass === long ? v.ema20_15m + 0.5 : v.ema20_15m - 0.5;
  r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (/^15m Close/.test(c.label) ? { ...c, pass } : c));
};

describe('release gate: exact production registry content', () => {
  it('exactly three entries: Q LONG, HIG SHORT, SWKS LONG (no FTNT / KKR / HCA / other)', () => {
    expect(VERIFIED_TS_CONFIGURATIONS.map((e) => [e.id, e.ruleSet, e.direction, e.alertName, [...e.symbols]])).toEqual([
      ['RBTS-L-001@2026-11-06/Q', 'RBTS-L-001', 'LONG', 'RB v1 LONG Setup', ['Q']],
      ['RBTS-S-001@2026-11-06/HIG', 'RBTS-S-001', 'SHORT', 'RB v1 SHORT Setup', ['HIG']],
      ['RBTS-L-001@2026-11-06/SWKS', 'RBTS-L-001', 'LONG', 'RB v1 LONG Setup', ['SWKS']],
    ]);
    expect(VERIFIED_TS_CONFIGURATIONS.flatMap((e) => e.symbols).filter((s) => ['FTNT', 'KKR', 'HCA'].includes(s))).toEqual([]);
  });
  it('every entry: valid, six required conditions, TS VWAP(14, 0, HLC3), 15m UNCONFIRMED (never COMPLETED), five settings, ≤ 30-day window from 2026-11-06 17:00 ET', () => {
    for (const e of VERIFIED_TS_CONFIGURATIONS) {
      expect(entryProblems(e)).toEqual([]);
      expect(e.conditionsAsSaved).toEqual(EXPECTED_CONDITIONS[e.direction]);
      expect(e.vwapBasis).toBe('TS_VWAP_14_0_HLC3');
      expect(e.ts15mCandle).toBe('UNCONFIRMED');
      expect(Object.keys(e.settings).sort()).toEqual([...REQUIRED_SETTINGS].sort());
      expect(e.auditedAtMs).toBe(Date.parse('2026-11-06T22:00:00Z'));
      expect(e.validUntilMs - e.auditedAtMs).toBeLessThanOrEqual(MAX_AUDIT_VALIDITY_DAYS * DAY);
      expect(e.validUntilMs).toBe(Date.parse('2026-12-06T22:00:00Z'));
      expect(e.evidence).toMatch(/Owner manual inspection/);
    }
  });
});

describe('registry schema: TrendSpider 15m semantics', () => {
  const base = VERIFIED_TS_CONFIGURATIONS[1];
  it('COMPLETED, FORMING and UNCONFIRMED are recognized; anything else or missing is rejected', () => {
    expect(ACCEPTED_TS_15M_CANDLE).toEqual(['COMPLETED', 'FORMING', 'UNCONFIRMED']);
    for (const t of ['COMPLETED', 'FORMING', 'UNCONFIRMED'] as const) expect(entryProblems({ ...base, ts15mCandle: t })).toEqual([]);
    expect(entryProblems({ ...base, ts15mCandle: 'MAYBE' as never })).toContain('15m candle semantics not recorded');
    const { ts15mCandle: _drop, ...noField } = base; // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(entryProblems(noField as unknown as VerifiedTsConfiguration)).toContain('15m candle semantics not recorded');
  });
  it('the retired boolean "confirmation15mCompletedCandle" is not accepted as a setting (settings must be exactly the five)', () => {
    const legacy = { ...base, settings: { ...base.settings, confirmation15mCompletedCandle: true } } as unknown as VerifiedTsConfiguration;
    expect(entryProblems(legacy)).toContain('settings incomplete');
    const missing = { ...base, settings: { allConditionsAnd: true, signalTimeframe5m: true, triggerOnCandleClose: true, extendedHoursOff: true } } as unknown as VerifiedTsConfiguration;
    expect(entryProblems(missing)).toContain('settings incomplete');
  });
  it('whatever TrendSpider 15m semantics is recorded, RB completed-15m pass → accepted; fail → refused', () => {
    for (const t of ['COMPLETED', 'FORMING', 'UNCONFIRMED'] as const) {
      const reg = [{ ...base, ts15mCandle: t }];
      expect([t, accepted(higRvolOnly(), reg)]).toEqual([t, true]);
      const bad = higRvolOnly(); set15m(bad, false);
      expect([t, accepted(bad, reg)]).toEqual([t, false]);
    }
  });
});

describe('the production entries in action (SYNTHETIC records inside the audit window)', () => {
  it('RVOL-only discrepancy with RB completed 15m passed → accepted by the production HIG entry', () => {
    const r = higRvolOnly();
    expect(rbCompleted15mPassed(r)).toBe(true);
    expect(checkConfiguration(r).configId).toBe('RBTS-S-001@2026-11-06/HIG');
    expect(accepted(r)).toBe(true);
  });
  it('RB completed 15m FAILED → refused (no matter the TrendSpider 15m semantics)', () => {
    const r = higRvolOnly(); set15m(r, false);
    expect(rbCompleted15mPassed(r)).toBe(false);
    expect(accepted(r)).toBe(false);
  });
  it('forming 15m would pass while the completed 15m fails → refused (the forming value is never used)', () => {
    const r = higRvolOnly(); set15m(r, false);
    (r as unknown as { v12: { reconstruction: { forming15m: unknown } } }).v12 = { ...(r as unknown as { v12: object }).v12, reconstruction: { forming15m: { label: 'forming', close: 1, ema20: 1000, bars5: 2 } } } as never; // SHORT: forming close < ema → would pass
    expect(accepted(r)).toBe(false);
  });
  it('completed 15m missing / partial / stale / invalid / label-direction mismatch / issue-flagged → refused', () => {
    const variants: [string, (r: AutoAlertRecord) => void][] = [
      ['missing confirm15m', (r) => { r.snapshot!.confirm15m = null; }],
      ['partial (2 of 3 bars)', (r) => { r.snapshot!.confirm15m = { ...r.snapshot!.confirm15m!, bars5: 2 }; }],
      ['stale (an older 15m candle)', (r) => { const c = r.snapshot!.confirm15m!; r.snapshot!.confirm15m = { ...c, startIso: new Date(Date.parse(c.startIso) - 900_000).toISOString(), endIso: new Date(Date.parse(c.endIso) - 900_000).toISOString() }; }],
      ['future (ends after the alert)', (r) => { const c = r.snapshot!.confirm15m!; r.snapshot!.confirm15m = { ...c, startIso: new Date(Date.parse(c.startIso) + 900_000).toISOString(), endIso: new Date(Date.parse(c.endIso) + 900_000).toISOString() }; }],
      ['NaN close15m', (r) => { r.snapshot!.values!.close15m = Number.NaN; }],
      ['ema20_15m 0', (r) => { r.snapshot!.values!.ema20_15m = 0; }],
      ['condition says pass but values disagree', (r) => { const v = r.snapshot!.values!; v.close15m = v.ema20_15m + 0.5; }],
      ['condition missing', (r) => { r.snapshot!.alertConditions = r.snapshot!.alertConditions.filter((c) => !/^15m/.test(c.label)); }],
      ['CONFIRM_15M_PARTIAL issue', (r) => { r.snapshot!.issues = [...r.snapshot!.issues, { kind: 'REVIEW', code: 'CONFIRM_15M_PARTIAL', message: 'x' }]; }],
      ['NO_COMPLETED_15M issue', (r) => { r.snapshot!.issues = [...r.snapshot!.issues, { kind: 'INCOMPLETE', code: 'NO_COMPLETED_15M', message: 'x' }]; }],
    ];
    for (const [name, m] of variants) { const r = higRvolOnly(); m(r); expect([name, rbCompleted15mPassed(r) || accepted(r)]).toEqual([name, false]); }
  });
  it('RB session VWAP failed → refused', () => {
    const r = higRvolOnly();
    r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (/^5m Close [<>] VWAP/.test(c.label) ? { ...c, pass: false } : c));
    expect(accepted(r)).toBe(false);
  });
  it('another non-RVOL indicator failed (RSI / EMA / candle) → refused', () => {
    for (const pre of ['RSI14', 'EMA9', 'Close <']) {
      const r = higRvolOnly();
      r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (c.label.startsWith(pre) ? { ...c, pass: false } : c));
      expect([pre, accepted(r)]).toEqual([pre, false]);
    }
  });
  it('missing or wrong rule_set, wrong name, unregistered ticker (FTNT / KKR) → refused', () => {
    const noRs = higRvolOnly(); delete (noRs.payload as Record<string, unknown>).rule_set;
    const wrongRs = higRvolOnly(); (wrongRs.payload as Record<string, unknown>).rule_set = 'RBTS-L-001';
    const wrongName = higRvolOnly(); wrongName.alert.alertName = 'RB v1 SHORT Setup (old)';
    const ftnt = asAudited(rec('FTNT-S-1030'), 'FTNT', 'RBTS-S-001', 'RB v1 SHORT Setup');
    const kkr = asAudited(rec('FTNT-S-1030'), 'KKR', 'RBTS-S-001', 'RB v1 SHORT Setup');
    for (const [n, r] of [['no rule_set', noRs], ['wrong rule_set', wrongRs], ['wrong name', wrongName], ['FTNT', ftnt], ['KKR', kkr]] as const) expect([n, accepted(r)]).toEqual([n, false]);
  });
  it('expired configuration (alert after 2026-12-06 17:00 ET) and pre-audit alert (real Nov 6 timing) → refused', () => {
    expect(accepted(asAudited(rec('FTNT-S-1030'), 'HIG', 'RBTS-S-001', 'RB v1 SHORT Setup', 5))).toBe(false); // ~Dec 11
    expect(accepted(asAudited(rec('FTNT-S-1030'), 'HIG', 'RBTS-S-001', 'RB v1 SHORT Setup', 0))).toBe(false); // Nov 6 10:30 < audit
  });
  it('terminal alert cannot revive: frozen alert-time DATA REVIEW stays DATA REVIEW', () => {
    const r = higRvolOnly();
    const frozen = { [r.id]: { v11: { decision: 'DATA REVIEW REQUIRED', detail: 'DATA MISMATCH — MANUAL REVIEW' } } } as unknown as AlertSnapshotMap;
    expect(accepted(r)).toBe(true);
    expect(accepted(r, undefined, frozen)).toBe(false);
  });
  it('Q LONG 14:40 shape (RVOL + invalid candle) as an audited Q alert → still blocked', () => {
    const q = asAudited(rec('Q-L-144006'), 'Q', 'RBTS-L-001', 'RB v1 LONG Setup');
    expect(accepted(q)).toBe(false);
  });
  it('accepted SYNTHETIC HIG alert: no ticket below 85, RVOL points from SIP (0/15), plan identical to the RVOL-reproduced twin', () => {
    const r = higRvolOnly();
    const twin = structuredClone(r);
    twin.snapshot!.alertConditions = twin.snapshot!.alertConditions.map((c) => (c.label === 'RVOL20 > 1.5' ? { ...c, pass: true } : c));
    twin.snapshot!.issues = twin.snapshot!.issues.filter((i) => i.code !== 'ALERT_NOT_REPRODUCED');
    const q = (x: AutoAlertRecord, a: boolean): QueueRow => {
      const now = Date.parse(x.processedIso!) + 4_000;
      const quotes: Record<string, LiveQuote> = { [x.alert.symbol]: { ...x.initialQuote!, tradeIso: new Date(now - 1500).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 } };
      return buildQueue({ records: [structuredClone(x)], candidates: [], positions: [], quotes, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify: (s) => KNOWN_CLASSIFICATIONS[s] ?? { sector: `S-${s}`, industry: `I-${s}`, theme: '' }, parity: {}, strategyVersion: 'RB v1.1', frozen: {}, terminal: {}, rvolPolicy: a ? { a: true } : null }).rows[0];
    };
    const on = q(r, true);
    const t = q(twin, false);
    expect(on.rvolPolicy?.configuration.configId).toBe('RBTS-S-001@2026-11-06/HIG');
    expect(JSON.stringify([on.decision, on.ranked, on.candidate, on.lifecycle])).toBe(JSON.stringify([t.decision, t.ranked, t.candidate, t.lifecycle]));
    expect(on.ranked!.components.find((k) => k.key === 'rvol')!.points).toBe(0);
    expect(on.decision.ticket).toBeNull();
    // Policy A OFF: the same alert stays DATA REVIEW
    expect(q(r, false).decision.decision).toBe('DATA REVIEW REQUIRED');
  });
});
