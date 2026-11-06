/**
 * RVOL eligibility POLICY B — conditional minimum score 80, ONLY for validated RVOL-discrepancy alerts (requires Policy A).
 * No archived RVOL-discrepancy alert scored 80–84, so the real record SWKS-L-144513 (2026-11-05 14:45) is turned into
 * SYNTHETIC cases: recognised rule set RBTS-L-001, a verified-complete enrichment audit, RB RVOL set to exactly 1.5
 * (6/15 points; "RVOL20 > 1.5" not reproduced) and the signal-candle close moved toward the high to reach the boundary:
 * close at the high → total 80.0; halfway → total 79.0 (evaluated alone at its alert time). All values come from the
 * unchanged scoring engine. SWKS-L-143512 (production 85, RVOL reproduced) is the ordinary comparison candidate.
 */
import { describe, expect, it } from 'vitest';
import FX from './rvol-policy-b-2026-11-05.json';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue, type QueueInput, type QueueOutput, type QueueRow } from '../liveQueue';
import { effectiveRvolPolicy, prepareRvolPolicy, RVOL_EXCEPTION_MIN_SCORE } from '../rvolPolicy';
import { EXPECTED_CONDITIONS, type VerifiedTsConfiguration } from '../tsConfigRegistry';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import { classifyScore, tradeEligibleByScore } from '../../ranker/candidateRanker';
import { RB_V1_DEFAULTS } from '../../settings';
import { KNOWN_CLASSIFICATIONS } from '../../ranker/correlationRules';
import { gateSequence } from '../lifecycle/executionState';
import type { AlertSnapshotMap } from '../lifecycle/alertTimeSnapshot';

const ALL = FX.records as unknown as AutoAlertRecord[];
const orig = (id: string) => structuredClone(ALL.find((r) => r.id.startsWith(id))!) as AutoAlertRecord;
/** SYNTHETIC: validated RVOL-only discrepancy built from a real record. */
function discrepancy(id: string, closeToHigh = 1): AutoAlertRecord {
  const r = orig(id);
  const v = r.snapshot!.values!;
  v.close = +(v.close + (v.high - v.close) * closeToHigh).toFixed(4); // SYNTHETIC stronger candle (boundary case)
  r.payload = { ...r.payload, rule_set: 'RBTS-L-001' };
  r.snapshot!.values!.rvol = 1.5;
  r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (c.label === 'RVOL20 > 1.5' ? { ...c, pass: false } : c));
  r.snapshot!.issues = [{ kind: 'REVIEW', code: 'ALERT_NOT_REPRODUCED', message: 'TrendSpider fired the LONG alert, but the automated values do not satisfy: RVOL20 > 1.5. Data feeds or indicator settings may differ.' }];
  r.enrichmentAudit = [{ attempt: 1, atIso: r.processedIso!, outcome: 'OK', detail: 'Signal candle 14:40–14:45 ET verified complete (5 of 5 minutes, 5-minute bar = 1-minute aggregate).' }] as AutoAlertRecord['enrichmentAudit'];
  return r;
}
/** SYNTHETIC audited registry for these Nov 5 cases (the production SWKS entry starts 2026-11-06 17:00 ET). */
const TEST_REG: VerifiedTsConfiguration[] = [{ id: 'RBTS-L-001@TEST/SWKS', ruleSet: 'RBTS-L-001', direction: 'LONG', alertName: 'RB v1 LONG Setup', symbols: ['SWKS'], conditionsAsSaved: EXPECTED_CONDITIONS.LONG, vwapBasis: 'TS_VWAP_14_0_HLC3', ts15mCandle: 'UNCONFIRMED', settings: { allConditionsAnd: true, signalTimeframe5m: true, triggerOnCandleClose: true, extendedHoursOff: true, webhookToRbEndpoint: true }, auditedAtMs: Date.parse('2026-11-04T05:00:00Z'), validUntilMs: Date.parse('2026-11-20T05:00:00Z'), evidence: 'SYNTHETIC', auditedBy: 'TEST' }];
const classify = (s: string) => KNOWN_CLASSIFICATIONS[s] ?? { sector: `Sector-${s}`, industry: `Industry-${s}`, theme: '' };
function input(records: AutoAlertRecord[], flags: { a?: boolean; b?: boolean } | null, o: { now?: number; frozen?: AlertSnapshotMap; candidates?: QueueInput['candidates'] } = {}): QueueInput {
  const now = o.now ?? Math.max(...records.map((r) => Date.parse(r.processedIso ?? r.receivedIso))) + 4_000;
  const quotes: Record<string, LiveQuote> = {};
  for (const r of records) if (r.initialQuote) quotes[r.alert.symbol] = { ...r.initialQuote, tradeIso: new Date(now - 1500).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 };
  const eff = effectiveRvolPolicy(flags);
  return { records, candidates: o.candidates ?? [], positions: [], quotes, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify, parity: {}, strategyVersion: 'RB v1.1', frozen: o.frozen ?? {}, terminal: {}, rvolPolicy: eff.a ? { a: true, b: eff.b, registry: TEST_REG } : null };
}
const row = (o: QueueOutput, id: string) => o.rows.find((r) => r.record.id === id)!;
const plan = (r: QueueRow) => { const c = r.candidate; return c && [c.entry, c.stop, c.target, c.shares, c.plannedRisk, c.positionValue, c.orderType, c.atr]; };
const rvolPts = (r: QueueRow) => r.ranked?.components.find((k) => k.key === 'rvol')?.points ?? null;

