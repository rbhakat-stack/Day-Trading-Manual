/**
 * Broker-only working entries — an open broker order that could OPEN exposure and that no active RB record represents
 * is reserved conservatively (PENDING). Fixtures are the real Alpaca PAPER orders:
 *   • CTVA (29 Oct, before the user canceled it on 3 Nov): bracket parent SELL STOP 5,000 @ 11.33 (new), legs BUY LIMIT
 *     11.23 and BUY STOP 11.38 (held); no CTVA position.
 *   • MCD (3 Nov): bracket entry BUY STOP 75 @ 263.45 filled 263.55; take-profit SELL LIMIT 268.33 (new), stop SELL STOP
 *     261.01 (held); position 75 long.
 *   • FIS (2–3 Nov): the cross-day release case, which must be unaffected.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue } from '../liveQueue';
import { rankCandidates } from '../../ranker/candidateRanker';
import { buildPortfolio } from '../../ranker/portfolioAllocator';
import type { Candidate, ManualPosition } from '../../ranker/opportunityTypes';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../settings';
import { recordWith } from './fixtures';
import { entryNote } from '../../../components/live/LiveQueuePage';
import { reconcileExposure, type BrokerExposureInput, type BrokerWorkingEntry, type ExposureAdjustment, type ReleasedExposureMap } from '../lifecycle/portfolioExposure';

const RK = cloneRankerDefaults();
const classify = (s: string) => ({ sector: ['FIS', 'GS', 'BAC'].includes(s) ? 'Financials' : `S-${s}`, industry: `I-${s}`, theme: '' });
const OPTS = { classify, conservativeRisk: 250, maxPositionValue: 20000 };
const NOW = Date.parse('2026-11-03T20:00:00Z');

// ── CTVA bracket exactly as Alpaca returned it before cancellation (sanitized fields) ──
const CTVA_TP = { id: '229f34d4-ctva-tp', symbol: 'CTVA', side: 'buy', type: 'limit', order_type: 'limit', status: 'held', qty: '5000', filled_qty: '0', filled_avg_price: null, stop_price: null, limit_price: '11.23', order_class: 'bracket', submitted_at: '2026-10-29T16:43:33.504017Z', legs: [] };
const CTVA_SL = { id: 'a965da73-ctva-sl', symbol: 'CTVA', side: 'buy', type: 'stop', order_type: 'stop', status: 'held', qty: '5000', filled_qty: '0', filled_avg_price: null, stop_price: '11.38', limit_price: null, order_class: 'bracket', submitted_at: '2026-10-29T16:43:33.504017Z', legs: [] };
const CTVA_PARENT = { id: 'dd98a97a-ctva-entry', symbol: 'CTVA', side: 'sell', type: 'stop', order_type: 'stop', status: 'new', qty: '5000', filled_qty: '0', filled_avg_price: null, stop_price: '11.33', limit_price: null, order_class: 'bracket', submitted_at: '2026-10-29T16:43:33.50834Z', legs: [CTVA_TP, CTVA_SL] };
const CTVA_CANCELED = { ...CTVA_PARENT, status: 'canceled', canceled_at: '2026-11-03T20:10:00Z', legs: [{ ...CTVA_TP, status: 'canceled' }, { ...CTVA_SL, status: 'canceled' }] };
// ── MCD ──
const MCD_TP = { id: 'mcd-tp', symbol: 'MCD', side: 'sell', type: 'limit', order_type: 'limit', status: 'new', qty: '75', filled_qty: '0', filled_avg_price: null, stop_price: null, limit_price: '268.33', order_class: 'bracket', submitted_at: '2026-11-03T19:17:35.465983Z', legs: [] };
const MCD_SL = { id: 'mcd-sl', symbol: 'MCD', side: 'sell', type: 'stop', order_type: 'stop', status: 'held', qty: '75', filled_qty: '0', filled_avg_price: null, stop_price: '261.01', limit_price: null, order_class: 'bracket', submitted_at: '2026-11-03T19:16:27.49Z', legs: [] };
const MCD_ENTRY = { id: 'mcd-entry', symbol: 'MCD', side: 'buy', type: 'stop', order_type: 'stop', status: 'filled', qty: '75', filled_qty: '75', filled_avg_price: '263.55', stop_price: '263.45', limit_price: null, order_class: 'bracket', submitted_at: '2026-11-03T19:16:27.495995Z', legs: [MCD_TP, MCD_SL] };
const MCD_POS = { symbol: 'MCD', qty: '75', side: 'long', avg_entry_price: '263.55', market_value: '19734' };
// ── FIS (cross-day release) ──
const FIS_ENTRY = { id: '7d5f0b6f-d32b-4e78-bcb2-999ad59264fc', symbol: 'FIS', side: 'buy', type: 'stop', status: 'filled', qty: '499', filled_qty: '499', filled_avg_price: '40.05', stop_price: '40.04', submitted_at: '2026-11-02T19:31:46.43689Z', order_class: 'bracket', legs: [
  { id: 'c7335d5d', symbol: 'FIS', side: 'sell', type: 'limit', status: 'canceled', qty: '499', filled_qty: '0', limit_price: '40.44', submitted_at: '2026-11-02T20:23:43.97Z', legs: [] },
  { id: '505618ca', symbol: 'FIS', side: 'sell', type: 'stop', status: 'filled', qty: '499', filled_qty: '499', filled_avg_price: '39.82', stop_price: '39.84', submitted_at: '2026-11-03T14:34:29.61Z', legs: [] },
] };
const FIS_STOP_TODAY = { id: '505618ca', symbol: 'FIS', side: 'sell', type: 'stop', status: 'filled', qty: '499', filled_qty: '499', filled_avg_price: '39.82', stop_price: '39.84', submitted_at: '2026-11-03T14:34:29.61Z', legs: [] };

/** The verified 3 Nov response: today's orders, MCD position, and the open-order list (nested legs). */
const live = (open: unknown[], o: Partial<BrokerExposureInput> = {}): BrokerExposureInput => ({ verified: true, orders: [FIS_STOP_TODAY, MCD_ENTRY], positions: [MCD_POS], openOrders: open, history: { '2026-11-02': [FIS_ENTRY] }, ...o });
const OPEN_BEFORE = [CTVA_PARENT, MCD_TP];  // Alpaca open list (nested): CTVA parent with its held legs; MCD take-profit row
const OPEN_AFTER = [MCD_TP];                // after the CTVA cancellation

