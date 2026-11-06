/**
 * Policy B — the three operating states, flag rollback and score boundaries. Built on the SYNTHETIC SWKS 14:45 cases of
 * rvolPolicyB.test.ts (real 2026-11-05 records; validated RVOL-only discrepancy; boundary scores 80.0 / 79.0) plus the
 * ordinary SWKS 14:35 alert (RVOL reproduced, production score ≥ 85). Synthetic audited registry (the production
 * entries start 2026-11-06 17:00 ET).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import FX from './rvol-policy-b-2026-11-05.json';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue, type QueueInput, type QueueRow } from '../liveQueue';
import { effectiveRvolPolicy, RVOL_EXCEPTION_MIN_SCORE } from '../rvolPolicy';
import { EXPECTED_CONDITIONS, type VerifiedTsConfiguration } from '../tsConfigRegistry';
import { classifyScore, decide, tradeEligibleByScore } from '../../ranker/candidateRanker';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import { KNOWN_CLASSIFICATIONS } from '../../ranker/correlationRules';
import { RB_V1_DEFAULTS } from '../../settings';
import type { AlertSnapshotMap } from '../lifecycle/alertTimeSnapshot';

const RK = cloneRankerDefaults();
const ALL = FX.records as unknown as AutoAlertRecord[];
const orig = (id: string) => structuredClone(ALL.find((r) => r.id.startsWith(id))!) as AutoAlertRecord;
function discrepancy(id: string, closeToHigh = 1): AutoAlertRecord {
  const r = orig(id);
  const v = r.snapshot!.values!;
  v.close = +(v.close + (v.high - v.close) * closeToHigh).toFixed(4);
  r.payload = { ...r.payload, rule_set: 'RBTS-L-001' };
  v.rvol = 1.5;
  r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (c.label === 'RVOL20 > 1.5' ? { ...c, pass: false } : c));
  r.snapshot!.issues = [{ kind: 'REVIEW', code: 'ALERT_NOT_REPRODUCED', message: 'TrendSpider fired the LONG alert, but RVOL20 > 1.5 is not reproduced.' }];
  r.enrichmentAudit = [{ attempt: 1, atIso: r.processedIso!, outcome: 'OK', detail: 'Signal candle 14:40–14:45 ET verified complete (5 of 5 minutes, 5-minute bar = 1-minute aggregate).' }] as AutoAlertRecord['enrichmentAudit'];
  return r;
}
const REG: VerifiedTsConfiguration[] = [{ id: 'RBTS-L-001@TEST/SWKS', ruleSet: 'RBTS-L-001', direction: 'LONG', alertName: 'RB v1 LONG Setup', symbols: ['SWKS'], conditionsAsSaved: EXPECTED_CONDITIONS.LONG, vwapBasis: 'TS_VWAP_14_0_HLC3', ts15mCandle: 'UNCONFIRMED', settings: { allConditionsAnd: true, signalTimeframe5m: true, triggerOnCandleClose: true, extendedHoursOff: true, webhookToRbEndpoint: true }, auditedAtMs: Date.parse('2026-11-04T05:00:00Z'), validUntilMs: Date.parse('2026-11-20T05:00:00Z'), evidence: 'SYNTHETIC', auditedBy: 'TEST' }];
type Flags = { a?: boolean; b?: boolean } | null;
function input(records: AutoAlertRecord[], flags: Flags, o: { now?: number; frozen?: AlertSnapshotMap; candidates?: QueueInput['candidates'] } = {}): QueueInput {
  const now = o.now ?? Math.max(...records.map((r) => Date.parse(r.processedIso ?? r.receivedIso))) + 4_000;
  const quotes: Record<string, LiveQuote> = {};
  for (const r of records) if (r.initialQuote) quotes[r.alert.symbol] = { ...r.initialQuote, tradeIso: new Date(now - 1500).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 };
  const eff = effectiveRvolPolicy(flags); // exactly as the App wires it
  return { records, candidates: o.candidates ?? [], positions: [], quotes, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify: (s) => KNOWN_CLASSIFICATIONS[s] ?? { sector: `S-${s}`, industry: `I-${s}`, theme: '' }, parity: {}, strategyVersion: 'RB v1.1', frozen: o.frozen ?? {}, terminal: {}, rvolPolicy: eff.a ? { a: true, b: eff.b, registry: REG } : null };
}
const S1: Flags = { a: false, b: false };
const S2: Flags = { a: true, b: false };
const S3: Flags = { a: true, b: true };
const INVALID: Flags = { a: false, b: true };
const row = (i: QueueInput, id: string) => buildQueue(i).rows.find((r) => r.record.id.startsWith(id))!;
const plan = (r: QueueRow) => { const c = r.candidate; return c && [c.entry, c.stop, c.target, c.shares, c.plannedRisk, c.positionValue, c.orderType, c.atr]; };
const EXC = 'SWKS-L-144513';
const ORD = 'SWKS-L-143512';

describe('three operating states', () => {
  it('STATE 1 (A OFF, B OFF): the unchanged engine — output byte-identical to no policy at all', () => {
    const recs = [discrepancy(EXC), orig(ORD)];
    expect(JSON.stringify(buildQueue(input(recs, S1)))).toBe(JSON.stringify(buildQueue({ ...input(recs, S1), rvolPolicy: undefined })));
    expect(row(input(recs, S1), EXC).decision.decision).toBe('DATA REVIEW REQUIRED');
  });
  it('B ON with A OFF ≡ STATE 1 (invalid configuration → both OFF, warning surfaced)', () => {
    const recs = [discrepancy(EXC), orig(ORD)];
    expect(JSON.stringify(buildQueue(input(recs, INVALID)))).toBe(JSON.stringify(buildQueue(input(recs, S1))));
    expect(effectiveRvolPolicy(INVALID)).toMatchObject({ a: false, b: false });
    expect(effectiveRvolPolicy(INVALID).warning).toMatch(/Policy B is enabled without Policy A/);
    for (const f of [S1, S2, S3]) expect(effectiveRvolPolicy(f).warning).toBeNull();
  });
  it('STATE 2 (A only): B flag OFF ≡ B absent — exactly the existing Policy A behaviour; the 80 exception alert stays WATCHLIST, no ticket', () => {
    const recs = [discrepancy(EXC), orig(ORD)];
    expect(JSON.stringify(buildQueue(input(recs, S2)))).toBe(JSON.stringify(buildQueue({ ...input(recs, S2), rvolPolicy: { a: true, registry: REG } })));
    const x = row(input(recs, S2), EXC);
    expect(x.rvolPolicy).toMatchObject({ policy: 'A', effectiveMinScore: 85 });
    expect([x.ranked!.total, x.ranked!.tier, x.decision.decision, x.decision.ticket]).toEqual([80, 'WATCHLIST', 'WATCHLIST', null]);
  });
  it('STATE 3 (A + B): the validated 80 alert is actionable at the conditional minimum; tier stays WATCHLIST (never HIGH / ELITE)', () => {
    const x = row(input([discrepancy(EXC), orig(ORD)], S3), EXC);
    expect(x.rvolPolicy).toMatchObject({ policy: 'A+B', effectiveMinScore: RVOL_EXCEPTION_MIN_SCORE });
    expect([x.ranked!.total, x.ranked!.tier]).toEqual([80, 'WATCHLIST']);
    expect(x.decision.decision).toBe('HIGH PRIORITY — TRADE CONSIDERATION');
    expect(x.decision.detail).toMatch(/RVOL exception \(minimum 80\)/);
    expect(x.decision.ticket).not.toBeNull();
  });
  it('the ordinary alert (RVOL reproduced) is decided identically in all three states; its ≥ 85 rule never changes', () => {
    const recs = [discrepancy(EXC), orig(ORD)];
    const k = (f: Flags) => { const x = row(input(recs, f), ORD); return JSON.stringify([x.decision, x.ranked!.total, x.ranked!.tier, plan(x)]); };
    expect(k(S2)).toBe(k(S1));
    expect(k(S3)).toBe(k(S1));
  });
  it('no score, tier, component or plan change attributable to B (S2 vs S3, every row)', () => {
    const recs = [discrepancy(EXC), orig(ORD), discrepancy(EXC, 0.5)].map((r, i) => (i === 2 ? { ...r, id: `${r.id}-half`, dedupeKey: `${r.dedupeKey}-half` } : r));
    const a = buildQueue(input(recs, S2)).rows;
    const b = buildQueue(input(recs, S3)).rows;
    for (let i = 0; i < a.length; i++) expect(JSON.stringify([a[i].ranked?.total, a[i].ranked?.tier, a[i].ranked?.components, plan(a[i])])).toBe(JSON.stringify([b[i].ranked?.total, b[i].ranked?.tier, b[i].ranked?.components, plan(b[i])]));
  });
});

describe('score boundaries (inclusive ≥ on the true one-decimal total; tiers unchanged)', () => {
  const g = RK.grades;
  const cases: [number, string, boolean, boolean][] = [
    // score, tier, eligible as a Policy-B exception, eligible as an ordinary alert
    [79, 'LOW_PRIORITY', false, false], [79.9, 'LOW_PRIORITY', false, false], [80, 'WATCHLIST', true, false], [82, 'WATCHLIST', true, false],
    [84, 'WATCHLIST', true, false], [84.9, 'WATCHLIST', true, false], [85, 'HIGH_PRIORITY', true, true], [90, 'ELITE', true, true],
  ];
  it('tier classification is the unchanged production classifier (82 stays WATCHLIST, not ELITE)', () => {
    for (const [s, tier] of cases) expect([s, classifyScore(s, RK)]).toEqual([s, tier]);
    expect(g).toEqual({ elite: 90, high: 85, watchlist: 80, low: 75 });
  });
  it('trade eligibility: exception ≥ 80; ordinary ≥ 85', () => {
    for (const [s, tier, exc, ord] of cases) {
      expect([s, 'exception', tradeEligibleByScore(s, tier as never, RVOL_EXCEPTION_MIN_SCORE)]).toEqual([s, 'exception', exc]);
      expect([s, 'ordinary', tradeEligibleByScore(s, tier as never, null)]).toEqual([s, 'ordinary', ord]);
    }
  });
  it('Ranker recommendation for allocated candidates: exception 80–84.9 → TRADE NOW — HIGH PRIORITY; ordinary 80–84.9 → WATCHLIST / RESERVE; 79 → LOW PRIORITY; 85 → HIGH; 90 → ELITE', () => {
    const base = { strategyFails: [], missing: [], portfolioFails: [], allocation: { allocated: true } as never };
    for (const [s, tier, exc] of cases) {
      const withExc = decide({ ...base, tier: tier as never, tradeEligible: tradeEligibleByScore(s, tier as never, RVOL_EXCEPTION_MIN_SCORE) });
      const ordinary = decide({ ...base, tier: tier as never });
      const want = tier === 'ELITE' ? 'TRADE NOW — ELITE' : exc ? 'TRADE NOW — HIGH PRIORITY' : tier === 'LOW_PRIORITY' ? 'LOW PRIORITY' : 'WATCHLIST / RESERVE';
      expect([s, withExc]).toEqual([s, want]);
      expect([s, ordinary]).toEqual([s, tier === 'ELITE' ? 'TRADE NOW — ELITE' : tier === 'HIGH_PRIORITY' ? 'TRADE NOW — HIGH PRIORITY' : tier === 'WATCHLIST' ? 'WATCHLIST / RESERVE' : 'LOW PRIORITY']);
    }
  });
  it('full pipeline: validated 79.0 → SKIP in every state; 80.0 → ticket only in STATE 3', () => {
    const r79 = discrepancy(EXC, 0.5);
    for (const f of [S2, S3]) { const x = row(input([r79], f), EXC); expect([x.ranked!.total, x.decision.decision, x.decision.ticket]).toEqual([79, 'SKIP', null]); }
    expect(row(input([discrepancy(EXC)], S2), EXC).decision.ticket).toBeNull();
    expect(row(input([discrepancy(EXC)], S3), EXC).decision.ticket).not.toBeNull();
  });
});

describe('B never widens what A accepts', () => {
  it('another indicator failed, VWAP failed, completed 15m failed, unregistered ticker, missing rule_set → no exception, no ticket in STATE 3', () => {
    const variants: [string, (r: AutoAlertRecord) => void][] = [
      ['candle', (r) => { r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (c.label.startsWith('Close') ? { ...c, pass: false } : c)); }],
      ['vwap', (r) => { r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (/^5m Close [<>] VWAP/.test(c.label) ? { ...c, pass: false } : c)); }],
      ['15m', (r) => { r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (/^15m/.test(c.label) ? { ...c, pass: false } : c)); }],
      ['rsi', (r) => { r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (c.label.startsWith('RSI14') ? { ...c, pass: false } : c)); }],
      ['no rule_set', (r) => { delete (r.payload as Record<string, unknown>).rule_set; }],
      ['unregistered ticker', (r) => { r.alert.symbol = 'KKR'; }],
    ];
    for (const [name, m] of variants) {
      const r = discrepancy(EXC); m(r);
      const x = row(input([r], S3), EXC);
      expect([name, x.rvolPolicy ?? null, x.decision.ticket]).toEqual([name, null, null]);
    }
  });
  it('expired (11 min after the alert) → no ticket in STATE 3 (after 15:30 / 16:00 / stale quote: rvolPolicyB.test.ts)', () => {
    const r = discrepancy(EXC);
    expect(row(input([r], S3, { now: r.receivedMs + 11 * 60_000 }), EXC).decision.ticket).toBeNull();
  });
});

describe('functional rollback (flag changes)', () => {
  const recs = () => [discrepancy(EXC), orig(ORD)];
  it('STATE 3 → STATE 2 (B OFF): the exception ticket is withdrawn; output equals STATE 2 exactly', () => {
    expect(row(input(recs(), S3), EXC).decision.ticket).not.toBeNull();
    expect(JSON.stringify(buildQueue(input(recs(), S2)))).toBe(JSON.stringify(buildQueue({ ...input(recs(), S2), rvolPolicy: { a: true, registry: REG } })));
    expect(row(input(recs(), S2), EXC).decision.ticket).toBeNull();
  });
  it('STATE 2 → STATE 1 (A OFF): output equals the unchanged engine exactly', () => {
    expect(JSON.stringify(buildQueue(input(recs(), S1)))).toBe(JSON.stringify(buildQueue({ ...input(recs(), S1), rvolPolicy: undefined })));
  });
  it('an alert frozen at alert time under STATE 3 keeps its RECORDED decision; the LIVE decision follows the current flags (no ticket after rollback); nothing revives later', () => {
    const r = discrepancy(EXC);
    const s3 = row(input([r], S3), EXC);
    const frozen = { [s3.record.id]: { v11: { decision: s3.decision.decision, detail: s3.decision.detail, total: s3.ranked!.total, tier: s3.ranked!.tier } } } as unknown as AlertSnapshotMap;
    const afterRollback = row(input([discrepancy(EXC)], S2, { frozen }), EXC);
    expect(frozen[s3.record.id]!.v11.decision).toBe('HIGH PRIORITY — TRADE CONSIDERATION'); // the record (history) is untouched
    expect(afterRollback.decision.ticket).toBeNull(); // live: no ticket once B is off
    const frozenBelow = { [s3.record.id]: { v11: { decision: 'WATCHLIST', detail: 'Score 80 — below the 85 trade threshold' } } } as unknown as AlertSnapshotMap;
    expect(row(input([discrepancy(EXC)], S3, { frozen: frozenBelow }), EXC).decision.ticket).toBeNull(); // re-enabling B never revives it
  });
  it('a PENDING (user-submitted) order is never changed by any flag state — no automatic broker action', () => {
    const r = discrepancy(EXC);
    const cands = buildQueue(input([r], S3)).candidates.map((c) => ({ ...c, status: 'PENDING' as const }));
    for (const f of [S1, S2, S3]) {
      const x = row(input([discrepancy(EXC)], f, { candidates: cands }), EXC);
      expect([JSON.stringify(f), x.decision.decision]).toEqual([JSON.stringify(f), 'ORDER SUBMITTED']);
      expect(x.decision.ticket).toBeNull();
    }
  });
});

describe('isolation', () => {
  it('the App wires B only through effectiveRvolPolicy and never passes a registry; Policy B code lives only in the expected files', () => {
    const src = (p: string) => readFileSync(join(__dirname, '..', '..', '..', p), 'utf8');
    const app = src('App.tsx');
    expect(app).toMatch(/effectiveRvolPolicy\(\{ a: serverFlags\.rvolPolicyA, b: serverFlags\.rvolPolicyB \}\)/);
    expect(app).toMatch(/rvolPolicy: rvolPolicyA \? \{ a: true, b: rvolPolicyB \} : null/);
    expect(app).not.toMatch(/registry/);
  });
});
