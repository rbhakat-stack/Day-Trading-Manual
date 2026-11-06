/**
 * RVOL eligibility POLICY A — RVOL-only TrendSpider / Alpaca SIP discrepancy becomes a non-blocking warning.
 * Real 2026-11-06 production records: FTNT 10:30 and CARR 11:05 (RVOL-only DATA REVIEW), CTVA and Q 12:30 (RVOL passed).
 */
import { describe, expect, it } from 'vitest';
import FX from './rvol-v1-observation-2026-11-06.json';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue, type QueueInput, type QueueOutput, type QueueRow } from '../liveQueue';
import { effectiveRvolPolicy, prepareRvolPolicy } from '../rvolPolicy';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import { rvolBand } from '../../ranker/opportunityScorer';
import { RB_V1_DEFAULTS } from '../../settings';
import { KNOWN_CLASSIFICATIONS } from '../../ranker/correlationRules';
import { dataStatus } from '../../../components/live/queueView';
import type { AlertSnapshotMap } from '../lifecycle/alertTimeSnapshot';
import { EXPECTED_CONDITIONS, type VerifiedTsConfiguration } from '../tsConfigRegistry';

/** SYNTHETIC audited registry for these tests (production registry is EMPTY → Policy A fails closed; see rvolPolicyAConfig.test.ts). */
const AUDIT = { ts15mCandle: 'COMPLETED' as const, auditedAtMs: Date.parse('2026-11-05T05:00:00Z'), validUntilMs: Date.parse('2026-11-20T05:00:00Z'), vwapBasis: 'SESSION' as const, evidence: 'TEST', auditedBy: 'TEST', settings: { allConditionsAnd: true, signalTimeframe5m: true, triggerOnCandleClose: true, extendedHoursOff: true, webhookToRbEndpoint: true } };
export const TEST_REGISTRY: VerifiedTsConfiguration[] = [
  { ...AUDIT, id: 'RBTS-S-001@TEST', ruleSet: 'RBTS-S-001', direction: 'SHORT', alertName: 'RB v1 SHORT Setup', symbols: ['FTNT', 'CARR', 'CTVA', 'NCLH'], conditionsAsSaved: EXPECTED_CONDITIONS.SHORT },
  { ...AUDIT, id: 'RBTS-L-001@TEST', ruleSet: 'RBTS-L-001', direction: 'LONG', alertName: 'RB v1 LONG Setup', symbols: ['Q', 'NCLH'], conditionsAsSaved: EXPECTED_CONDITIONS.LONG },
];

const ALL = FX.records as unknown as AutoAlertRecord[];
const rec = (p: string) => structuredClone(ALL.find((r) => r.id.startsWith(p))!) as AutoAlertRecord;
const classify = (s: string) => KNOWN_CLASSIFICATIONS[s] ?? { sector: `Sector-${s}`, industry: `Industry-${s}`, theme: '' };
function input(records: AutoAlertRecord[], o: { a?: boolean; now?: number; candidates?: QueueInput['candidates']; frozen?: AlertSnapshotMap; registry?: VerifiedTsConfiguration[] } = {}): QueueInput {
  const now = o.now ?? Math.max(...records.map((r) => Date.parse(r.processedIso ?? r.receivedIso))) + 4_000;
  const quotes: Record<string, LiveQuote> = {};
  for (const r of records) if (r.initialQuote) quotes[r.alert.symbol] = { ...r.initialQuote, tradeIso: new Date(now - 1500).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 };
  return { records, candidates: o.candidates ?? [], positions: [], quotes, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify, parity: {}, strategyVersion: 'RB v1.1', frozen: o.frozen ?? {}, terminal: {}, rvolPolicy: o.a ? { a: true, registry: o.registry ?? TEST_REGISTRY } : null };
}
const row = (o: QueueOutput, id: string) => o.rows.find((r) => r.record.id === id)!;
const authoritative = (r: QueueRow) => JSON.stringify([r.decision, r.ranked, r.candidate, r.live, r.lifecycle, r.blocked ?? null]);
const rvolPts = (r: QueueRow) => r.ranked?.components.find((k) => k.key === 'rvol')?.points ?? null;

describe('flags', () => {
  it('unknown / absent / false → OFF; only true → ON', () => {
    expect(effectiveRvolPolicy(null).a).toBe(false);
    expect(effectiveRvolPolicy({ a: null }).a).toBe(false);
    expect(effectiveRvolPolicy({ a: false }).a).toBe(false);
    expect(effectiveRvolPolicy({ a: true }).a).toBe(true);
  });
  it('Policy A OFF → buildQueue output is byte-identical to the input without the field (unchanged engine)', () => {
    const recs = [rec('FTNT-S-1030'), rec('CARR'), rec('CTVA'), rec('Q-L')];
    const off = buildQueue(input(recs));
    const absent = buildQueue({ ...input(recs), rvolPolicy: undefined });
    expect(JSON.stringify(off)).toBe(JSON.stringify(absent));
    expect(off.rows.every((r) => r.rvolPolicy === undefined)).toBe(true);
  });
});