const base = { source: 'AUTO', alertTime: '14:30', createdAt: 1, open: 40, high: 40.1, low: 39.9, close: 40.05, atr: 0.1, currentPrice: 40.05, orderType: 'BUY STOP', calcAction: 'BUY_STOP', calcReady: true, chaseDistanceAtr: 0, minutesSinceAlert: 1, scored: true, initialScore: null, entryScore: null, exitPrice: null, notes: 'keep', archived: false, keptAgainst: [] };
const FIS = { ...base, id: 'FIS-L-143019-593976', date: '2026-11-02', alertMs: Date.parse('2026-11-02T19:30:19.610Z'), ticker: 'FIS', direction: 'LONG', entry: 40.04, stop: 39.84, target: 40.44, shares: 499, positionValue: 19979.96, plannedRisk: 99.8, expectedReward: 199.6, status: 'PENDING', actualFill: null, inputs: { rvol: 2, rsi: 60, vwap: 40, ema9: 40, ema20: 39.9, close15m: 40, ema20_15m: 39.9, sector: 'Financials', industry: 'I-FIS', theme: '' } } as unknown as Candidate;
const MCD = { ...base, id: 'MCD-L-141600-mcd', date: '2026-11-03', alertMs: Date.parse('2026-11-03T19:15:00Z'), ticker: 'MCD', direction: 'LONG', entry: 263.45, stop: 261.01, target: 268.33, shares: 75, positionValue: 19758.75, plannedRisk: 183, expectedReward: 366, status: 'FILLED', actualFill: 263.55, executionRev: 1, inputs: { rvol: 2, rsi: 60, vwap: 263, ema9: 263, ema20: 262, close15m: 263, ema20_15m: 262, sector: 'S-MCD', industry: 'I-MCD', theme: '' } } as unknown as Candidate;
const cand = (c: Candidate, o: Partial<Candidate>) => ({ ...c, ...o } as Candidate);

