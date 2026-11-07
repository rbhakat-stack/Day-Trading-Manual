/**
 * Policy B final safety review: a NEWLY RECEIVED, fully valid, audited RVOL-only exception scoring 81–84 is actionable
 * under A + B through the whole pipeline (first pass → alert-time freeze → later passes), exactly as the App runs it.
 * SYNTHETIC cases from the real SWKS-L-144513 record (2026-11-05 14:45): RVOL set to exactly 1.5 (6/15 points, "RVOL20 >
 * 1.5" not reproduced), close at the high, RSI 66 and the open lowered to reach the target total. The low (stop) and
 * every other input are unchanged; all scores come from the unchanged engine.
 */
import { describe, expect, it } from 'vitest';
import FX from './rvol-policy-b-2026-11-05.json';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue, type QueueInput, type QueueRow } from '../liveQueue';
import { effectiveRvolPolicy } from '../rvolPolicy';
import { EXPECTED_CONDITIONS, type VerifiedTsConfiguration } from '../tsConfigRegistry';
import { freezeAlertSnapshots, type AlertSnapshotMap } from '../lifecycle/alertTimeSnapshot';
import { v12MaxScore } from '../v12/v12Thresholds';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import { KNOWN_CLASSIFICATIONS } from '../../ranker/correlationRules';
import type { Candidate, ManualPosition } from '../../ranker/opportunityTypes';
import { RB_V1_DEFAULTS } from '../../settings';

const RK = cloneRankerDefaults();
const V12MAX = v12MaxScore(RK);
const ID = 'SWKS-L-144513';
const REG: VerifiedTsConfiguration[] = [{ id: 'RBTS-L-001@TEST/SWKS', ruleSet: 'RBTS-L-001', direction: 'LONG', alertName: 'RB v1 LONG Setup', symbols: ['SWKS'], conditionsAsSaved: EXPECTED_CONDITIONS.LONG, vwapBasis: 'TS_VWAP_14_0_HLC3', ts15mCandle: 'UNCONFIRMED', settings: { allConditionsAnd: true, signalTimeframe5m: true, triggerOnCandleClose: true, extendedHoursOff: true, webhookToRbEndpoint: true }, auditedAtMs: Date.parse('2026-11-04T05:00:00Z'), validUntilMs: Date.parse('2026-11-20T05:00:00Z'), evidence: 'SYNTHETIC', auditedBy: 'TEST' }];
const OPEN_FOR: Record<number, number> = { 81: 82.1, 82: 82.0, 83: 81.95, 84: 81.85 };
/** SYNTHETIC audited RVOL-only exception with the requested total (RVOL 1.5 → 6/15; not reproduced; everything else passes). */
function exception(total: 79 | 81 | 82 | 83 | 84): AutoAlertRecord {
  const r = structuredClone((FX.records as unknown as AutoAlertRecord[]).find((x) => x.id.startsWith(ID))!);
  const v = r.snapshot!.values!;
  if (total === 79) { v.close = +(v.close + (v.high - v.close) * 0.5).toFixed(4); } else { v.close = v.high; v.rsi = 66; v.open = OPEN_FOR[total]; }
  v.rvol = 1.5;
  r.payload = { ...r.payload, rule_set: 'RBTS-L-001' };
  r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (c.label === 'RVOL20 > 1.5' ? { ...c, pass: false } : c));
  r.snapshot!.issues = [{ kind: 'REVIEW', code: 'ALERT_NOT_REPRODUCED', message: 'TrendSpider fired the LONG alert, but RVOL20 > 1.5 is not reproduced.' }];
  r.enrichmentAudit = [{ attempt: 1, atIso: r.processedIso!, outcome: 'OK', detail: 'Signal candle 14:40–14:45 ET verified complete (5 of 5 minutes, 5-minute bar = 1-minute aggregate).' }] as AutoAlertRecord['enrichmentAudit'];
  return r;
}
/** SYNTHETIC: the same 82 setup as an ORDINARY alert (RVOL reproduced at 1.5 → 6/15 too; no review issue). */
function ordinary82(): AutoAlertRecord {
  const r = exception(82);
  r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (c.label === 'RVOL20 > 1.5' ? { ...c, pass: true } : c));
  r.snapshot!.issues = [];
  return r;
}
type Flags = { a: boolean; b: boolean };
const S1: Flags = { a: false, b: false };
const S2: Flags = { a: true, b: false };
const S3: Flags = { a: true, b: true };
function input(recs: AutoAlertRecord[], f: Flags, o: { now?: number; frozen?: AlertSnapshotMap; candidates?: Candidate[]; positions?: ManualPosition[] } = {}): QueueInput {
  const now = o.now ?? Date.parse(recs[0].processedIso!) + 4_000;
  const quotes: Record<string, LiveQuote> = {};
  for (const r of recs) quotes[r.alert.symbol] = { ...r.initialQuote!, tradeIso: new Date(now - 1500).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 };
  const eff = effectiveRvolPolicy(f);
  return { records: recs, candidates: o.candidates ?? [], positions: o.positions ?? [], quotes, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify: (s) => KNOWN_CLASSIFICATIONS[s] ?? { sector: `S-${s}`, industry: `I-${s}`, theme: '' }, parity: {}, strategyVersion: 'RB v1.1', frozen: o.frozen ?? {}, terminal: {}, rvolPolicy: eff.a ? { a: true, b: eff.b, registry: REG } : null };
}
/** The App's loop: evaluate → freeze alert-time snapshots → next pass with the frozen map and persisted candidates. */
function passes(rec: () => AutoAlertRecord, flagsPerPass: Flags[], stepMs = 60_000) {
  let frozen: AlertSnapshotMap = {};
  let candidates: Candidate[] = [];
  const t0 = Date.parse(rec().processedIso!) + 4_000;
  return flagsPerPass.map((f, i) => {
    const out = buildQueue(input([rec()], f, { now: t0 + i * stepMs, frozen, candidates }));
    frozen = freezeAlertSnapshots(frozen, out.rows, t0 + i * stepMs, V12MAX).map;
    candidates = out.candidates;
    return { row: out.rows[0], frozen };
  });
}
const plan = (x: QueueRow) => x.candidate && [x.candidate.entry, x.candidate.stop, x.candidate.target, x.candidate.shares, x.candidate.plannedRisk, x.candidate.orderType, x.candidate.atr];

