/**
 * Defect 2 — final safety acceptance (Option C). Real engine end to end (buildQueue → reconcileExposure → ranking →
 * lifecycle); broker states from the PAPER-history fixtures reduced to one symbol; alerts from real archived records
 * (SYNTHETIC adjustments labelled).
 */
import { describe, expect, it } from 'vitest';
import FX from './defect2-broker-positions.fixtures.json';
import PB from './rvol-policy-b-2026-11-05.json';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue, type QueueInput } from '../liveQueue';
import { brokerOrdersFrom } from '../lifecycle/brokerSync';
import { UNPROTECTED_BROKER_POSITION, type BrokerExposureInput } from '../lifecycle/portfolioExposure';
import { freezeAlertSnapshots, type AlertSnapshotMap } from '../lifecycle/alertTimeSnapshot';
import { EXPECTED_CONDITIONS, type VerifiedTsConfiguration } from '../tsConfigRegistry';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import { KNOWN_CLASSIFICATIONS } from '../../ranker/correlationRules';
import { RB_V1_DEFAULTS } from '../../settings';
import type { Candidate } from '../../ranker/opportunityTypes';

type Fixture = { name: string; source: string; asOf: string; ticker: string; expected: { basis: string }; broker: BrokerExposureInput };
const fixtures = FX.fixtures as unknown as Fixture[];
const byName = (re: RegExp) => fixtures.find((f) => re.test(f.name))!;
/** One symbol's broker state (the real 3 Nov state also holds an unrelated CTVA GTC entry that exhausts capital). */
const only = (f: Fixture, sym = 'FIS'): BrokerExposureInput => ({ ...f.broker, orders: (f.broker.orders as { symbol: string }[]).filter((o) => o.symbol === sym), positions: f.broker.positions.filter((p) => p.symbol === sym), openOrders: (f.broker.openOrders as { symbol: string }[]).filter((o) => o.symbol === sym) });
const PROTECTED = () => only(fixtures[0]);
const UNKNOWN = () => only(byName(/protective stop CANCELED/));
const PARTIAL = () => only(byName(/only 300 of 499/));
const SHORT_UNKNOWN = () => only(byName(/SHORT position with no protective/));

const REG: VerifiedTsConfiguration[] = [{ id: 'RBTS-L-001@TEST/SWKS', ruleSet: 'RBTS-L-001', direction: 'LONG', alertName: 'RB v1 LONG Setup', symbols: ['SWKS'], conditionsAsSaved: EXPECTED_CONDITIONS.LONG, vwapBasis: 'TS_VWAP_14_0_HLC3', ts15mCandle: 'UNCONFIRMED', settings: { allConditionsAnd: true, signalTimeframe5m: true, triggerOnCandleClose: true, extendedHoursOff: true, webhookToRbEndpoint: true }, auditedAtMs: Date.parse('2026-11-04T05:00:00Z'), validUntilMs: Date.parse('2026-11-20T05:00:00Z'), evidence: 'SYNTHETIC', auditedBy: 'TEST' }];
const base = () => structuredClone((PB.records as unknown as AutoAlertRecord[]).find((r) => r.id.startsWith('SWKS-L-144513'))!);
/** SYNTHETIC: an ordinary high-scoring LONG (all six conditions reproduced). */
function ordinary(): AutoAlertRecord {
  const r = base(); const v = r.snapshot!.values!;
  v.close = v.high; v.rsi = 66; v.open = 81.85; v.rvol = 3.6; r.snapshot!.issues = [];
  return r;
}
/** SYNTHETIC: the Policy A+B-approved RVOL-only exception scoring 82 (RVOL 1.5 → 6/15, not reproduced; everything else passes). */
function exception82(): AutoAlertRecord {
  const r = base(); const v = r.snapshot!.values!;
  v.close = v.high; v.rsi = 66; v.open = 82.0; v.rvol = 1.5;
  r.payload = { ...r.payload, rule_set: 'RBTS-L-001' };
  r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (c.label === 'RVOL20 > 1.5' ? { ...c, pass: false } : c));
  r.snapshot!.issues = [{ kind: 'REVIEW', code: 'ALERT_NOT_REPRODUCED', message: 'TrendSpider fired the LONG alert, but RVOL20 > 1.5 is not reproduced.' }];
  r.enrichmentAudit = [{ attempt: 1, atIso: r.processedIso!, outcome: 'OK', detail: 'Signal candle 14:40–14:45 ET verified complete (5 of 5 minutes, 5-minute bar = 1-minute aggregate).' }] as AutoAlertRecord['enrichmentAudit'];
  return r;
}
const T0 = (r: AutoAlertRecord) => Date.parse(r.processedIso!) + 4_000;
function input(rec: AutoAlertRecord, broker: BrokerExposureInput | undefined, now: number, o: { frozen?: AlertSnapshotMap; candidates?: Candidate[]; ab?: boolean } = {}): QueueInput {
  const quotes: Record<string, LiveQuote> = { [rec.alert.symbol]: { ...rec.initialQuote!, tradeIso: new Date(now - 1500).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 } };
  return { records: [structuredClone(rec)], candidates: o.candidates ?? [], positions: [], quotes, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify: (s) => KNOWN_CLASSIFICATIONS[s] ?? { sector: `S-${s}`, industry: `I-${s}`, theme: '' }, parity: {}, strategyVersion: 'RB v1.1', frozen: o.frozen ?? {}, terminal: {}, broker, rvolPolicy: o.ab ? { a: true, b: true, registry: REG } : null };
}
const row = (rec: AutoAlertRecord, broker?: BrokerExposureInput, o: { ab?: boolean } = {}) => buildQueue(input(rec, broker, T0(rec), o)).rows[0];
const ready = (r: ReturnType<typeof row>) => !!r.decision.ticket && r.lifecycle?.finalActionability === 'READY';