const ex = (cs: Candidate[], b: BrokerExposureInput | null, known?: BrokerWorkingEntry[], latched: ReleasedExposureMap = {}, ps: ManualPosition[] = []) => reconcileExposure(cs, ps, b, { ...OPTS, latched, now: NOW, knownEntries: known });
const pf = (x: ExposureAdjustment) => buildPortfolio(x.positions, x.candidates, RK);

// Both decision surfaces exactly as App.tsx wires them (same broker input, releases and known entries).
const GS: AutoAlertRecord = recordWith({ symbol: 'GS', direction: 'SHORT', alertIso: '2026-11-03T14:55:00-05:00', price: 892.95, values: { open: 893.56, high: 894.09, low: 892.5, close: 893, atr: 1.84, ema9: 895.3, ema20: 897.0, rsi: 27, rvol: 1.9, vwap: 898.2, close15m: 893.59, ema20_15m: 899.8 } });
const Q: LiveQuote = { price: 893, tradeIso: new Date(NOW - 1500).toISOString(), fetchedIso: new Date(NOW - 500).toISOString(), receivedMs: NOW - 500 };
const surfaces = (cs: Candidate[], broker: BrokerExposureInput | null, known?: BrokerWorkingEntry[]) => {
  const x = ex(cs, broker, known);
  const ranker = rankCandidates(cs, x.positions, RK, '2026-11-03', undefined, x.exclude).portfolio;
  const qo = buildQueue({ records: [GS], candidates: cs, positions: [], quotes: { GS: Q }, now: NOW, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: RK, classify, parity: {}, strategyVersion: 'RB v1.1', broker: broker ?? undefined, releasedExposure: {}, knownBrokerEntries: known });
  return { x, ranker, queue: qo.rows.find((r) => r.record.alert.symbol === 'GS')!.ranked!.portfolio, qo };
};
const pick = (p: ReturnType<typeof buildPortfolio>) => ({ slots: p.slotsUsed, open: p.openPositions, pending: p.pendingOrders, deployed: p.deployed, reserved: p.reserved, heat: p.heatCommitted, available: p.available, exposures: p.exposures.map((e) => `${e.ticker}:${e.kind}:${e.plannedRisk}:${e.positionValue}`).sort() });

