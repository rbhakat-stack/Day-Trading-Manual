/**
 * Broker-verified portfolio exposure: confirmed closes release slots / heat / capital / correlation; anything uncertain
 * keeps the reservation. Allocator formulas and limits are unchanged — only the exposure inputs differ.
 * Includes the 2026-11-03 FIS overnight stop (planned risk $99.80) and the GS / BAC alerts of that day.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue } from '../liveQueue';
import { buildPortfolio } from '../../ranker/portfolioAllocator';
import type { Candidate, ManualPosition } from '../../ranker/opportunityTypes';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../settings';
import { recordWith } from './fixtures';
import { brokerVerified, latchReleases, reconcileExposure, type BrokerExposureInput, type ReleasedExposureMap } from '../lifecycle/portfolioExposure';

const RK = cloneRankerDefaults();
const RISK = RK.portfolio.accountEquity * RK.portfolio.riskPerTradePct; // $250
const classify = (s: string) => ({ sector: ['FIS', 'GS', 'BAC'].includes(s) ? 'Financials' : `S-${s}`, industry: `I-${s}`, theme: '' });
const opts = { classify, conservativeRisk: RISK };
let seq = 0;
const cand = (o: Partial<Candidate>): Candidate => ({
  id: `c${++seq}`, source: 'AUTO', date: '2026-11-02', alertTime: '14:30', alertMs: Date.parse('2026-11-02T19:30:19Z'), createdAt: seq, ticker: 'FIS', direction: 'LONG',
  open: 40, high: 40.1, low: 39.9, close: 40.05, atr: 0.1, currentPrice: 40.05, entry: 40.04, stop: 39.84, target: 40.44, shares: 499, positionValue: 19979.96, plannedRisk: 99.8, expectedReward: 199.6,
  orderType: 'BUY STOP', calcAction: 'BUY_STOP', calcReady: true, chaseDistanceAtr: 0, minutesSinceAlert: 1, scored: true, status: 'FILLED', initialScore: null, entryScore: null, actualFill: 40.05, exitPrice: null,
  notes: 'keep', archived: false, keptAgainst: [], inputs: { rvol: 2, rsi: 60, vwap: 40, ema9: 40, ema20: 39.9, close15m: 40, ema20_15m: 39.9, sector: 'Financials', industry: 'I-FIS', theme: '' }, ...o,
} as Candidate);
/** Alpaca facts exactly as rb-broker returned them on 2026-11-03: no positions; the FIS stop leg filled at 39.82. */
const NOV3: BrokerExposureInput = {
  verified: true, positions: [],
  orders: [{ id: '505618ca-4522-47ef-8765-977b4808d7bf', symbol: 'FIS', side: 'sell', type: 'stop', order_class: 'bracket', status: 'filled', qty: '499', filled_qty: '499', filled_avg_price: '39.82', stop_price: '39.84', submitted_at: '2026-11-03T14:34:29Z', filled_at: '2026-11-03T14:35:01Z', legs: [] }],
};
const pf = (cs: Candidate[], ps: ManualPosition[]) => buildPortfolio(ps, cs, RK);
const apply = (cs: Candidate[], ps: ManualPosition[], b: BrokerExposureInput | null, latched?: ReleasedExposureMap) => {
  const x = reconcileExposure(cs, ps, b, { ...opts, latched, now: Date.parse('2026-11-03T17:30:00Z') });
  return { x, p: pf(x.candidates, x.positions) };
};
const entryOrder = (o: Record<string, unknown> = {}) => ({ id: 'e1', symbol: 'GM', side: 'buy', type: 'stop', status: 'accepted', qty: '223', filled_qty: '0', filled_avg_price: null, stop_price: '89.47', submitted_at: '2026-11-03T19:06:53Z', legs: [], ...o });
const pendingGM = () => cand({ ticker: 'GM', date: '2026-11-03', alertMs: Date.parse('2026-11-03T19:05:21Z'), entry: 89.47, stop: 89.22, target: 89.97, shares: 223, plannedRisk: 55.75, positionValue: 19951.81, status: 'PENDING', inputs: { ...cand({}).inputs, sector: 'Autos' } });

