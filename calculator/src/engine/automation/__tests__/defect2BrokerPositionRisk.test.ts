/**
 * Defect 2 (Option C) — risk of unmatched broker positions from VERIFIED protective stops; unknown / partial / ambiguous
 * risk is provisional (never below the per-trade limit) and withholds new tickets (UNPROTECTED BROKER POSITION).
 * Fixtures: REAL broker states reconstructed from the archived Alpaca PAPER orders (nested=true open-order shape) and
 * labelled SYNTHETIC variants (defect2-broker-positions.fixtures.json). `previous` = the flat $250 the base counted.
 */
import { describe, expect, it } from 'vitest';
import FX from './defect2-broker-positions.fixtures.json';
import PB from './rvol-policy-b-2026-11-05.json';
import { positionProtection, reconcileExposure, unprotectedGate, UNPROTECTED_BROKER_POSITION, type BrokerExposureInput } from '../lifecycle/portfolioExposure';
import { brokerOrdersFrom } from '../lifecycle/brokerSync';
import { buildQueue } from '../liveQueue';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import { buildPortfolio } from '../../ranker/portfolioAllocator';
import { KNOWN_CLASSIFICATIONS } from '../../ranker/correlationRules';
import { RB_V1_DEFAULTS } from '../../settings';

type Expected = { basis: string; plannedRisk?: number; confirmedRisk?: number; coveredQty?: number; uncoveredQty?: number; linkage?: string[]; flags?: string[]; gated?: boolean; previous?: number };
type Fixture = { name: string; source: 'PAPER_HISTORY' | 'SYNTHETIC'; asOf: string; ticker: string; expected: Expected; broker: BrokerExposureInput };
const fixtures = FX.fixtures as unknown as Fixture[];
const CONSERVATIVE = FX.conservativeRiskToday;
const run = (f: Fixture, candidates: unknown[] = []) => reconcileExposure(candidates as never, [], f.broker, { classify: () => null, conservativeRisk: CONSERVATIVE, now: Date.parse(f.asOf), maxPositionValue: 20_000 });
const evaluated = fixtures.filter((f) => f.expected.basis !== 'UNVERIFIED_PATH');

describe('every fixture: corrected risk, basis, coverage and linkage', () => {
  it.each(evaluated.map((f) => [f.name, f] as const))('%s', (_n, f) => {
    const out = run(f);
    const bp = out.brokerPositions.find((x) => x.ticker === f.ticker)!;
    const e = f.expected;
    expect(bp.riskBasis).toBe(e.basis);
    expect(bp.plannedRisk).toBe(e.plannedRisk);
    expect(bp.confirmedRisk).toBe(e.confirmedRisk);
    expect(bp.coveredQty).toBe(e.coveredQty);
    expect(bp.uncoveredQty).toBe(e.uncoveredQty);
    if (e.linkage) expect(bp.stops!.map((s) => s.linkage).sort()).toEqual([...e.linkage].sort());
    for (const fl of e.flags ?? []) expect(bp.flags).toContain(fl);
    // heat counts the corrected risk exactly once, plus the (unchanged) broker working entries of the same real state
    const pf = buildPortfolio(out.positions, [], cloneRankerDefaults());
    const entriesRisk = out.entries.reduce((a, x) => a + x.plannedRisk, 0);
    const otherPositions = out.brokerPositions.filter((x) => x.ticker !== f.ticker).reduce((a, x) => a + x.plannedRisk, 0); // other real positions open at the same instant
    expect(pf.heatCommitted).toBeCloseTo((e.plannedRisk ?? 0) + otherPositions + entriesRisk, 6);
    expect(out.positions.filter((x) => x.id === `broker-position-${f.ticker}`)).toHaveLength(1);
    // gate iff not fully verified
    const gate = unprotectedGate(out.brokerPositions);
    expect(gate !== null).toBe(e.basis !== 'CONFIRMED_STOP');
    if (gate) expect(gate).toMatch(new RegExp(`${f.ticker} (LONG|SHORT) \\d+ sh: (UNKNOWN RISK|PARTIAL STOP|AMBIGUOUS STOPS).*not verified risk`));
  });
});