describe('flag state matrix', () => {
  it('A OFF / B OFF → existing; A ON / B OFF → A; A ON / B ON → A+B; A OFF / B ON → invalid → both OFF + warning', () => {
    expect(effectiveRvolPolicy({ a: false, b: false })).toEqual({ a: false, b: false, warning: null });
    expect(effectiveRvolPolicy({ a: true, b: false })).toEqual({ a: true, b: false, warning: null });
    expect(effectiveRvolPolicy({ a: true, b: true })).toEqual({ a: true, b: true, warning: null });
    const inv = effectiveRvolPolicy({ a: false, b: true });
    expect([inv.a, inv.b]).toEqual([false, false]);
    expect(inv.warning).toMatch(/invalid configuration/);
    expect(effectiveRvolPolicy({ a: null, b: true }).b).toBe(false); // unknown A = OFF → B cannot apply
  });
  it('B without A produces output byte-identical to production (fail closed)', () => {
    const r = discrepancy('SWKS-L-144513');
    expect(JSON.stringify(buildQueue(input([r], { a: false, b: true })))).toBe(JSON.stringify(buildQueue(input([r], null))));
  });
});

describe('score boundaries (true one-decimal total; inclusive ≥)', () => {
  const rk = cloneRankerDefaults();
  const t = (x: number) => classifyScore(x, rk);
  it('validated discrepancy: 79.99 → no; 80.00 → yes; 82 → yes; 84.99 → yes; 85.00 → yes (normal tier)', () => {
    expect(tradeEligibleByScore(79.99, t(79.99), RVOL_EXCEPTION_MIN_SCORE)).toBe(false);
    expect(tradeEligibleByScore(79.9, t(79.9), RVOL_EXCEPTION_MIN_SCORE)).toBe(false);
    expect(tradeEligibleByScore(80, t(80), RVOL_EXCEPTION_MIN_SCORE)).toBe(true);
    expect(tradeEligibleByScore(82, t(82), RVOL_EXCEPTION_MIN_SCORE)).toBe(true);
    expect(tradeEligibleByScore(84.99, t(84.99), RVOL_EXCEPTION_MIN_SCORE)).toBe(true);
    expect(tradeEligibleByScore(85, t(85), RVOL_EXCEPTION_MIN_SCORE)).toBe(true);
  });
  it('no discrepancy: 82 → no; 84.99 → no; 85.00 → yes (existing rule)', () => {
    expect(tradeEligibleByScore(82, t(82), null)).toBe(false);
    expect(tradeEligibleByScore(84.99, t(84.99), null)).toBe(false);
    expect(tradeEligibleByScore(85, t(85), null)).toBe(true);
    expect(tradeEligibleByScore(null, null, RVOL_EXCEPTION_MIN_SCORE)).toBe(false);
    expect(tradeEligibleByScore(Number.NaN, null, RVOL_EXCEPTION_MIN_SCORE)).toBe(false);
  });
  it('tiers are unchanged: 80–84.9 stays WATCHLIST, 85 HIGH_PRIORITY, 90 ELITE', () => {
    expect([t(80), t(84.9), t(85), t(89.9), t(90)]).toEqual(['WATCHLIST', 'WATCHLIST', 'HIGH_PRIORITY', 'HIGH_PRIORITY', 'ELITE']);
  });
});