describe('Policy A ON — validated RVOL-only discrepancy', () => {
  for (const p of ['FTNT-S-1030', 'CARR']) {
    it(`${p}: no DATA REVIEW; same score, same RVOL points (RB SIP, 0/15), warning info attached; Data Status PASS`, () => {
      const r = rec(p);
      const off = row(buildQueue(input([r])), r.id);
      const on = row(buildQueue(input([r], { a: true })), r.id);
      expect(off.decision.decision).toBe('DATA REVIEW REQUIRED');
      expect(on.decision.decision).not.toBe('DATA REVIEW REQUIRED');
      expect(on.ranked!.total).toBe(off.ranked!.total);
      expect(rvolPts(on)).toBe(rvolPts(off));
      expect(rvolPts(on)).toBe(0);
      expect(on.record.snapshot!.values!.rvol).toBe(r.snapshot!.values!.rvol); // RB SIP value untouched
      expect(on.record.snapshot!.alertConditions.find((c) => c.label === 'RVOL20 > 1.5')!.pass).toBe(false); // SIP truth kept
      expect(on.rvolPolicy).toMatchObject({ policy: 'A', effectiveMinScore: 85 });
      expect(dataStatus(on).label).toBe('PASS');
      expect(on.decision.ticket).toBeNull(); // score below 85: the existing threshold decides
      expect(JSON.stringify(on.shadow)).toBe(JSON.stringify(off.shadow)); // v1.2 SHADOW unchanged
    });
  }
  it('trade plan identical: entry, stop, target, quantity, risk, ATR, order type', () => {
    const r = rec('FTNT-S-1030');
    const on = row(buildQueue(input([r], { a: true })), r.id);
    const c = on.candidate!;
    expect([c.entry, c.stop, c.target, c.shares, c.plannedRisk, c.atr, c.orderType]).toEqual([r.calcAtAlert!.entry, r.calcAtAlert!.stop, r.calcAtAlert!.target, r.calcAtAlert!.shares, r.calcAtAlert!.plannedRisk, r.snapshot!.values!.atr, 'SELL STOP']);
  });
  it('RVOL bands unchanged: exactly 1.5 → 6/15 (band ≥ 1.5) although "> 1.5" is not reproduced; 1.49 → 0; 0.2 → 0', () => {
    const rk = cloneRankerDefaults();
    expect(rvolBand(1.5, rk)?.points).toBe(6);
    expect(rvolBand(1.49, rk)).toBeNull();
    expect(rvolBand(0.2, rk)).toBeNull();
    for (const v of [1.5, 1.49, 0.2]) {
      const r = rec('FTNT-S-1030');
      r.snapshot!.values!.rvol = v;
      const on = row(buildQueue(input([r], { a: true })), r.id);
      const off = row(buildQueue(input([r])), r.id);
      expect(rvolPts(on)).toBe(rvolPts(off)); // never inflated
      expect(on.rvolPolicy).toBeTruthy();
    }
  });
  it('UNRELATED alerts are byte-identical (peer pool isolation): CTVA and Q unchanged while FTNT and CARR are accepted', () => {
    const recs = [rec('FTNT-S-1030'), rec('CARR'), rec('CTVA'), rec('Q-L')];
    const now = Math.max(...recs.map((r) => Date.parse(r.processedIso!))) + 4000;
    const off = buildQueue(input(recs, { now }));
    const on = buildQueue(input(recs, { now, a: true }));
    for (const p of ['CTVA', 'Q-L']) {
      const id = recs.find((r) => r.id.startsWith(p))!.id;
      expect(authoritative(row(on, id))).toBe(authoritative(row(off, id)));
    }
  });
});