describe('FIS overnight protective stop (2026-11-02 entry, 2026-11-03 stop fill)', () => {
  const fis = cand({});
  it('before: 1/4 slots, $99.80 heat (the stale FILLED candidate)', () => {
    expect(pf([fis], [])).toMatchObject({ slotsUsed: 1, heatCommitted: 99.8 });
  });
  it('after, with verified Alpaca facts: 0/4 slots, $0 heat, no capital or correlation exposure; record unchanged', () => {
    const { x, p } = apply([fis], [], NOV3);
    expect(p).toMatchObject({ slotsUsed: 0, heatCommitted: 0, deployed: 0, openPositions: 0 });
    expect(p.exposures).toEqual([]);
    expect(x.released).toMatchObject([{ id: fis.id, ticker: 'FIS', status: 'FILLED' }]);
    expect(fis).toMatchObject({ status: 'FILLED', notes: 'keep', plannedRisk: 99.8 }); // history preserved, not rewritten
  });
  it('does not depend on the (inaccurate) cross-day Journal: only broker positions and orders are read', () => {
    expect(reconcileExposure.length).toBe(4); // candidates, positions, broker facts, options — no journal input exists
  });
});

describe('verified releases / keeps', () => {
  it('open broker position → FILLED candidate keeps its slot and heat (counted once, not twice)', () => {
    const { p, x } = apply([cand({})], [], { verified: true, orders: [], positions: [{ symbol: 'FIS', qty: '499', avg_entry_price: '40.05', market_value: '20000' }] });
    expect([p.slotsUsed, p.heatCommitted, x.added]).toEqual([1, 99.8, []]);
  });
  it('pending entry not yet at the broker → keeps its reservation', () => {
    const { p } = apply([pendingGM()], [], { verified: true, orders: [], positions: [] });
    expect([p.slotsUsed, p.heatCommitted]).toEqual([1, 55.75]);
  });
  it('canceled / expired / rejected entry without fill → released', () => {
    for (const status of ['canceled', 'expired', 'rejected']) {
      const { p, x } = apply([pendingGM()], [], { verified: true, orders: [entryOrder({ status })], positions: [] });
      expect([p.slotsUsed, x.released.length]).toEqual([0, 1]);
    }
  });
  it('partially filled entry (working order, partial position) → kept, at full planned risk', () => {
    const { p } = apply([pendingGM()], [], { verified: true, orders: [entryOrder({ status: 'partially_filled', filled_qty: '100', filled_avg_price: '89.48' })], positions: [{ symbol: 'GM', qty: '100' }] });
    expect([p.slotsUsed, p.heatCommitted]).toEqual([1, 55.75]);
  });
  it('partial exit (position remains) → kept at full planned risk', () => {
    const { p } = apply([cand({})], [], { verified: true, orders: [], positions: [{ symbol: 'FIS', qty: '200' }] });
    expect([p.slotsUsed, p.heatCommitted]).toEqual([1, 99.8]);
  });
  it('a working order in the ticker (e.g. a protective leg or new entry) → not treated as flat', () => {
    const { p } = apply([cand({})], [], { verified: true, orders: [{ id: 'w', symbol: 'FIS', side: 'sell', type: 'stop', status: 'held', qty: '499', filled_qty: '0', legs: [] }], positions: [] });
    expect(p.slotsUsed).toBe(1);
  });
  it('PENDING entry that filled and is now flat (same-day round trip) → released', () => {
    const { x } = apply([pendingGM()], [], { verified: true, orders: [entryOrder({ status: 'filled', filled_qty: '223', filled_avg_price: '89.49' })], positions: [] });
    expect(x.released[0].reason).toMatch(/filled and the position is closed/);
  });
  it('missing or ambiguous order linkage → PENDING kept (never released by ticker alone)', () => {
    const other = entryOrder({ status: 'canceled', stop_price: '90.00' }); // different price → not this candidate
    expect(apply([pendingGM()], [], { verified: true, orders: [other], positions: [] }).p.slotsUsed).toBe(1);
    const two = [entryOrder({ id: 'a', status: 'canceled' }), entryOrder({ id: 'b', status: 'canceled' })];
    expect(apply([pendingGM()], [], { verified: true, orders: two, positions: [] }).p.slotsUsed).toBe(1);
    const twin = [pendingGM(), pendingGM()]; // one order claimed by two candidates
    expect(apply(twin, [], { verified: true, orders: [entryOrder({ status: 'canceled' })], positions: [] }).p.slotsUsed).toBe(2);
  });
  it('manual position not represented in Alpaca → still counted (may be held elsewhere)', () => {
    const manual: ManualPosition = { id: 'm', ticker: 'XYZ', direction: 'LONG', sector: 'S', industry: 'I', theme: '', positionValue: 5000, plannedRisk: 50, entry: 10, stop: 9, target: 12, status: 'OPEN' };
    expect(apply([], [manual], { verified: true, orders: [], positions: [] }).p).toMatchObject({ slotsUsed: 1, heatCommitted: 50 });
  });
  it('open broker position with no RB record → added conservatively (slot, value, $250 risk)', () => {
    const { p, x } = apply([], [], { verified: true, orders: [], positions: [{ symbol: 'NVDA', qty: '10', avg_entry_price: '200', market_value: '2050' }] });
    expect(x.added).toEqual([{ ticker: 'NVDA', qty: 10, plannedRisk: RISK }]);
    expect(p).toMatchObject({ slotsUsed: 1, heatCommitted: RISK, deployed: 2050 });
  });
});