describe('SYNTHETIC SWKS 14:45 with validated RVOL discrepancy (score 80.0 / 79.0)', () => {
  const id = 'SWKS-L-144513-94bf64';
  it('score 80.0: production → DATA REVIEW; Policy A → WATCHLIST 80 (no ticket); Policy A+B → ticket under the conditional minimum 80', () => {
    const r = discrepancy('SWKS-L-144513');
    const off = row(buildQueue(input([r], null)), id);
    const a = row(buildQueue(input([r], { a: true })), id);
    const ab = row(buildQueue(input([r], { a: true, b: true })), id);
    expect(off.decision.decision).toBe('DATA REVIEW REQUIRED');
    expect(a.decision.decision).toBe('WATCHLIST');
    expect(a.decision.ticket).toBeNull();
    expect(a.ranked!.total).toBe(80);
    expect(ab.ranked!.total).toBe(80); // score unchanged
    expect(ab.ranked!.tier).toBe('WATCHLIST'); // authoritative tier unchanged (no ELITE)
    expect(rvolPts(ab)).toBe(rvolPts(a)); // RVOL points: RB SIP band only
    expect(ab.ranked!.tradeEligible).toBe(true);
    expect(ab.ranked!.effectiveMinScore).toBe(80);
    expect(ab.decision.decision).toBe('HIGH PRIORITY — TRADE CONSIDERATION'); // existing label; never 'TRADE NOW — ELITE'
    expect(ab.decision.detail).toMatch(/RVOL exception \(minimum 80\)/);
    expect(ab.decision.ticket).not.toBeNull();
    expect(plan(ab)).toEqual(plan(a)); // identical trade construction
    expect(ab.rvolPolicy).toMatchObject({ policy: 'A+B', effectiveMinScore: 80 });
    expect(gateSequence(ab).score).toBe('PASS');
    expect(gateSequence(a).score).toBe('FAIL');
  });
  it('score 79.0 with validated discrepancy → SKIP under A and A+B (below 80)', () => {
    const r = discrepancy('SWKS-L-144513', 0.5);
    const a = row(buildQueue(input([r], { a: true })), id);
    const ab = row(buildQueue(input([r], { a: true, b: true })), id);
    expect([a.ranked!.total, ab.ranked!.total]).toEqual([79, 79]);
    expect([a.decision.decision, ab.decision.decision]).toEqual(['SKIP', 'SKIP']);
    expect(ab.decision.ticket).toBeNull();
    expect(ab.ranked!.tradeEligible).toBe(false);
  });
  it('NO discrepancy (same strong-candle 80 alert, RVOL reproduced) → existing WATCHLIST under A+B; ranked identical to production', () => {
    const r = orig('SWKS-L-144513');
    r.payload = { ...r.payload, rule_set: 'RBTS-L-001' };
    r.snapshot!.values!.close = r.snapshot!.values!.high;
    const ab = row(buildQueue(input([r], { a: true, b: true })), id);
    expect(ab.decision.decision).toBe('WATCHLIST');
    expect(ab.ranked!.tradeEligible).toBeUndefined();
    expect(JSON.stringify(ab.ranked)).toBe(JSON.stringify(row(buildQueue(input([r], null)), id).ranked));
  });
  const blocked: [string, (r: AutoAlertRecord) => void][] = [
    ['unverified / unrecognised rule-set configuration', (r) => { r.payload = { ...r.payload, rule_set: 'RBTS-L-999' }; }],
    ['missing rule set', (r) => { delete (r.payload as Record<string, unknown>).rule_set; }],
    ['signal candle not proven final', (r) => { r.enrichmentAudit = []; }],
    ['another hard failure: candle colour not reproduced', (r) => { r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (c.label.startsWith('Close') ? { ...c, pass: false } : c)); }],
  ];
  for (const [name, mutate] of blocked) {
    it(`blocked: 80 + mismatch + ${name} → no ticket`, () => {
      const r = discrepancy('SWKS-L-144513');
      mutate(r);
      const ab = row(buildQueue(input([r], { a: true, b: true })), id);
      expect(ab.decision.ticket).toBeNull();
      expect(ab.rvolPolicy).toBeUndefined();
    });
  }
  it('blocked: after 15:30 ET, after 16:00 ET, expired window, stale quote', () => {
    const at = (hhmmss: string) => { const r = discrepancy('SWKS-L-144513'); const t = Date.parse(`2026-11-05T${hhmmss}-05:00`); r.alert.alertTimeMs = t; r.receivedMs = t; r.processedIso = new Date(t + 1000).toISOString(); return r; };
    for (const r of [at('15:35:10'), at('16:00:20')]) expect(row(buildQueue(input([r], { a: true, b: true })), id).decision.ticket).toBeNull();
    const r = discrepancy('SWKS-L-144513');
    expect(row(buildQueue(input([r], { a: true, b: true }, { now: r.receivedMs + 11 * 60_000 })), id).decision.ticket).toBeNull();
    const q = input([r], { a: true, b: true });
    for (const k of Object.keys(q.quotes)) q.quotes[k] = { ...q.quotes[k], receivedMs: q.now - 600_000 };
    expect(row(buildQueue(q), id).decision.ticket).toBeNull();
  });
  it('no revival: frozen at alert time as "below the 85 trade threshold" (decided without B) → stays WATCHLIST; frozen DATA REVIEW → stays DATA REVIEW', () => {
    const r = discrepancy('SWKS-L-144513');
    const fW = { [id]: { v11: { decision: 'WATCHLIST', detail: 'Score 80 — below the 85 trade threshold' } } } as unknown as AlertSnapshotMap;
    expect(prepareRvolPolicy([r], { a: true, b: true, registry: TEST_REG }, {})!.exception.size).toBe(1); // positive control: B applies when not frozen
    expect(prepareRvolPolicy([r], { a: true, b: true, registry: TEST_REG }, fW)!.exception.size).toBe(0); // frozen "below 85" blocks B
    expect(prepareRvolPolicy([r], { a: true, b: true, registry: TEST_REG }, fW)!.accepted.size).toBe(1); // ...while A still applies (85)
    expect(row(buildQueue(input([r], { a: true, b: true }, { frozen: fW })), id).decision.ticket).toBeNull();
    const fD = { [id]: { v11: { decision: 'DATA REVIEW REQUIRED', detail: 'DATA MISMATCH — MANUAL REVIEW' } } } as unknown as AlertSnapshotMap;
    expect(row(buildQueue(input([r], { a: true, b: true }, { frozen: fD })), id).decision.decision).toBe('DATA REVIEW REQUIRED');
  });
  it('existing position in the ticker (FILLED) → DUPLICATE, never a second ticket', () => {
    const r = discrepancy('SWKS-L-144513');
    const first = buildQueue(input([r], { a: true, b: true }));
    const filled = first.candidates.map((c) => ({ ...c, id: 'SWKS-earlier', status: 'FILLED' as const }));
    const ab = row(buildQueue(input([r], { a: true, b: true }, { candidates: filled })), id);
    expect(ab.decision.detail).toBe('DUPLICATE / EXISTING CANDIDATE');
    expect(ab.decision.ticket).toBeNull();
  });
});

