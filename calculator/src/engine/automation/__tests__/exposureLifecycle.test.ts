/**
 * Fix 6.1 — a release applies only to the execution it proved closed (execution fingerprint + revision + order id);
 * reuse, outages and unidentifiable lifecycles always fall back to reserving.
 * Fix 6.2 — the Opportunity Ranker and the Live Alert Queue see the SAME reconciled exposure.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue } from '../liveQueue';
import { rankCandidates } from '../../ranker/candidateRanker';
import { buildPortfolio } from '../../ranker/portfolioAllocator';
import type { Candidate, LifecycleStatus, ManualPosition } from '../../ranker/opportunityTypes';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../settings';
import { recordWith } from './fixtures';
import { executionFingerprint, executionRevPatch, latchReleases, reconcileExposure, type BrokerExposureInput, type ReleasedExposureMap } from '../lifecycle/portfolioExposure';

const RK = cloneRankerDefaults();
const classify = (s: string) => ({ sector: ['FIS', 'GS', 'BAC'].includes(s) ? 'Financials' : `S-${s}`, industry: `I-${s}`, theme: '' });
const OPTS = { classify, conservativeRisk: 250 };
let n = 0;
const cand = (o: Partial<Candidate>): Candidate => ({
  id: `c${++n}`, source: 'AUTO', date: '2026-11-02', alertTime: '14:30', alertMs: Date.parse('2026-11-02T19:30:19Z'), createdAt: n, ticker: 'FIS', direction: 'LONG',
  open: 40, high: 40.1, low: 39.9, close: 40.05, atr: 0.1, currentPrice: 40.05, entry: 40.04, stop: 39.84, target: 40.44, shares: 499, positionValue: 19979.96, plannedRisk: 99.8, expectedReward: 199.6,
  orderType: 'BUY STOP', calcAction: 'BUY_STOP', calcReady: true, chaseDistanceAtr: 0, minutesSinceAlert: 1, scored: true, status: 'FILLED', initialScore: null, entryScore: null, actualFill: 40.05, exitPrice: null,
  notes: 'keep', archived: false, keptAgainst: [], inputs: { rvol: 2, rsi: 60, vwap: 40, ema9: 40, ema20: 39.9, close15m: 40, ema20_15m: 39.9, sector: 'Financials', industry: 'I-FIS', theme: '' }, ...o,
} as Candidate);
const FLAT: BrokerExposureInput = { verified: true, positions: [], orders: [{ id: '505618ca', symbol: 'FIS', side: 'sell', type: 'stop', status: 'filled', qty: '499', filled_qty: '499', filled_avg_price: '39.82', stop_price: '39.84', submitted_at: '2026-11-03T14:34:29Z', legs: [] }] };
const HELD = (sym: string, qty: string): BrokerExposureInput => ({ verified: true, orders: [], positions: [{ symbol: sym, qty, avg_entry_price: '40', market_value: String(Math.abs(Number(qty)) * 40) }] });
const ex = (cs: Candidate[], b: BrokerExposureInput | null, latched?: ReleasedExposureMap, ps: ManualPosition[] = []) => reconcileExposure(cs, ps, b, { ...OPTS, latched, now: Date.parse('2026-11-03T17:30:00Z') });
const usage = (cs: Candidate[], b: BrokerExposureInput | null, latched?: ReleasedExposureMap, ps: ManualPosition[] = []) => { const x = ex(cs, b, latched, ps); return buildPortfolio(x.positions, x.candidates, RK); };
const latch = (cs: Candidate[], b: BrokerExposureInput, prev: ReleasedExposureMap = {}) => latchReleases(prev, ex(cs, b, prev).released).map;
/** Status change exactly as the app applies it (execution revision included). */
const setStatus = (c: Candidate, status: LifecycleStatus, extra: Partial<Candidate> = {}): Candidate => ({ ...c, status, ...executionRevPatch(c, status), ...extra });
const gmOrder = (o: Record<string, unknown>) => ({ id: 'o1', symbol: 'GM', side: 'buy', type: 'stop', status: 'canceled', qty: '223', filled_qty: '0', stop_price: '89.47', submitted_at: '2026-11-03T15:01:00Z', legs: [], ...o });
const gm = (o: Partial<Candidate> = {}) => cand({ id: 'gm1', ticker: 'GM', date: '2026-11-03', alertMs: Date.parse('2026-11-03T15:00:00Z'), entry: 89.47, status: 'PENDING', plannedRisk: 55, inputs: { ...cand({}).inputs, sector: 'Autos' }, ...o });