describe('A. Option C blocks an otherwise qualifying trade', () => {
  it('ordinary LONG, score ≥ 85, all hard rules, capital / slots / heat sufficient: eligible alone and with a PROTECTED broker position', () => {
    const r0 = row(ordinary());
    expect([r0.ranked!.total! >= 85, r0.ranked!.hardFails.length, ready(r0)]).toEqual([true, 0, true]);
    const r1 = row(ordinary(), PROTECTED());
    expect([ready(r1), r1.ranked!.hardFails.length, r1.ranked!.allocation?.allocated]).toEqual([true, 0, true]);
  });
  it('+ an UNKNOWN-risk broker-only position (LONG or SHORT) → NO TICKET — UNPROTECTED BROKER POSITION: … UNKNOWN RISK', () => {
    for (const b of [UNKNOWN(), SHORT_UNKNOWN()]) {
      const r = row(ordinary(), b);
      expect([r.lifecycle?.finalActionability, ready(r)]).toEqual(['NO TICKET', false]);
      expect(r.lifecycle!.reason.startsWith(`${UNPROTECTED_BROKER_POSITION} — FIS ${Number(b.positions[0].qty) > 0 ? 'LONG' : 'SHORT'} 499 sh: UNKNOWN RISK`)).toBe(true);
      expect(r.ranked!.hardFails.length).toBe(0); // no hard rule fails: the gate alone withholds the ticket
    }
  });
  it('+ a PARTIALLY protected position → NO TICKET with PARTIAL STOP, covered / unprotected shares and known risk shown separately', () => {
    const r = row(ordinary(), PARTIAL());
    expect(ready(r)).toBe(false);
    expect(r.lifecycle!.reason).toMatch(/UNPROTECTED BROKER POSITION — FIS LONG 499 sh: PARTIAL STOP, 300 sh covered \(known risk \$63\.00\), 199 sh unprotected \(counted provisionally at \$250\.00, not verified risk\)/);
  });
  it('Policy A + B (exception minimum 80) and a qualifying score cannot override the gate', () => {
    const ok = row(exception82(), PROTECTED(), { ab: true });
    expect([ok.rvolPolicy?.policy, ok.rvolPolicy?.effectiveMinScore, ok.ranked!.total, ready(ok)]).toEqual(['A+B', 80, 82, true]);
    for (const b of [UNKNOWN(), PARTIAL()]) {
      const r = row(exception82(), b, { ab: true });
      expect([r.rvolPolicy?.policy, r.ranked!.total, ready(r)]).toEqual(['A+B', 82, false]);
      expect(r.lifecycle!.reason.startsWith(UNPROTECTED_BROKER_POSITION)).toBe(true);
    }
  });
});