describe('real PAPER history: previous flat $250 vs corrected', () => {
  it('every protected real position is now counted at its verified stop risk (all below the old $250)', () => {
    const rows = fixtures.filter((f) => f.source === 'PAPER_HISTORY').map((f) => [f.ticker, f.expected.previous, run(f).brokerPositions.find((x) => x.ticker === f.ticker)!.plannedRisk]);
    expect(rows).toEqual([['FIS', 250, 104.79], ['MCD', 250, 190.5], ['GM', 250, 60.21], ['NVDA', 250, 80.86], ['CTVA', 250, 134.64], ['AAPL', 250, 241.2], ['TRMB', 250, 232.3]]);
  });
});

describe('matching rules (direct)', () => {
  const fis = fixtures[0];
  const open = brokerOrdersFrom(fis.broker.openOrders as unknown[]).orders;
  const lists = brokerOrdersFrom(fis.broker.orders).orders;
  it('a held leg counts only with its verified filled parent; the orphan copy does not', () => {
    expect(positionProtection('FIS', 499, 40.05, open, lists, CONSERVATIVE).basis).toBe('CONFIRMED_STOP');
    const orphan = fixtures.find((f) => /ORPHAN/.test(f.name))!;
    const p = positionProtection('FIS', 499, 40.05, brokerOrdersFrom(orphan.broker.openOrders as unknown[]).orders, lists, CONSERVATIVE);
    expect(p.basis).toBe('UNKNOWN_NO_STOP');
    expect(p.rejected.map((r) => r.reason)).toContain('held order without a verifiable parent order');
  });
  it('a leg of an entry that has NOT filled never protects (it is a pending bracket, not a position stop)', () => {
    const unfilled = open.map((o) => (o.symbol === 'FIS' ? { ...o, filledQty: 0, status: 'new' } : o));
    expect(positionProtection('FIS', 499, 40.05, unfilled, [], CONSERVATIVE).basis).toBe('UNKNOWN_NO_STOP');
  });
  it('canceled / replaced / filled / expired stops are never protection', () => {
    for (const st of ['canceled', 'replaced', 'filled', 'expired', 'rejected', 'done_for_day']) {
      const o = open.map((x) => ({ ...x, legs: x.legs.map((l) => ({ ...l, status: st })) }));
      expect([st, positionProtection('FIS', 499, 40.05, o, lists, CONSERVATIVE).basis]).toEqual([st, 'UNKNOWN_NO_STOP']);
    }
  });
  it('counted risk of an unresolved position is never below the per-trade limit and never labelled verified', () => {
    const p = positionProtection('FIS', 499, 40.05, [], [], CONSERVATIVE);
    expect([p.basis, p.resolved, p.countedRisk, p.confirmedRisk]).toEqual(['UNKNOWN_NO_STOP', false, 250, 0]);
  });
});

