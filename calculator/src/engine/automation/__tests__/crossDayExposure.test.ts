/**
 * Cross-day portfolio exposure — the exact FIS production case: a PENDING LONG candidate whose entry order filled on
 * 2 Nov and whose bracket stop leg filled on 3 Nov. Fixtures are the real (sanitized) rb-broker responses.
 * "Flat" needs no position AND no open order from any day; an earlier-dated entry order is identified only in its entry
 * day's VERIFIED order list. Anything unknown, stale, ambiguous or reused keeps the reservation.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue } from '../liveQueue';
import { rankCandidates } from '../../ranker/candidateRanker';
import { buildPortfolio } from '../../ranker/portfolioAllocator';
import type { Candidate, LifecycleStatus } from '../../ranker/opportunityTypes';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../settings';
import { recordWith } from './fixtures';
import {
  HISTORY_LOOKBACK_DAYS, HISTORY_MAX_DATES, executionRevPatch, historyDatesFor, latchReleases, reconcileExposure, verifiedHistory,
  type BrokerExposureInput, type ReleasedExposureMap,
} from '../lifecycle/portfolioExposure';

const RK = cloneRankerDefaults();
const classify = (s: string) => ({ sector: ['FIS', 'GS', 'BAC'].includes(s) ? 'Financials' : `S-${s}`, industry: `I-${s}`, theme: '' });
const OPTS = { classify, conservativeRisk: 250 };
const NOW = Date.parse('2026-11-03T18:30:00Z');

// Real rb-broker responses (sanitized fields only).
const STOP_LEG = { id: '505618ca-4522-47ef-8765-977b4808d7bf', symbol: 'FIS', side: 'sell', type: 'stop', order_type: 'stop', status: 'filled', qty: '499', filled_qty: '499', filled_avg_price: '39.82', stop_price: '39.84', limit_price: null, submitted_at: '2026-11-03T14:34:29.611077648Z', created_at: '2026-11-02T19:31:46.417345Z', filled_at: '2026-11-03T14:35:01.441751104Z', order_class: 'bracket', legs: [] };
const TP_LEG = { id: 'c7335d5d-3bfb-4149-8047-6186756723c2', symbol: 'FIS', side: 'sell', type: 'limit', order_type: 'limit', status: 'canceled', qty: '499', filled_qty: '0', filled_avg_price: null, stop_price: null, limit_price: '40.44', submitted_at: '2026-11-02T20:23:43.976707Z', created_at: '2026-11-02T19:31:46.417345Z', filled_at: null, canceled_at: '2026-11-03T14:34:29.602388819Z', order_class: 'bracket', legs: [] };
const ENTRY = { id: '7d5f0b6f-d32b-4e78-bcb2-999ad59264fc', symbol: 'FIS', side: 'buy', type: 'stop', order_type: 'stop', status: 'filled', qty: '499', filled_qty: '499', filled_avg_price: '40.05', stop_price: '40.04', limit_price: null, submitted_at: '2026-11-02T19:31:46.43689Z', created_at: '2026-11-02T19:31:46.417345Z', filled_at: '2026-11-02T20:23:43.96621Z', order_class: 'bracket', legs: [TP_LEG, STOP_LEG] };
const NOV2_ORDERS: unknown[] = [ENTRY];
const NOV3_ORDERS: unknown[] = [{ ...STOP_LEG, submitted_at: '2026-11-03T14:34:29.611078Z', filled_at: '2026-11-03T14:35:01.441751Z' }];

/** Today's (3 Nov) verified response: flat, nothing open. `history` = verified entry-day lists. */
const live = (o: Partial<BrokerExposureInput> = {}): BrokerExposureInput => ({ verified: true, orders: NOV3_ORDERS, positions: [], openOrders: [], ...o });
const WITH_NOV2 = live({ history: { '2026-11-02': NOV2_ORDERS } });