describe('ranker isolation under Policy B', () => {
  it('an 80 RVOL-exception candidate never outranks or pre-empts an ordinary 85 candidate; unrelated scores identical A vs A+B', () => {
    const e = discrepancy('SWKS-L-144513'); // exception, 80
    const h = orig('SWKS-L-143512'); // ordinary 85 (RVOL reproduced), moved into the same window under another ticker
    h.id = 'TEST85-L-144510'; h.alert.symbol = 'TEST85'; h.payload = { ...h.payload, symbol: 'TEST85' };
    h.alert.alertTimeMs = e.alert.alertTimeMs - 3000; h.receivedMs = e.receivedMs - 3000; h.processedIso = new Date(h.receivedMs + 900).toISOString();
    const now = e.receivedMs + 5000;
    const a = buildQueue(input([h, e], { a: true }, { now }));
    const ab = buildQueue(input([h, e], { a: true, b: true }, { now }));
    const H = row(ab, h.id), E = row(ab, e.id);
    expect(JSON.stringify(row(ab, h.id).ranked!.components)).toBe(JSON.stringify(row(a, h.id).ranked!.components));
    expect(H.ranked!.total).toBe(row(a, h.id).ranked!.total);
    expect(H.ranked!.rank!).toBeLessThan(E.ranked!.rank!); // stronger first — ordering by score, never by the exception
    if (H.ranked!.allocation?.allocated === false) expect(E.ranked!.allocation?.allocated).not.toBe(true);
  });
});