describe('CTVA working entry + MCD position + FIS released (the 3 Nov account before the CTVA cancellation)', () => {
  it('both surfaces: 2/4 slots, $433 heat — MCD once, CTVA once, FIS not counted', () => {
    const s = surfaces([FIS, MCD], live(OPEN_BEFORE));
    expect(pick(s.ranker)).toEqual(pick(s.queue));
    expect(pick(s.ranker)).toEqual({
      slots: 2, open: 1, pending: 1, deployed: 19758.75, reserved: 56650, heat: 433, available: 3591.25,
      exposures: ['CTVA:PENDING:250:56650', 'MCD:POSITION:183:19758.75'],
    });
    expect(s.x.released.map((r) => r.id)).toEqual(['FIS-L-143019-593976']);
  });
  it('CTVA is classified from the real order: SHORT entry, 5,000 sh, $56,650 notional, $250 risk to its bracket stop, flagged over the single-position limit', () => {
    expect(ex([FIS, MCD], live(OPEN_BEFORE)).entries).toEqual([{
      key: 'CTVA-SHORT', ticker: 'CTVA', direction: 'SHORT', orderIds: ['dd98a97a-ctva-entry'], qty: 5000, notional: 56650, plannedRisk: 250,
      riskBasis: 'BRACKET_STOP', flags: ['EXCEEDS_SINGLE_POSITION_LIMIT'], submittedAt: Date.parse('2026-10-29T16:43:33.50834Z'),
    }]);
  });
  it('after the cancellation is confirmed by a fresh verified response: 1/4, $183 — MCD only', () => {
    const s = surfaces([FIS, MCD], live(OPEN_AFTER, { history: { '2026-11-02': [FIS_ENTRY], '2026-10-29': [CTVA_CANCELED] } }));
    expect(pick(s.ranker)).toEqual(pick(s.queue));
    expect(pick(s.ranker)).toMatchObject({ slots: 1, open: 1, pending: 0, reserved: 0, heat: 183, exposures: ['MCD:POSITION:183:19758.75'] });
    expect(s.x.entries).toEqual([]);
  });
  it('the reservation survives an outage / stale data and is released only by a verified response', () => {
    // App flow: the known list is replaced only from a VERIFIED evaluation.
    const v1 = ex([FIS, MCD], live(OPEN_BEFORE));
    let known = v1.entriesSource === 'VERIFIED' ? v1.entries : [];
    for (const b of [null, { ...live(OPEN_BEFORE), verified: false }, live(OPEN_BEFORE, { openOrders: null }), live([{ id: 'x', status: 'new' }])]) {
      const s = surfaces([FIS, MCD], b, known);
      expect(pick(s.ranker)).toEqual(pick(s.queue));
      expect(s.x.entriesSource).toBe('LAST_KNOWN');
      expect(s.ranker.exposures.filter((e) => e.ticker === 'CTVA')).toEqual([expect.objectContaining({ kind: 'PENDING', plannedRisk: 250, positionValue: 56650 })]);
      if (s.x.entriesSource === 'VERIFIED') known = s.x.entries; // never: unverified data never replaces it
    }
    const after = ex([FIS, MCD], live(OPEN_AFTER), known);
    expect(after.entriesSource).toBe('VERIFIED');
    known = after.entries;
    expect(known).toEqual([]);
    expect(pf(ex([FIS, MCD], null, known)).exposures.some((e) => e.ticker === 'CTVA')).toBe(false);
  });
  it('the exposure note names the entry, its risk basis and the policy flag', () => {
    const [e] = ex([FIS, MCD], live(OPEN_BEFORE)).entries;
    expect(entryNote(e, 'VERIFIED')).toBe('CTVA broker-only working SHORT entry (5,000 sh, $56,650.00 potential) not in RB — reserved, $250.00 risk to its bracket stop · ⚠ exceeds the RB single-position limit');
    expect(entryNote(e, 'LAST_KNOWN')).toMatch(/kept from the last verified broker response/);
  });
});

describe('entry vs protective exit classification', () => {
  it('held bracket legs are never entries, even when returned as their own rows', () => {
    const rows = [{ ...CTVA_PARENT, legs: [] }, CTVA_TP, CTVA_SL];
    const x = ex([], live(rows));
    expect(x.entries.map((e) => [e.key, e.orderIds])).toEqual([['CTVA-SHORT', ['dd98a97a-ctva-entry']]]);
  });
  it('no nested legs anywhere (missing relationship): still counted, risk is a labelled estimate', () => {
    const [e] = ex([], live([{ ...CTVA_PARENT, legs: [] }])).entries;
    expect(e).toMatchObject({ notional: 56650, plannedRisk: 250, riskBasis: 'ESTIMATE' });
    expect(e.flags).toEqual(['RISK_ESTIMATED', 'EXCEEDS_SINGLE_POSITION_LIMIT']);
  });
  it('the bracket stop is taken from the verified day list when the open list has no legs', () => {
    const [e] = ex([], live([{ ...CTVA_PARENT, legs: [] }], { history: { '2026-10-29': [CTVA_PARENT] } })).entries;
    expect(e).toMatchObject({ riskBasis: 'BRACKET_STOP', plannedRisk: 250 });
  });
  it('ambiguous protective stops (two different stop legs) → estimate, never a guessed figure', () => {
    const odd = { ...CTVA_PARENT, legs: [CTVA_SL, { ...CTVA_SL, id: 'sl2', stop_price: '11.50' }] };
    expect(ex([], live([odd])).entries[0]).toMatchObject({ riskBasis: 'ESTIMATE', plannedRisk: 250 });
  });
  it('MCD: open position with take-profit (new) and stop (held) legs → one position, no extra slot', () => {
    for (const open of [[MCD_TP], [MCD_TP, MCD_SL], [{ ...MCD_TP, status: 'new' }, { ...MCD_SL, status: 'new' }]]) { // incl. an OCO with both legs live
      const x = ex([MCD], live(open));
      expect(x.entries).toEqual([]);
      expect(pf(x)).toMatchObject({ slotsUsed: 1, heatCommitted: 183, pendingOrders: 0 });
    }
  });
  it('MCD with no RB candidate: the position is added once ($250 conservative), its exit legs are not', () => {
    const x = ex([], live([MCD_TP, MCD_SL]));
    expect(x.entries).toEqual([]);
    expect(x.added).toEqual([{ ticker: 'MCD', qty: 75, plannedRisk: 250 }]);
    expect(pf(x)).toMatchObject({ slotsUsed: 1, heatCommitted: 250 });
  });
  it('an exit order larger than the position: only the excess counts as a (reversing) entry', () => {
    const big = { ...MCD_TP, id: 'big', qty: '200' };
    expect(ex([MCD], live([big])).entries).toEqual([expect.objectContaining({ ticker: 'MCD', direction: 'SHORT', qty: 125, flags: expect.arrayContaining(['EXCEEDS_POSITION']) })]);
  });
  it('an earlier-day GTC entry counts (CTVA was submitted 29 Oct)', () => {
    expect(ex([], live([CTVA_PARENT])).entries[0].submittedAt).toBe(Date.parse('2026-10-29T16:43:33.50834Z'));
  });
});