describe('6.1 execution revision', () => {
  it('a new execution bumps the revision; PENDING → FILLED is the same execution', () => {
    const c = cand({ status: 'NEW', executionRev: undefined });
    const p = setStatus(c, 'PENDING');
    expect(p.executionRev).toBe(1);
    expect(setStatus(p, 'FILLED').executionRev).toBe(1);
    expect(setStatus(setStatus(setStatus(p, 'FILLED'), 'STOPPED_OUT'), 'FILLED').executionRev).toBe(2);
    expect(setStatus(setStatus(p, 'CANCELED'), 'PENDING').executionRev).toBe(2);
  });
});

describe('6.1 safe release lifecycle', () => {
  it('(1) FILLED → closed → FILLED with the same candidate: old release void, new exposure counted (live and during an outage)', () => {
    const c0 = cand({ id: 'f1' });
    const L = latch([c0], FLAT);
    const reused = setStatus(setStatus(c0, 'STOPPED_OUT'), 'FILLED', { actualFill: 40.5 });
    expect(executionFingerprint(reused)).not.toBe(L.f1.fp);
    expect(usage([reused], HELD('FIS', '499'), L)).toMatchObject({ slotsUsed: 1, heatCommitted: 99.8 });
    expect(usage([reused], null, L)).toMatchObject({ slotsUsed: 1, heatCommitted: 99.8 });
    expect(ex([reused], HELD('FIS', '499'), L).voided[0]).toMatchObject({ id: 'f1', reason: expect.stringMatching(/new execution/) });
  });
  it('(2) PENDING → canceled → PENDING with the same candidate: new reservation counted', () => {
    const p0 = gm();
    const L = latch([p0], { verified: true, orders: [gmOrder({})], positions: [] });
    expect(L.gm1).toMatchObject({ orderId: 'o1', status: 'PENDING' });
    const again = setStatus(setStatus(p0, 'CANCELED'), 'PENDING');
    expect(usage([again], { verified: true, orders: [gmOrder({})], positions: [] }, L)).toMatchObject({ slotsUsed: 1, heatCommitted: 55 });
    expect(usage([again], null, L)).toMatchObject({ slotsUsed: 1, heatCommitted: 55 });
  });
  it('(3) same candidate reused with no visible change: new broker exposure in the ticker voids the release', () => {
    const c0 = cand({ id: 'f3' });
    const L = latch([c0], FLAT);
    expect(usage([c0], HELD('FIS', '499'), L)).toMatchObject({ slotsUsed: 1, heatCommitted: 99.8 }); // counted at its own risk, not suppressed
    expect(ex([c0], HELD('FIS', '499'), L).voided[0].reason).toMatch(/no other RB record represents/);
  });
  it('(4) a new order id after an earlier closed order (same candidate): the reservation returns', () => {
    const p0 = gm();
    const L = latch([p0], { verified: true, orders: [gmOrder({})], positions: [] });
    const twoOrders = { verified: true, orders: [gmOrder({}), gmOrder({ id: 'o2', status: 'accepted', submitted_at: '2026-11-03T15:20:00Z' })], positions: [] };
    expect(usage([p0], twoOrders, L).slotsUsed).toBe(1);
  });
  it('(5) broker unavailable after reuse → counted (no release applies without a verified response)', () => {
    const c0 = cand({ id: 'f5' });
    const L = latch([c0], FLAT);
    for (const b of [null, { ...FLAT, verified: false }]) expect(usage([c0], b as BrokerExposureInput | null, L)).toMatchObject({ slotsUsed: 1, heatCommitted: 99.8 });
  });
  it('(6) multiple historical candidates for the same ticker: released when flat; a new FIS trade counts once', () => {
    const hist = [cand({ id: 'h1' }), cand({ id: 'h2', date: '2026-10-30' }), cand({ id: 'h3', date: '2026-10-29' })];
    const L = latch(hist, FLAT);
    expect(usage(hist, FLAT, L).slotsUsed).toBe(0);
    const fresh = cand({ id: 'new', date: '2026-11-04', plannedRisk: 80, executionRev: 1 });
    expect(usage([...hist, fresh], HELD('FIS', '400'), L)).toMatchObject({ slotsUsed: 1, heatCommitted: 80 });
  });
  it('(7) closed exposure stays released while no new trade exists', () => {
    const c0 = cand({ id: 'f7' });
    const L = latch([c0], FLAT);
    for (let i = 0; i < 3; i++) expect(usage([c0], FLAT, L).slotsUsed).toBe(0);
  });
  it('(8) reload / repeated reconciliation is idempotent, and records stay auditable', () => {
    const c0 = cand({ id: 'f8' });
    const L1 = latch([c0], FLAT);
    const L2 = latch([c0], FLAT, L1);
    expect(L2).toBe(L1); // write-once: nothing rewritten
    expect(usage([c0], FLAT, L2)).toEqual(usage([c0], FLAT, L1));
    const reused = setStatus(setStatus(c0, 'MANUAL_EXIT'), 'FILLED');
    const L3 = latchReleases(L2, ex([reused], FLAT, L2).released).map; // released again for the NEW execution
    expect(L3.f8.fp).toBe(executionFingerprint(reused));
    expect(L3.f8.reason).toMatch(/superseded/); // the earlier release is referenced, not lost
  });
  it('(9) partial fills and partial exits keep the full reservation', () => {
    expect(usage([gm()], { verified: true, orders: [gmOrder({ status: 'partially_filled', filled_qty: '100' })], positions: [{ symbol: 'GM', qty: '100' }] }).heatCommitted).toBe(55);
    expect(usage([cand({})], HELD('FIS', '200')).heatCommitted).toBe(99.8);
  });
  it('(10) unknown / ambiguous lifecycle identity → kept', () => {
    expect(usage([gm()], { verified: true, orders: [gmOrder({ stop_price: '90.00' })], positions: [] }).slotsUsed).toBe(1);
    expect(usage([gm()], { verified: true, orders: [gmOrder({ id: 'a' }), gmOrder({ id: 'b' })], positions: [] }).slotsUsed).toBe(1);
    expect(usage([gm({ id: 'x' }), gm({ id: 'y' })], { verified: true, orders: [gmOrder({})], positions: [] }).slotsUsed).toBe(2);
    expect(usage([gm()], { verified: true, orders: [], positions: [] }).slotsUsed).toBe(1); // not at the broker yet
  });
  it('manual positions outside Alpaca and broker-only positions are counted', () => {
    const m: ManualPosition = { id: 'm', ticker: 'XYZ', direction: 'LONG', sector: 'S', industry: 'I', theme: '', positionValue: 1000, plannedRisk: 20, entry: 1, stop: 1, target: 1, status: 'OPEN' };
    expect(usage([], { verified: true, orders: [], positions: [] }, {}, [m]).slotsUsed).toBe(1);
    expect(usage([], HELD('NVDA', '10'))).toMatchObject({ slotsUsed: 1, heatCommitted: 250 });
    expect(usage([], HELD('NVDA', '-10')).exposures[0].direction).toBe('SHORT');
  });
});