// The FIS candidate exactly as stored: PENDING, never marked FILLED, no execution revision (predates 6.1).
const FIS: Candidate = {
  id: 'fis-nov2', source: 'AUTO', date: '2026-11-02', alertTime: '14:30', alertMs: Date.parse('2026-11-02T19:30:19Z'), createdAt: 1, ticker: 'FIS', direction: 'LONG',
  open: 40, high: 40.1, low: 39.9, close: 40.05, atr: 0.1, currentPrice: 40.05, entry: 40.04, stop: 39.84, target: 40.44, shares: 499, positionValue: 19979.96, plannedRisk: 99.8, expectedReward: 199.6,
  orderType: 'BUY STOP', calcAction: 'BUY_STOP', calcReady: true, chaseDistanceAtr: 0, minutesSinceAlert: 1, scored: true, status: 'PENDING', initialScore: null, entryScore: null, actualFill: null, exitPrice: null,
  notes: 'keep', archived: false, keptAgainst: [], inputs: { rvol: 2, rsi: 60, vwap: 40, ema9: 40, ema20: 39.9, close15m: 40, ema20_15m: 39.9, sector: 'Financials', industry: 'I-FIS', theme: '' },
} as Candidate;
const cand = (o: Partial<Candidate>): Candidate => ({ ...FIS, ...o } as Candidate);
const setStatus = (c: Candidate, status: LifecycleStatus, at?: number): Candidate => ({ ...c, status, ...executionRevPatch(c, status, at) });
const order = (o: Record<string, unknown>) => ({ ...ENTRY, legs: [], ...o });

const ex = (cs: Candidate[], b: BrokerExposureInput | null, latched?: ReleasedExposureMap) => reconcileExposure(cs, [], b, { ...OPTS, latched, now: NOW });
const usage = (cs: Candidate[], b: BrokerExposureInput | null, latched?: ReleasedExposureMap) => { const x = ex(cs, b, latched); return buildPortfolio(x.positions, x.candidates, RK); };
const latch = (cs: Candidate[], b: BrokerExposureInput, prev: ReleasedExposureMap = {}) => latchReleases(prev, ex(cs, b, prev).released).map;

// Both decision surfaces, exactly as App.tsx wires them.
const GS: AutoAlertRecord = recordWith({ symbol: 'GS', direction: 'SHORT', alertIso: '2026-11-03T13:25:00-05:00', price: 892.95, values: { open: 893.56, high: 894.09, low: 892.5, close: 893, atr: 1.84, ema9: 895.3, ema20: 897.0, rsi: 27, rvol: 1.9, vwap: 898.2, close15m: 893.59, ema20_15m: 899.8 } });
const Q: LiveQuote = { price: 893, tradeIso: new Date(NOW - 1500).toISOString(), fetchedIso: new Date(NOW - 500).toISOString(), receivedMs: NOW - 500 };
const surfaces = (cs: Candidate[], broker: BrokerExposureInput | null, latched: ReleasedExposureMap = {}) => {
  const x = reconcileExposure(cs, [], broker, { ...OPTS, latched, now: NOW });
  const ranker = rankCandidates(cs, x.positions, RK, '2026-11-03', undefined, x.exclude);
  const qo = buildQueue({ records: [GS], candidates: cs, positions: [], quotes: { GS: Q }, now: NOW, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: RK, classify, parity: {}, strategyVersion: 'RB v1.1', broker: broker ?? undefined, releasedExposure: latched });
  return { ranker, queue: qo.rows.find((r) => r.record.alert.symbol === 'GS')!.ranked!.portfolio, qo, x };
};
const pick = (p: ReturnType<typeof buildPortfolio>) => ({ slots: p.slotsUsed, open: p.openPositions, pending: p.pendingOrders, reserved: p.reserved, deployed: p.deployed, heat: p.heatCommitted, available: p.available, exposures: p.exposures.map((e) => `${e.ticker}:${e.kind}`).sort() });