describe('A. restoration after a fresh verified reconciliation; terminal states never revive', () => {
  const pass = (rec: AutoAlertRecord, plan: { broker: BrokerExposureInput; dt: number }[]) => {
    let frozen: AlertSnapshotMap = {}; let candidates: Candidate[] = [];
    return plan.map(({ broker, dt }) => {
      const now = T0(rec) + dt;
      const out = buildQueue(input(rec, broker, now, { frozen, candidates }));
      frozen = freezeAlertSnapshots(frozen, out.rows, now, 91).map;
      candidates = out.candidates;
      return out.rows[0];
    });
  };
  it('UNKNOWN at alert time → the stop is placed (next verified response shows it) → the still-valid alert becomes READY', () => {
    const [a, b] = pass(ordinary(), [{ broker: UNKNOWN(), dt: 0 }, { broker: PROTECTED(), dt: 30_000 }]);
    expect([ready(a), a.lifecycle!.reason.startsWith(UNPROTECTED_BROKER_POSITION)]).toEqual([false, true]);
    expect(ready(b)).toBe(true);
  });
  it('the position is closed (next verified response has no FIS position) → READY again', () => {
    const flat: BrokerExposureInput = { verified: true, orders: [], positions: [], openOrders: [] };
    const [, b] = pass(ordinary(), [{ broker: UNKNOWN(), dt: 0 }, { broker: flat, dt: 30_000 }]);
    expect(ready(b)).toBe(true);
  });
  it('an alert that EXPIRED while gated is not revived when the gate clears', () => {
    const [a, b] = pass(ordinary(), [{ broker: UNKNOWN(), dt: 0 }, { broker: PROTECTED(), dt: 11 * 60_000 }]);
    expect(ready(a)).toBe(false);
    expect([ready(b), b.lifecycle!.terminal]).toEqual([false, true]);
  });
});

describe('B. one documented parsing path for real and synthetic fixtures', () => {
  it('every fixture parses through brokerOrdersFrom (the production parser) with zero errors and is consumed unmodified by reconcileExposure', () => {
    for (const f of fixtures) {
      if (!Array.isArray(f.broker.openOrders)) continue; // the INCOMPLETE fixture (open orders null) tests the unverified path
      expect([f.name, brokerOrdersFrom(f.broker.openOrders as unknown[]).errors, brokerOrdersFrom(f.broker.orders).errors]).toEqual([f.name, [], []]);
    }
  });
});

describe('C. consistent gate reasons on both screens (banner + Ranker status)', () => {
  it('a verified portfolio that is gated by an unprotected position shows the banner with the exact reason; the Ranker relabels TRADE NOW with the same label', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { PortfolioVerificationBanner } = await import('../../../components/PortfolioVerificationBanner');
    const { gateRankingDisplay } = await import('../../../components/portfolioGate');
    const { unprotectedGate, reconcileExposure, portfolioVerification } = await import('../lifecycle/portfolioExposure');
    const out = reconcileExposure([], [], UNKNOWN(), { classify: () => null, conservativeRisk: 250 });
    const gate = unprotectedGate(out.brokerPositions)!;
    const verified = { state: 'VERIFIED' as const, verified: true, gated: false, reason: 'Verified', lastVerifiedMs: 1, keptFromSnapshot: false, message: 'Portfolio verified.' };
    const gateView = { ...verified, gated: true, reason: gate, message: `${UNPROTECTED_BROKER_POSITION} — ${gate.slice('UNPROTECTED BROKER POSITION'.length + 2)}.` };
    const html = renderToStaticMarkup(createElement(PortfolioVerificationBanner, { v: gateView }));
    expect(html).toContain('NO TICKET — UNPROTECTED BROKER POSITION — FIS LONG 499 sh: UNKNOWN RISK');
    expect(renderToStaticMarkup(createElement(PortfolioVerificationBanner, { v: verified }))).toBe(''); // nothing when verified and not gated
    const ranking = { ranked: [{ displayStatus: 'TRADE NOW — #1' }, { displayStatus: 'WATCH' }] } as never;
    expect((gateRankingDisplay(ranking, gateView) as { ranked: { displayStatus: string }[] }).ranked.map((r) => r.displayStatus)).toEqual([UNPROTECTED_BROKER_POSITION, 'WATCH']);
    const unverified = portfolioVerification(null, '2026-11-09', 0);
    expect((gateRankingDisplay(ranking, unverified) as { ranked: { displayStatus: string }[] }).ranked[0].displayStatus).toBe('NO TICKET — PORTFOLIO UNVERIFIED'); // unchanged
  });
});