describe('FIS Nov 2–3 on BOTH surfaces (6.2), then a new FIS trade', () => {
  const fis = cand({ id: 'fis-nov2' });
  const GS: AutoAlertRecord = recordWith({ symbol: 'GS', direction: 'SHORT', alertIso: '2026-11-03T12:05:05-05:00', price: 892.95, values: { open: 893.56, high: 894.09, low: 892.5, close: 893, atr: 1.8375076778270003, ema9: 895.3133353821252, ema20: 897.0266847594837, rsi: 27.00662554811956, rvol: 1.1679170196298305, vwap: 898.1619671909663, close15m: 893.59, ema20_15m: 899.7618719231194 } });
  const now = Date.parse('2026-11-03T17:06:00Z');
  const q: LiveQuote = { price: 893, tradeIso: new Date(now - 1500).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 };
  const surfaces = (cs: Candidate[], broker: BrokerExposureInput | null, latched: ReleasedExposureMap = {}) => {
    // Opportunity Ranker path (App.tsx): reconcile once → rankCandidates with the exclusion set.
    const x = reconcileExposure(cs, [], broker, { ...OPTS, latched, now });
    const ranker = rankCandidates(cs, x.positions, RK, '2026-11-03', undefined, x.exclude).portfolio;
    // Live Alert Queue path: the same inputs through buildQueue.
    const qo = buildQueue({ records: [GS], candidates: cs, positions: [], quotes: { GS: q }, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: RK, classify, parity: {}, strategyVersion: 'RB v1.1', broker: broker ?? undefined, releasedExposure: latched });
    return { ranker, queue: qo.rows.find((r) => r.record.alert.symbol === 'GS')!.ranked!.portfolio, qo, x };
  };
  const pick = (p: ReturnType<typeof buildPortfolio>) => ({ slots: p.slotsUsed, heat: p.heatCommitted, available: p.available, deployed: p.deployed, exposures: p.exposures.map((e) => `${e.ticker}:${e.kind}`).sort() });
  it('before (no verified broker data): both 1/4 slots, $99.80 heat', () => {
    const s = surfaces([fis], null);
    expect(pick(s.ranker)).toEqual(pick(s.queue));
    expect(s.ranker).toMatchObject({ slotsUsed: 1, heatCommitted: 99.8 });
  });
  it('after (Alpaca confirms closed): both 0/4 slots, $0 heat, same available capital and exposures; FIS record preserved', () => {
    const s = surfaces([fis], FLAT);
    expect(pick(s.ranker)).toEqual(pick(s.queue));
    expect(s.ranker).toMatchObject({ slotsUsed: 0, heatCommitted: 0 });
    expect(s.qo.candidates.find((c) => c.id === 'fis-nov2')).toMatchObject({ status: 'FILLED', notes: 'keep', plannedRisk: 99.8 });
  });
  it('the released FIS candidate is still listed and ranked on the Opportunity Ranker (history not hidden)', () => {
    const x = reconcileExposure([fis], [], FLAT, { ...OPTS, now });
    const r = rankCandidates([{ ...fis, date: '2026-11-03' }], x.positions, RK, '2026-11-03', undefined, x.exclude);
    expect(r.ranked.map((y) => y.candidate.id)).toEqual(['fis-nov2']);
  });
  it('portfolio-fit points are identical on both surfaces for the same alert', () => {
    const s = surfaces([fis], FLAT);
    const gsCand = s.qo.candidates.find((c) => c.ticker === 'GS')!;
    const x = reconcileExposure(s.qo.candidates, [], FLAT, { ...OPTS, now });
    const viaRanker = rankCandidates(s.qo.candidates, x.positions, RK, '2026-11-03', undefined, x.exclude).ranked.find((r) => r.candidate.id === gsCand.id)!;
    const viaQueue = s.qo.rows.find((r) => r.record.alert.symbol === 'GS')!.ranked!;
    expect(viaRanker.components.map((c) => [c.key, c.points])).toEqual(viaQueue.components.map((c) => [c.key, c.points]));
  });
  it('a new FIS trade after the release is counted on both surfaces — and still counted when the broker feed drops', () => {
    const L = latchReleases({}, surfaces([fis], FLAT).x.released).map;
    const fresh = cand({ id: 'fis-new', date: '2026-11-03', alertMs: Date.parse('2026-11-03T18:00:00Z'), plannedRisk: 80, executionRev: 1 });
    const live = surfaces([fis, fresh], HELD('FIS', '400'), L);
    expect(pick(live.ranker)).toEqual(pick(live.queue));
    expect(live.ranker).toMatchObject({ slotsUsed: 1, heatCommitted: 80 });
    const outage = surfaces([fis, fresh], null, L);
    expect(pick(outage.ranker)).toEqual(pick(outage.queue));
    expect(outage.ranker.slotsUsed).toBeGreaterThanOrEqual(1); // never zero while a new exposure exists
    expect(outage.ranker.exposures.some((e) => e.id === 'fis-new')).toBe(true);
  });
});