describe('a newly received approved 82-point RVOL exception is actionable under A + B', () => {
  it('first pass: score 82, tier WATCHLIST, TRADE READY with a BUY STOP ticket; alert-time snapshot records that decision', () => {
    const [p1] = passes(() => exception(82), [S3]);
    expect([p1.row.ranked!.total, p1.row.ranked!.tier]).toEqual([82, 'WATCHLIST']);
    expect(p1.row.rvolPolicy).toMatchObject({ policy: 'A+B', effectiveMinScore: 80 });
    expect(p1.row.decision.decision).toBe('HIGH PRIORITY — TRADE CONSIDERATION');
    expect(p1.row.decision.detail).toMatch(/RVOL exception \(minimum 80\)/);
    expect(p1.row.decision.ticket).toMatchObject({ action: 'BUY', orderType: 'STOP' });
    expect(p1.row.lifecycle.finalActionability).toBe('READY');
    expect(p1.frozen[p1.row.record.id]!.v11.decision).toBe('HIGH PRIORITY — TRADE CONSIDERATION');
    expect(p1.frozen[p1.row.record.id]!.v11.detail).not.toMatch(/below the 85 trade threshold/);
  });
  it('NOT permanently rejected by an 85 check: later passes (with the frozen snapshot and persisted candidate) keep the ticket while valid', () => {
    const ps = passes(() => exception(82), [S3, S3, S3], 60_000);
    for (const p of ps) { expect(p.row.decision.ticket).not.toBeNull(); expect(p.row.lifecycle.finalActionability).toBe('READY'); }
  });
  it('81 / 83 / 84 behave the same (tier WATCHLIST, actionable only under A + B)', () => {
    for (const t of [81, 83, 84] as const) {
      const [s3] = passes(() => exception(t), [S3]);
      const [s2] = passes(() => exception(t), [S2]);
      expect([t, s3.row.ranked!.total, s3.row.ranked!.tier, !!s3.row.decision.ticket]).toEqual([t, t, 'WATCHLIST', true]);
      expect([t, s2.row.decision.decision, !!s2.row.decision.ticket]).toEqual([t, 'WATCHLIST', false]);
    }
  });
  it('plan (entry / stop / target / qty / risk / order type / ATR), score and tier identical under STATE 2 and STATE 3', () => {
    const [a] = passes(() => exception(82), [S2]);
    const [b] = passes(() => exception(82), [S3]);
    expect(JSON.stringify([plan(a.row), a.row.ranked!.total, a.row.ranked!.tier, a.row.ranked!.components])).toBe(JSON.stringify([plan(b.row), b.row.ranked!.total, b.row.ranked!.tier, b.row.ranked!.components]));
  });
});