describe('FIS production case: PENDING entry 2 Nov, bracket stop filled 3 Nov, account flat', () => {
  it('before (today\'s orders only — production d9612a5): both surfaces 1/4, $19,979.96 reserved, $99.80 heat', () => {
    const s = surfaces([FIS], live());
    expect(pick(s.ranker.portfolio)).toEqual(pick(s.queue));
    expect(pick(s.ranker.portfolio)).toMatchObject({ slots: 1, open: 0, pending: 1, reserved: 19979.96, heat: 99.8, available: 60020.04 });
  });
  it('after (2 Nov entry-day list verified): both 0/4, $0 reserved, $0 heat — bound to entry order 7d5f0b6f', () => {
    const s = surfaces([FIS], WITH_NOV2);
    expect(pick(s.ranker.portfolio)).toEqual(pick(s.queue));
    expect(pick(s.ranker.portfolio)).toMatchObject({ slots: 0, pending: 0, reserved: 0, deployed: 0, heat: 0, available: 80000 });
    expect(s.x.released).toEqual([expect.objectContaining({ id: 'fis-nov2', orderId: ENTRY.id, reason: expect.stringMatching(/entry order 7d5f0b6f filled and the position is closed/) })]);
  });
  it('the FIS candidate record and notes are unchanged and it stays listed on the Ranker', () => {
    const before = JSON.stringify(FIS);
    const s = surfaces([FIS], WITH_NOV2);
    expect(JSON.stringify(s.qo.candidates.find((c) => c.id === 'fis-nov2'))).toBe(before);
    const r = rankCandidates([{ ...FIS, date: '2026-11-03' }], s.x.positions, RK, '2026-11-03', undefined, s.x.exclude);
    expect(r.ranked.map((y) => y.candidate.id)).toEqual(['fis-nov2']);
  });
  it('a new FIS order after the release consumes capacity on both surfaces — and still does when the feed drops', () => {
    const L = latch([FIS], WITH_NOV2);
    const fresh = cand({ id: 'fis-new', date: '2026-11-04', alertMs: Date.parse('2026-11-04T15:00:00Z'), plannedRisk: 80, positionValue: 16000, executionRev: 1 });
    const working = live({ openOrders: [order({ id: 'n1', status: 'new', submitted_at: '2026-11-04T15:01:00Z' })], history: { '2026-11-02': NOV2_ORDERS } });
    const on = surfaces([FIS, fresh], working, L);
    expect(pick(on.ranker.portfolio)).toEqual(pick(on.queue));
    expect(on.ranker.portfolio).toMatchObject({ slotsUsed: 1, heatCommitted: 80 });
    const outage = surfaces([FIS, fresh], null, L);
    expect(pick(outage.ranker.portfolio)).toEqual(pick(outage.queue));
    expect(outage.ranker.portfolio.exposures.some((e) => e.id === 'fis-new')).toBe(true);
  });
});