describe('uncertain broker status is conservative', () => {
  const fis = cand({});
  it('broker feed unavailable / unverified → nothing released, nothing added', () => {
    for (const b of [null, undefined, { ...NOV3, verified: false }]) expect(apply([fis], [], b as BrokerExposureInput | null).p).toMatchObject({ slotsUsed: 1, heatCommitted: 99.8 });
  });
  it('brokerVerified: only LIVE, loaded for today, and fresh', () => {
    const now = Date.parse('2026-11-03T17:30:00Z');
    expect(brokerVerified({ status: 'LIVE', loadedDate: '2026-11-03', lastOkMs: now - 30_000 }, '2026-11-03', now)).toBe(true);
    expect(brokerVerified({ status: 'LIVE', loadedDate: '2026-11-03', lastOkMs: now - 5 * 60_000 }, '2026-11-03', now)).toBe(false); // stale
    expect(brokerVerified({ status: 'LIVE', loadedDate: '2026-11-02', lastOkMs: now }, '2026-11-03', now)).toBe(false); // previous day
    expect(brokerVerified({ status: 'ERROR', loadedDate: '2026-11-03', lastOkMs: now }, '2026-11-03', now)).toBe(false);
    expect(brokerVerified({ status: 'OFF', loadedDate: null, lastOkMs: null }, '2026-11-03', now)).toBe(false);
    expect(brokerVerified(null, '2026-11-03', now)).toBe(false);
  });
});

describe('latched releases (reload, outage, new trade in the same ticker)', () => {
  const old = cand({});
  const first = apply([old], [], NOV3);
  const latched = latchReleases({}, first.x.released).map;
  it('write-once', () => {
    expect(latchReleases(latched, first.x.released).map).toBe(latched);
  });
  it('browser reload after close: the release persists, even while the broker feed is unavailable', () => {
    expect(apply([old], [], null, latched).p).toMatchObject({ slotsUsed: 0, heatCommitted: 0 });
  });
  it('genuine new FIS trade later: the new position counts once, the closed one stays released', () => {
    const fresh = cand({ id: 'new-fis', date: '2026-11-04', alertMs: Date.parse('2026-11-04T15:00:00Z'), plannedRisk: 80 });
    const { p, x } = apply([old, fresh], [], { verified: true, orders: [], positions: [{ symbol: 'FIS', qty: '400' }] }, latched);
    expect([p.slotsUsed, p.heatCommitted, x.added]).toEqual([1, 80, []]);
  });
});