describe('no regression: unverified paths, represented positions, pending entries', () => {
  it('unverified / incomplete broker responses take the existing path (no Defect 2 evaluation, no new gate)', () => {
    for (const f of fixtures.filter((x) => x.expected.basis === 'UNVERIFIED_PATH')) {
      const out = run(f);
      expect([f.name, out.verified, out.brokerPositions.length, unprotectedGate(out.brokerPositions)]).toEqual([f.name, false, 0, null]);
    }
  });
  it('a last-known snapshot written by an older build (no riskBasis) is kept as before and adds no gate', () => {
    const legacy = [{ ticker: 'FIS', direction: 'LONG' as const, qty: 499, positionValue: 19_984.95, plannedRisk: 250, entry: 40.05 }];
    const out = reconcileExposure([], [], { ...fixtures[0].broker, verified: false }, { classify: () => null, conservativeRisk: CONSERVATIVE, knownPositions: legacy });
    expect(out.brokerPositions).toEqual(legacy);
    expect(unprotectedGate(out.brokerPositions)).toBeNull();
  });
  it('a position represented by an active RB record is not counted again (no double counting), even when its broker stop is missing', () => {
    const f = fixtures.find((x) => /CANCELED/.test(x.name))!;
    const cand = { id: 'FIS-L-143019', ticker: 'FIS', direction: 'LONG', status: 'FILLED', entry: 40.04, stop: 39.84, target: 40.44, shares: 499, positionValue: 19_979.96, plannedRisk: 99.8, archived: false, date: '2026-11-02', inputs: { sector: 'X', industry: 'Y', theme: '' } };
    const out = run(f, [cand]);
    expect(out.brokerPositions.find((x) => x.ticker === 'FIS')).toBeUndefined();
    expect(unprotectedGate(out.brokerPositions)).toBeNull();
  });
  it('a pending entry order is unaffected (working entries keep their existing bracket-stop risk)', () => {
    const f = fixtures[0];
    const b = structuredClone(f.broker) as BrokerExposureInput & { openOrders: Record<string, unknown>[] };
    b.openOrders.push({ id: 'pending-ba', symbol: 'BA', side: 'buy', type: 'stop', order_class: 'bracket', status: 'new', qty: '113', filled_qty: '0', stop_price: '175.59', limit_price: null, submitted_at: '2026-11-03T14:20:00Z', legs: [
      { id: 'pending-ba-tp', symbol: 'BA', side: 'sell', type: 'limit', status: 'held', qty: '113', filled_qty: '0', limit_price: '177.51', stop_price: null, legs: [] },
      { id: 'pending-ba-sl', symbol: 'BA', side: 'sell', type: 'stop', status: 'held', qty: '113', filled_qty: '0', stop_price: '174.73', limit_price: null, legs: [] }] });
    const out = run({ ...f, broker: b });
    expect(out.entries.filter((e) => e.ticker === 'BA').map((e) => [e.ticker, e.plannedRisk, e.riskBasis])).toEqual([['BA', 97.18, 'BRACKET_STOP']]);
    expect(out.brokerPositions.map((x) => x.ticker)).toEqual(['FIS']); // the BA held stop leg is not mistaken for FIS protection or a BA position
  });
});