describe('11 scenarios', () => {
  it('(1) previous-day PENDING entry, next-day exit: released only with the verified entry-day list', () => {
    expect(usage([FIS], live())).toMatchObject({ slotsUsed: 1, heatCommitted: 99.8 });
    expect(usage([FIS], WITH_NOV2)).toMatchObject({ slotsUsed: 0, heatCommitted: 0 });
  });
  it('(2) prior-day GTC entry order still working, no position: never flat → reserved (PENDING and FILLED)', () => {
    const gtc = order({ id: 'g1', status: 'new', filled_qty: '0', filled_avg_price: null, filled_at: null });
    const b = live({ openOrders: [gtc], history: { '2026-11-02': [gtc] } });
    expect(usage([FIS], b)).toMatchObject({ slotsUsed: 1, heatCommitted: 99.8 });
    expect(usage([cand({ status: 'FILLED', actualFill: 40.05 })], b)).toMatchObject({ slotsUsed: 1, heatCommitted: 99.8 });
  });
  it('(2b) prior-day bracket leg still open (no position): never flat → reserved', () => {
    const heldLeg = { ...STOP_LEG, status: 'held', filled_qty: '0', filled_avg_price: null, filled_at: null };
    expect(usage([cand({ status: 'FILLED', actualFill: 40.05 })], live({ openOrders: [heldLeg] }))).toMatchObject({ slotsUsed: 1 });
    // …also when only the nested leg in the fetched entry-day list is still working
    const nested = order({ legs: [TP_LEG, heldLeg] });
    expect(usage([FIS], live({ history: { '2026-11-02': [nested] } }))).toMatchObject({ slotsUsed: 1 });
  });
  it('(3) unverified historical response: verifiedHistory drops failed / stale / wrong-date lists → reserved', () => {
    const ok = { status: 'LIVE', loadedDate: '2026-11-02', lastOkMs: NOW - 30_000, orders: NOV2_ORDERS };
    expect(verifiedHistory({ '2026-11-02': ok }, ['2026-11-02'], NOW)).toEqual({ '2026-11-02': NOV2_ORDERS });
    for (const bad of [{ ...ok, status: 'ERROR' }, { ...ok, status: 'OFF' }, { ...ok, lastOkMs: NOW - 121_000 }, { ...ok, lastOkMs: null }, { ...ok, loadedDate: '2026-11-03' }]) {
      const h = verifiedHistory({ '2026-11-02': bad }, ['2026-11-02'], NOW);
      expect(h).toEqual({});
      expect(usage([FIS], live({ history: h }))).toMatchObject({ slotsUsed: 1, heatCommitted: 99.8 });
    }
    expect(verifiedHistory({}, ['2026-11-02'], NOW)).toEqual({});
    expect(verifiedHistory({ '2026-10-01': ok }, ['2026-11-02'], NOW)).toEqual({}); // only requested dates
  });
  it('(4) ambiguous linkage: two matching entry orders, or two candidates claiming one order → reserved', () => {
    expect(usage([FIS], live({ history: { '2026-11-02': [ENTRY, order({ id: 'dup' })] } }))).toMatchObject({ slotsUsed: 1 });
    expect(usage([FIS, cand({ id: 'twin', createdAt: 2 })], WITH_NOV2)).toMatchObject({ slotsUsed: 2, heatCommitted: 199.6 });
    // no fallback: a different entry price, side or day is never "the latest FIS order"
    for (const o of [order({ stop_price: '40.20' }), order({ side: 'sell' }), order({ submitted_at: '2026-11-01T19:31:46Z' }), order({ submitted_at: '2026-11-02T19:00:00Z' })]) {
      expect(usage([FIS], live({ history: { '2026-11-02': [o] } }))).toMatchObject({ slotsUsed: 1 });
    }
  });
  it('(5) reused candidate: re-marked PENDING on a later day → the old 2 Nov order is never evidence', () => {
    const reused = setStatus(setStatus(FIS, 'CANCELED'), 'PENDING', Date.parse('2026-11-04T15:00:00Z'));
    expect(reused).toMatchObject({ executionRev: 1, executionStartedMs: Date.parse('2026-11-04T15:00:00Z') });
    expect(usage([reused], WITH_NOV2)).toMatchObject({ slotsUsed: 1, heatCommitted: 99.8 }); // no earlier release
    const L = latch([FIS], WITH_NOV2);
    expect(usage([reused], WITH_NOV2, L)).toMatchObject({ slotsUsed: 1, heatCommitted: 99.8 }); // earlier release voided
    expect(ex([reused], WITH_NOV2, L).voided[0]).toMatchObject({ id: 'fis-nov2', reason: expect.stringMatching(/new execution/) });
  });
  it('(6) same-status reuse: released, then a new FIS position appears with no other record → counted again', () => {
    const L = latch([FIS], WITH_NOV2);
    const held = live({ positions: [{ symbol: 'FIS', qty: '499', avg_entry_price: '40.10', market_value: '20000' }], history: { '2026-11-02': NOV2_ORDERS } });
    expect(usage([FIS], held, L)).toMatchObject({ slotsUsed: 1, heatCommitted: 99.8 });
    expect(ex([FIS], held, L).voided[0].reason).toMatch(/no other RB record represents/);
  });
  it('(7) broker outage / unknown open orders: nothing is released, even with the entry-day list', () => {
    expect(usage([FIS], null)).toMatchObject({ slotsUsed: 1, heatCommitted: 99.8 });
    expect(usage([FIS], { ...WITH_NOV2, verified: false })).toMatchObject({ slotsUsed: 1 });
    expect(usage([FIS], { ...WITH_NOV2, openOrders: null })).toMatchObject({ slotsUsed: 1 });
    expect(usage([FIS], { ...WITH_NOV2, openOrders: [{ id: 'x', status: 'new' }] })).toMatchObject({ slotsUsed: 1 }); // unreadable open order
    const L = latch([FIS], WITH_NOV2);
    expect(usage([FIS], null, L)).toMatchObject({ slotsUsed: 1, heatCommitted: 99.8 }); // earlier release not applied either
  });
  it('(8) new entry after the old exit: a today-dated PENDING with no order yet is reserved; the old one stays released', () => {
    const L = latch([FIS], WITH_NOV2);
    const next = cand({ id: 'fis-nov3', date: '2026-11-03', alertMs: Date.parse('2026-11-03T18:00:00Z'), executionRev: 1, executionStartedMs: Date.parse('2026-11-03T18:05:00Z') });
    expect(usage([FIS, next], WITH_NOV2, L)).toMatchObject({ slotsUsed: 1, heatCommitted: 99.8 });
    expect(ex([FIS, next], WITH_NOV2, L).exclude.has('fis-nov2')).toBe(true);
  });
  it('(9) repeated polling: identical result every time; the release is written once', () => {
    let L: ReleasedExposureMap = {};
    for (let i = 0; i < 5; i++) {
      const next = latchReleases(L, ex([FIS], WITH_NOV2, L).released);
      expect(next.changed).toBe(i === 0);
      L = next.map;
      expect(usage([FIS], WITH_NOV2, L)).toMatchObject({ slotsUsed: 0, heatCommitted: 0 });
    }
    expect(Object.keys(L)).toEqual(['fis-nov2']);
  });
  it('(10) browser reload: persisted release + fresh feeds → same result; entry-day list temporarily missing keeps it released', () => {
    const L = JSON.parse(JSON.stringify(latch([FIS], WITH_NOV2))) as ReleasedExposureMap;
    expect(usage([FIS], WITH_NOV2, L)).toMatchObject({ slotsUsed: 0 });
    expect(usage([FIS], live(), L)).toMatchObject({ slotsUsed: 0 }); // same execution, flat, today's feed verified
    expect(usage([FIS], live({ openOrders: null }), L)).toMatchObject({ slotsUsed: 1 }); // open orders unknown → counted
  });
  it('(11) multiple same-ticker candidates on different days: each matched only to its own day\'s order', () => {
    const oct30 = cand({ id: 'fis-oct30', date: '2026-10-30', alertMs: Date.parse('2026-10-30T14:00:00Z'), entry: 41.5, createdAt: 0 });
    const oct30Order = order({ id: 'o30', stop_price: '41.50', status: 'canceled', filled_qty: '0', filled_avg_price: null, filled_at: null, submitted_at: '2026-10-30T14:01:00Z' });
    expect(ex([oct30, FIS], live({ history: { '2026-11-02': NOV2_ORDERS } })).released.map((r) => r.id)).toEqual(['fis-nov2']);
    const both = ex([oct30, FIS], live({ history: { '2026-11-02': NOV2_ORDERS, '2026-10-30': [oct30Order] } }));
    expect(both.released.map((r) => [r.id, r.orderId])).toEqual([['fis-oct30', 'o30'], ['fis-nov2', ENTRY.id]]);
  });
  it('partial exit: a remaining position keeps the full planned risk', () => {
    expect(usage([FIS], live({ positions: [{ symbol: 'FIS', qty: '200' }], history: { '2026-11-02': NOV2_ORDERS } }))).toMatchObject({ slotsUsed: 1, heatCommitted: 99.8 });
  });
  it('historical FILLED candidate: released when flat with no open order on any day, bound to its entry order', () => {
    const filled = cand({ status: 'FILLED', actualFill: 40.05 });
    expect(ex([filled], WITH_NOV2).released).toEqual([expect.objectContaining({ id: 'fis-nov2', orderId: ENTRY.id })]);
    expect(ex([filled], live()).released).toEqual([expect.objectContaining({ id: 'fis-nov2', orderId: null })]);
    expect(usage([filled], live({ openOrders: [order({ id: 'w', status: 'accepted' })] }))).toMatchObject({ slotsUsed: 1 });
  });
});