describe('what never becomes actionable', () => {
  it('a NORMAL alert scoring 82 stays below the 85 standard (WATCHLIST — production’s decision for 80–84.9; no ticket) in every state', () => {
    for (const f of [S1, S2, S3]) {
      const [p] = passes(ordinary82, [f]);
      expect([JSON.stringify(f), p.row.ranked!.total, p.row.decision.decision, p.row.decision.ticket]).toEqual([JSON.stringify(f), 82, 'WATCHLIST', null]);
      expect(p.row.decision.detail).toMatch(/below the 85 trade threshold/);
    }
  });
  it('an approved RVOL exception scoring 79 stays SKIP under A + B', () => {
    const [p] = passes(() => exception(79), [S3]);
    expect([p.row.ranked!.total, p.row.decision.decision, p.row.decision.ticket]).toEqual([79, 'SKIP', null]);
  });
  it('previously REJECTED under STATE 2 (frozen "below the 85 trade threshold") → turning B ON later never revives it', () => {
    const ps = passes(() => exception(82), [S2, S3, S3]);
    expect(ps[0].row.decision.decision).toBe('WATCHLIST');
    expect(ps[0].frozen[ps[0].row.record.id]!.v11.detail).toMatch(/below the 85 trade threshold/);
    expect(ps[1].row.decision.ticket).toBeNull();
    expect(ps[2].row.decision.ticket).toBeNull();
  });
  it('previously DATA REVIEW under STATE 1 → turning A and B ON later never revives it', () => {
    const ps = passes(() => exception(82), [S1, S3]);
    expect(ps[0].row.decision.decision).toBe('DATA REVIEW REQUIRED');
    expect(ps[1].row.decision.decision).toBe('DATA REVIEW REQUIRED');
    expect(ps[1].row.decision.ticket).toBeNull();
  });
  it('terminal: expired (10-minute window passed) → no ticket, stays terminal under A + B', () => {
    const ps = passes(() => exception(82), [S3, S3], 11 * 60_000);
    expect(ps[1].row.decision.ticket === null || ps[1].row.lifecycle.finalActionability !== 'READY').toBe(true);
    expect(ps[1].row.lifecycle.terminal).toBe(true);
  });
  it('other mandatory checks still block the 82 exception: candle, VWAP, completed 15m, RSI, no rule_set, unregistered ticker', () => {
    const muts: [string, (r: AutoAlertRecord) => void][] = [
      ['candle', (r) => { r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (c.label.startsWith('Close') ? { ...c, pass: false } : c)); }],
      ['vwap', (r) => { r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (/^5m Close [<>] VWAP/.test(c.label) ? { ...c, pass: false } : c)); }],
      ['15m', (r) => { r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (/^15m/.test(c.label) ? { ...c, pass: false } : c)); }],
      ['rsi', (r) => { r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (c.label.startsWith('RSI14') ? { ...c, pass: false } : c)); }],
      ['no rule_set', (r) => { delete (r.payload as Record<string, unknown>).rule_set; }],
      ['unregistered', (r) => { r.alert.symbol = 'KKR'; (r.payload as Record<string, unknown>).symbol = 'KKR'; }],
    ];
    for (const [n, m] of muts) { const [p] = passes(() => { const r = exception(82); m(r); return r; }, [S3]); expect([n, p.row.decision.ticket]).toEqual([n, null]); }
  });
  it('execution safeguards still block the 82 exception: after 15:30 ET, stale quote, chased price, portfolio full', () => {
    const late = exception(82);
    const t = Date.parse('2026-11-05T15:35:10-05:00');
    Object.assign(late, { receivedMs: t, receivedIso: new Date(t).toISOString(), processedIso: new Date(t + 1000).toISOString() });
    Object.assign(late.alert, { alertTimeMs: t, alertTimeIso: new Date(t).toISOString() });
    expect(buildQueue(input([late], S3)).rows[0].decision.ticket).toBeNull();
    const stale = input([exception(82)], S3);
    for (const k of Object.keys(stale.quotes)) stale.quotes[k] = { ...stale.quotes[k], receivedMs: stale.now - 600_000 };
    expect(buildQueue(stale).rows[0].decision.ticket).toBeNull();
    const chased = input([exception(82)], S3);
    for (const k of Object.keys(chased.quotes)) chased.quotes[k] = { ...chased.quotes[k], price: chased.quotes[k].price + 5 };
    expect(buildQueue(chased).rows[0].decision.ticket).toBeNull();
    const full: ManualPosition[] = [0, 1, 2, 3].map((i) => ({ id: `P${i}`, ticker: `ZZ${i}`, direction: 'LONG', sector: `O-${i}`, industry: `O-${i}`, theme: '', positionValue: 5_000, plannedRisk: 50, entry: 10, stop: 9, target: 12, status: 'OPEN' }));
    expect(buildQueue(input([exception(82)], S3, { positions: full })).rows[0].decision.ticket).toBeNull();
  });
});