describe('Nov 3 GS / BAC alerts with the stale FIS exposure released (portfolio-only effect)', () => {
  const rec = (symbol: string, iso: string, price: number, values: Record<string, number>): AutoAlertRecord => recordWith({ symbol, direction: 'SHORT', alertIso: iso, price, values });
  const GS = rec('GS', '2026-11-03T12:05:05-05:00', 892.95, { open: 893.56, high: 894.09, low: 892.5, close: 893, atr: 1.8375076778270003, ema9: 895.3133353821252, ema20: 897.0266847594837, rsi: 27.00662554811956, rvol: 1.1679170196298305, vwap: 898.1619671909663, close15m: 893.59, ema20_15m: 899.7618719231194 });
  const BAC = rec('BAC', '2026-11-03T12:20:13-05:00', 49.505, { open: 49.5199, high: 49.54, low: 49.49, close: 49.505, atr: 0.09771596268613501, ema9: 49.523000141436626, ema20: 49.59375171536965, rsi: 39.1555463028399, rvol: 1.4912741587852727, vwap: 49.67421704437659, close15m: 49.51, ema20_15m: 49.73649386124303 });
  // Each alert is evaluated inside its own alert window (GS at 12:06, BAC at 12:21).
  const NOW: Record<string, number> = { GS: Date.parse('2026-11-03T17:06:00Z'), BAC: Date.parse('2026-11-03T17:21:00Z') };
  const q = (p: number, now: number): LiveQuote => ({ price: p, tradeIso: new Date(now - 1500).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 });
  const run = (s: 'GS' | 'BAC', broker?: BrokerExposureInput) => buildQueue({ records: [s === 'GS' ? GS : BAC], candidates: [cand({})], positions: [], quotes: { [s]: q(s === 'GS' ? 893 : 49.505, NOW[s]) }, now: NOW[s], cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: RK, classify, parity: {}, strategyVersion: 'RB v1.1', broker });
  type Out = ReturnType<typeof buildQueue>;
  const runs = { GS: [run('GS'), run('GS', NOV3)], BAC: [run('BAC'), run('BAC', NOV3)] } as Record<string, [Out, Out]>;
  const before = { rows: [...runs.GS[0].rows, ...runs.BAC[0].rows] } as Out;
  const after = { rows: [...runs.GS[1].rows, ...runs.BAC[1].rows], exposure: runs.BAC[1].exposure, candidates: runs.BAC[1].candidates } as Out;
  const by = (o: Out, s: string) => o.rows.find((r) => r.record.alert.symbol === s)!;
  it('plans (Entry / Stop / Target / Qty / risk) are identical; only the portfolio snapshot changes', () => {
    for (const s of ['GS', 'BAC']) {
      const [a, b] = [by(before, s).candidate!, by(after, s).candidate!];
      expect([b.entry, b.stop, b.target, b.shares, b.plannedRisk]).toEqual([a.entry, a.stop, a.target, a.shares, a.plannedRisk]);
      expect(by(before, s).ranked!.portfolio).toMatchObject({ slotsUsed: 1, heatCommitted: 99.8 });
      expect(by(after, s).ranked!.portfolio).toMatchObject({ slotsUsed: 0, heatCommitted: 0 });
    }
    expect([by(after, 'GS').candidate!.entry, by(after, 'GS').candidate!.stop, by(after, 'BAC').candidate!.entry, by(after, 'BAC').candidate!.stop]).toEqual([892.32, 894.16, 49.48, 49.58]);
  });
  it('setup components are unchanged; any score change comes only from the portfolio-fit components', () => {
    const SETUP = ['trend', 'rvol', 'momentum', 'candle', 'location', 'time'];
    for (const s of ['GS', 'BAC']) {
      const pts = (o: typeof before) => Object.fromEntries(by(o, s).ranked!.components.map((c) => [c.key, c.points]));
      const [a, b] = [pts(before), pts(after)];
      for (const k of SETUP) expect(b[k], `${s} ${k}`).toBe(a[k]);
      const fitDelta = ['capitalEfficiency', 'capitalAvailability', 'correlation', 'portfolioRisk'].reduce((n, k) => n + (b[k] - a[k]), 0);
      expect(fitDelta).toBeGreaterThanOrEqual(0); // releasing a confirmed-closed exposure can only free capacity
      const [ta, tb] = [by(before, s).ranked!.total, by(after, s).ranked!.total];
      expect(tb === null).toBe(ta === null); // scored-ness is unchanged (no strategy rule depends on it)
      if (ta !== null && tb !== null) expect(tb - ta).toBeCloseTo(Math.min(30, by(after, s).ranked!.fit!) - Math.min(30, by(before, s).ranked!.fit!), 6);
    }
  });
  it('GS correlation exposure: the stale FIS Financials position no longer reduces diversification', () => {
    const corr = (o: Out) => by(o, 'GS').ranked!.components.find((c) => c.key === 'correlation')!.points;
    expect(corr(after)).toBeGreaterThan(corr(before));
  });
  it('the exposure note lists the release; records are unchanged', () => {
    expect(after.exposure).toMatchObject({ verified: true, released: [{ ticker: 'FIS', status: 'FILLED' }], added: [] });
    expect(after.candidates.find((c) => c.ticker === 'FIS')).toMatchObject({ status: 'FILLED', notes: 'keep' });
  });
});