describe('aggregation, transitions and representation', () => {
  const nvda = (id: string, stop: string, qty = '100') => ({ id, symbol: 'NVDA', side: 'buy', type: 'stop', status: 'new', qty, filled_qty: '0', stop_price: stop, submitted_at: '2026-11-03T15:00:00Z', order_class: 'bracket', legs: [{ id: `${id}-sl`, symbol: 'NVDA', side: 'sell', type: 'stop', status: 'held', qty, filled_qty: '0', stop_price: String(Number(stop) - 1), legs: [] }, { id: `${id}-tp`, symbol: 'NVDA', side: 'sell', type: 'limit', status: 'held', qty, filled_qty: '0', limit_price: String(Number(stop) + 2), legs: [] }] });
  it('two independent working orders on one ticker: one exposure, quantity / notional / risk summed (never understated)', () => {
    const x = ex([], live([nvda('n1', '200'), nvda('n2', '205', '50')]));
    expect(x.entries).toEqual([expect.objectContaining({ key: 'NVDA-LONG', orderIds: ['n1', 'n2'], qty: 150, notional: 30250, plannedRisk: 150, riskBasis: 'BRACKET_STOP' })]);
    expect(pf(x).exposures.filter((e) => e.ticker === 'NVDA')).toHaveLength(1);
  });
  it('NEW → FILLED: the entry becomes a position and is counted once (by the RB candidate, or conservatively without one)', () => {
    const filledCtva = { symbol: 'CTVA', qty: '-5000', side: 'short', avg_entry_price: '11.33', market_value: '-56650' };
    const legsLive = [CTVA_SL, { ...CTVA_TP, status: 'new' }].map((l) => ({ ...l, status: l.id === CTVA_SL.id ? 'held' : 'new' }));
    const rb = { ...MCD, id: 'ctva-rb', ticker: 'CTVA', direction: 'SHORT', entry: 11.33, stop: 11.38, shares: 5000, positionValue: 56650, plannedRisk: 250, status: 'FILLED' } as unknown as Candidate;
    const withRb = ex([rb], live(legsLive, { positions: [filledCtva] }));
    expect(withRb.entries).toEqual([]);
    expect(pf(withRb).exposures.filter((e) => e.ticker === 'CTVA')).toEqual([expect.objectContaining({ kind: 'POSITION', id: 'ctva-rb' })]);
    const noRb = ex([], live(legsLive, { positions: [filledCtva] }));
    expect(noRb.entries).toEqual([]);
    expect(noRb.added).toEqual([{ ticker: 'CTVA', qty: -5000, plannedRisk: 250 }]);
    expect(pf(noRb).exposures.filter((e) => e.ticker === 'CTVA')).toHaveLength(1);
  });
  it('NEW → CANCELED: gone from the open list of a verified response → released', () => {
    expect(ex([], live([CTVA_PARENT])).entries).toHaveLength(1);
    expect(ex([], live([], { history: { '2026-10-29': [CTVA_CANCELED] } })).entries).toEqual([]);
  });
  it('partial entry fill: the filled part is the position, only the unfilled remainder is a working entry', () => {
    const partial = { ...CTVA_PARENT, status: 'partially_filled', filled_qty: '2000', filled_avg_price: '11.33' };
    const x = ex([], live([partial], { positions: [{ symbol: 'CTVA', qty: '-2000', side: 'short', avg_entry_price: '11.33' }] }));
    expect(x.entries).toEqual([expect.objectContaining({ qty: 3000, notional: 33990, plannedRisk: 150, riskBasis: 'BRACKET_STOP' })]);
    expect(x.added).toEqual([{ ticker: 'CTVA', qty: -2000, plannedRisk: 250 }]);
  });
  it('an order an RB candidate represents (ticker, direction, price within 2¢) is not counted twice', () => {
    const rbPending = cand(MCD, { id: 'ctva-pending', ticker: 'CTVA', direction: 'SHORT', entry: 11.33, stop: 11.38, shares: 5000, positionValue: 56650, plannedRisk: 250, status: 'PENDING' } as Partial<Candidate>);
    const x = ex([rbPending], live([CTVA_PARENT]));
    expect(x.entries).toEqual([]);
    expect(pf(x).exposures.filter((e) => e.ticker === 'CTVA')).toEqual([expect.objectContaining({ id: 'ctva-pending', kind: 'PENDING' })]);
  });
  it('an RB candidate at a different price does not hide the broker order: counted, flagged', () => {
    const other = cand(MCD, { id: 'ctva-other', ticker: 'CTVA', direction: 'SHORT', entry: 11.10, status: 'PENDING' } as Partial<Candidate>);
    expect(ex([other], live([CTVA_PARENT])).entries[0].flags).toContain('SAME_TICKER_RB_CANDIDATE');
  });
  it('a new working order at a historical candidate\'s price: no release (not flat), the candidate reserves, counted once', () => {
    const fisAgain = { ...CTVA_PARENT, id: 'fis-new', symbol: 'FIS', side: 'buy', stop_price: '40.04', legs: [] };
    const x = ex([FIS], live([fisAgain]));
    expect(x.released).toEqual([]); // the open FIS order makes FIS not flat → no release
    expect(pf(x).exposures.filter((e) => e.ticker === 'FIS')).toEqual([expect.objectContaining({ id: FIS.id, kind: 'PENDING' })]); // the candidate itself, once
  });
  it('unknown quantity / price: notional and risk are labelled estimates', () => {
    const e = ex([], live([{ id: 'm1', symbol: 'XYZ', side: 'buy', type: 'market', status: 'accepted', filled_qty: '0', legs: [] }])).entries[0];
    expect(e).toMatchObject({ notional: 20000, plannedRisk: 250, riskBasis: 'ESTIMATE' });
    expect(e.flags).toEqual(expect.arrayContaining(['NOTIONAL_ESTIMATED', 'RISK_ESTIMATED']));
  });
});