describe('eligibility: the UNPROTECTED BROKER POSITION gate in the Live Queue', () => {
  // A real 82-point approved Policy A+B setup is not needed: an ordinary alert that is READY without broker exposure.
  const rec = structuredClone((PB.records as unknown as AutoAlertRecord[]).find((r) => r.id.startsWith('SWKS-L-144513'))!);
  const v = rec.snapshot!.values!;
  v.close = v.high; v.rsi = 66; v.open = 81.85; v.rvol = 3.6; // SYNTHETIC: a high-scoring ordinary setup (all conditions reproduced)
  rec.snapshot!.issues = [];
  const now = Date.parse(rec.processedIso!) + 4_000;
  const q = (broker?: BrokerExposureInput) => {
    const quotes: Record<string, LiveQuote> = { [rec.alert.symbol]: { ...rec.initialQuote!, tradeIso: new Date(now - 1500).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 } };
    return buildQueue({ records: [structuredClone(rec)], candidates: [], positions: [], quotes, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify: (s) => KNOWN_CLASSIFICATIONS[s] ?? { sector: `S-${s}`, industry: `I-${s}`, theme: '' }, parity: {}, strategyVersion: 'RB v1.1', frozen: {}, terminal: {}, broker }).rows[0];
  };
  /** The fixture's broker state reduced to FIS only (the real 3 Nov state also holds the CTVA 5,000-share GTC entry, which exhausts capital on its own). */
  const only = (f: Fixture): BrokerExposureInput => ({ ...f.broker, orders: (f.broker.orders as { symbol: string }[]).filter((o) => o.symbol === 'FIS'), positions: f.broker.positions.filter((p) => p.symbol === 'FIS'), openOrders: (f.broker.openOrders as { symbol: string }[]).filter((o) => o.symbol === 'FIS') });
  it('baseline: the setup is READY with no broker exposure', () => {
    const r = q();
    expect([(r.ranked?.total ?? 0) >= 85, r.lifecycle?.finalActionability]).toEqual([true, 'READY']);
  });
  it('a fully protected broker position (FIS, verified stop) does not block the ticket', () => {
    const r = q(only(fixtures[0]));
    expect([r.lifecycle?.finalActionability, r.lifecycle?.reason]).toEqual(['READY', r.lifecycle?.reason]);
  });
  it('UNKNOWN / PARTIAL / AMBIGUOUS broker risk → NO TICKET — UNPROTECTED BROKER POSITION with the exact reason; score and plan unchanged', () => {
    const ok = q(only(fixtures[0]));
    for (const [re, txt] of [[/CANCELED/, 'UNKNOWN RISK'], [/only 300 of 499/, 'PARTIAL STOP'], [/different prices/, 'AMBIGUOUS STOPS'], [/ORPHAN/, 'UNKNOWN RISK']] as const) {
      const f = fixtures.find((x) => re.test(x.name))!;
      const r = q(only(f));
      expect([f.name, r.lifecycle?.finalActionability, r.lifecycle?.executionState]).toEqual([f.name, 'NO TICKET', 'ACTIVE']);
      expect(r.lifecycle?.reason.startsWith(UNPROTECTED_BROKER_POSITION)).toBe(true);
      expect(r.lifecycle?.reason).toContain(txt);
      expect([r.candidate?.entry, r.candidate?.stop, r.candidate?.target, r.candidate?.shares]).toEqual([ok.candidate?.entry, ok.candidate?.stop, ok.candidate?.target, ok.candidate?.shares]);
      expect(r.ranked?.components.filter((c) => !['portfolioRisk', 'capitalAvailability'].includes(c.key))).toEqual(ok.ranked?.components.filter((c) => !['portfolioRisk', 'capitalAvailability'].includes(c.key)));
    }
  });
});

describe('Live Queue reconciliation note (display)', () => {
  it('verified risk names the stops; unresolved risk names the reason and is never called verified; legacy wording kept', async () => {
    const { brokerPositionNote } = await import('../../../components/live/LiveQueuePage');
    const pick = (re: RegExp) => { const f = fixtures.find((x) => re.test(x.name))!; return run(f).brokerPositions.find((x) => x.ticker === f.ticker)!; };
    expect(brokerPositionNote(pick(/FIS LONG held overnight/))).toMatch(/^FIS broker position \(499\) not in RB — risk \$104\.79 from verified protective stop\(s\): stop 499 @ 39\.84 \[bracket leg\]$/);
    expect(brokerPositionNote(pick(/STOP-LIMIT/))).toMatch(/stop limit 499 @ 39\.84 \(limit 39\.7\) \[standalone\]; stop-limit: risk modelled to the limit, a fill is not guaranteed/);
    const unk = brokerPositionNote(pick(/CANCELED/));
    expect(unk).toMatch(/UNKNOWN RISK, no verified protective stop.*counted provisionally at \$250\.00, not verified risk/);
    expect(unk).not.toMatch(/from verified protective stop/);
    expect(brokerPositionNote(pick(/only 300 of 499/))).toMatch(/PARTIAL STOP, 300 sh covered \(known risk \$63\.00\), 199 sh unprotected/);
    expect(brokerPositionNote({ ticker: 'X', direction: 'LONG', qty: 10, positionValue: 1000, plannedRisk: 250, entry: 100 })).toBe('X broker position (10) not in RB — counted conservatively ($250 risk)');
  });
});