describe('Policy A fails closed (output identical to OFF)', () => {
  const cases: [string, (r: AutoAlertRecord) => void][] = [
    ['missing rule set', (r) => { delete (r.payload as Record<string, unknown>).rule_set; }],
    ['contradictory rule set / direction', (r) => { (r.payload as Record<string, unknown>).rule_set = 'RBTS-L-001'; }],
    ['unknown rule set (unverified configuration)', (r) => { (r.payload as Record<string, unknown>).rule_set = 'RBTS-S-999'; }],
    ['signal candle not proven final', (r) => { r.enrichmentAudit = []; }],
    ['missing 15m confirmation', (r) => { r.snapshot!.issues.push({ kind: 'INCOMPLETE', code: 'NO_COMPLETED_15M', message: 'x' }); }],
    ['missing volume history (RVOL unavailable)', (r) => { r.snapshot!.values!.rvol = Number.NaN; r.snapshot!.issues.push({ kind: 'INCOMPLETE', code: 'RVOL20_UNAVAILABLE', message: 'x' }); }],
    ['another indicator failed (RSI)', (r) => { r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (c.label.startsWith('RSI14') ? { ...c, pass: false } : c)); }],
    ['separate data-integrity issue', (r) => { r.snapshot!.issues.push({ kind: 'REVIEW', code: 'MISSING_BARS', message: 'x' }); }],
    ['market-data failure', (r) => { r.status = 'DATA_ERROR'; r.errors = ['Alpaca 503']; }],
  ];
  for (const [name, mutate] of cases) {
    it(name, () => {
      const r = rec('FTNT-S-1030');
      mutate(r);
      const off = buildQueue(input([r]));
      const on = buildQueue(input([r], { a: true }));
      expect(JSON.stringify(on.rows.map(authoritative))).toBe(JSON.stringify(off.rows.map(authoritative)));
      expect(on.rows.every((x) => !x.rvolPolicy)).toBe(true);
    });
  }
  it('no revival: an alert frozen at alert time as DATA REVIEW stays DATA REVIEW after Policy A is switched on', () => {
    const r = rec('FTNT-S-1030');
    const frozen = { [r.id]: { v11: { decision: 'DATA REVIEW REQUIRED', detail: 'DATA MISMATCH — MANUAL REVIEW' } } } as unknown as AlertSnapshotMap;
    expect(prepareRvolPolicy([r], { a: true, registry: TEST_REGISTRY }, {})!.accepted.size).toBe(1); // eligible when not frozen
    expect(prepareRvolPolicy([r], { a: true, registry: TEST_REGISTRY }, frozen)!.accepted.size).toBe(0); // frozen DATA REVIEW blocks
    const on = row(buildQueue(input([r], { a: true, frozen })), r.id);
    expect(on.decision.decision).toBe('DATA REVIEW REQUIRED');
  });
  it('inputs are never mutated', () => {
    const recs = [rec('FTNT-S-1030'), rec('CARR')];
    const q = input(recs, { a: true });
    const before = JSON.stringify({ ...q, classify: undefined });
    buildQueue(q);
    expect(JSON.stringify({ ...q, classify: undefined })).toBe(before);
  });
});

describe('lifecycle and portfolio rules still authoritative under Policy A', () => {
  const shift = (r: AutoAlertRecord, hhmmss: string) => {
    const t = Date.parse(`2026-11-06T${hhmmss}-05:00`);
    r.alert.alertTimeMs = t; r.alert.alertTimeIso = new Date(t).toISOString(); r.receivedMs = t; r.receivedIso = new Date(t).toISOString(); r.processedIso = new Date(t + 1000).toISOString();
    return r;
  };
  it('after 15:30 ET and after 16:00 ET → NOT ELIGIBLE', () => {
    for (const t of ['15:35:10', '16:00:20']) {
      const r = shift(rec('FTNT-S-1030'), t);
      expect(row(buildQueue(input([r], { a: true })), r.id).decision.decision).toBe('NOT ELIGIBLE');
    }
  });
  it('expired 10-minute alert → no ticket; stale quote → no ticket', () => {
    const r = rec('FTNT-S-1030');
    expect(row(buildQueue(input([r], { a: true, now: r.receivedMs + 11 * 60_000 })), r.id).decision.ticket).toBeNull();
    const q = input([r], { a: true });
    for (const k of Object.keys(q.quotes)) q.quotes[k] = { ...q.quotes[k], receivedMs: q.now - 600_000 };
    expect(row(buildQueue(q), r.id).decision.ticket).toBeNull();
  });
  it('repeated ticker (D4) and FILLED same-ticker position → DUPLICATE under Policy A too', () => {
    const a = rec('FTNT-S-1030');
    const first = buildQueue(input([a], { a: true }));
    const filled = first.candidates.map((c) => ({ ...c, status: 'FILLED' as const }));
    const b = rec('FTNT-S-1030');
    b.id = 'FTNT-S-103300-dup'; b.dedupeKey = 'dup'; b.receivedMs += 180_000; b.alert.alertTimeMs += 180_000; b.processedIso = new Date(b.receivedMs + 900).toISOString();
    expect(row(buildQueue(input([b], { a: true, candidates: filled })), b.id).decision.detail).toBe('DUPLICATE / EXISTING CANDIDATE');
  });
});