describe('preserved behaviour', () => {
  it('FIS cross-day release is unchanged by working entries elsewhere', () => {
    const x = ex([FIS, MCD], live(OPEN_BEFORE));
    expect(x.released).toEqual([expect.objectContaining({ id: FIS.id, orderId: FIS_ENTRY.id, reason: expect.stringMatching(/entry order 7d5f0b6f filled and the position is closed/) })]);
  });
  it('no open orders → no entries; no known entries during an outage → nothing added (as before)', () => {
    expect(ex([MCD], live([])).entries).toEqual([]);
    expect(ex([MCD], null)).toMatchObject({ entries: [], entriesSource: 'NONE', positions: [] });
  });
  it('allocator: a pending manual exposure is reserved, not deployed; totals are unchanged', () => {
    const p = { id: 'p', ticker: 'X', direction: 'LONG', sector: 'S', industry: 'I', theme: '', positionValue: 1000, plannedRisk: 50, entry: 10, stop: 9, target: 12, status: 'OPEN' } as ManualPosition;
    const a = buildPortfolio([p], [], RK), b = buildPortfolio([{ ...p, pending: true }], [], RK);
    expect([a.deployed, a.reserved, b.deployed, b.reserved]).toEqual([1000, 0, 0, 1000]);
    expect([a.slotsUsed, a.heatCommitted, a.available]).toEqual([b.slotsUsed, b.heatCommitted, b.available]);
  });
});