describe('bounded entry-day requests', () => {
  it('only earlier-dated active PENDING / FILLED candidates, deduplicated, newest first, at most 5 dates within 10 days', () => {
    expect(HISTORY_MAX_DATES).toBe(5);
    expect(HISTORY_LOOKBACK_DAYS).toBe(10);
    const at = (date: string, o: Partial<Candidate> = {}) => cand({ id: `${date}-${o.status ?? 'P'}-${o.archived ? 'a' : ''}`, date, ...o });
    const cs = [
      at('2026-11-02'), at('2026-11-02', { status: 'FILLED' }), at('2026-11-03'), at('2026-10-31'), at('2026-10-30'), at('2026-10-29'), at('2026-10-28'), at('2026-10-27'),
      at('2026-10-20'), at('2026-11-01', { status: 'STOPPED_OUT' }), at('2026-10-26', { archived: true }), at('2026-10-25', { status: 'NEW' }), at('bad-date'),
    ];
    expect(historyDatesFor(cs, '2026-11-03')).toEqual(['2026-11-02', '2026-10-31', '2026-10-30', '2026-10-29', '2026-10-28']);
    expect(historyDatesFor(cs, '2026-11-03', 10)).toEqual(['2026-11-02', '2026-10-31', '2026-10-30', '2026-10-29', '2026-10-28', '2026-10-27']);
    expect(historyDatesFor([FIS], '2026-11-02')).toEqual([]);
    expect(historyDatesFor([], '2026-11-03')).toEqual([]);
  });
  it('beyond the lookback a candidate is never released (no evidence fetched) — it keeps reserving', () => {
    const old = cand({ id: 'old', date: '2026-10-01', alertMs: Date.parse('2026-10-01T15:00:00Z') });
    expect(historyDatesFor([old], '2026-11-03')).toEqual([]);
    expect(usage([old], live())).toMatchObject({ slotsUsed: 1 });
  });
  it('execution start is stamped only when a time is given (existing callers unchanged)', () => {
    expect(executionRevPatch(cand({ status: 'NEW' }), 'PENDING')).toEqual({ executionRev: 1 });
    expect(executionRevPatch(cand({ status: 'NEW' }), 'PENDING', 5)).toEqual({ executionRev: 1, executionStartedMs: 5 });
    expect(executionRevPatch(FIS, 'FILLED', 5)).toEqual({});
  });
});
