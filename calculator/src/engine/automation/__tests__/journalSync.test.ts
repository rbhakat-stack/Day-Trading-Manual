/**
 * Broker → Journal sync (browser-local ledger). Fixtures mirror the 2026-11-02 Alpaca PAPER orders (GM stopped out,
 * FIS open) with synthetic ids. Read-only: nothing here can reach a broker.
 */
import { describe, expect, it } from 'vitest';
import { brokerOrdersFrom, journalEntryFromSync, reconcileBroker, syncJournal, withAlertTimeDecision, type SyncContext, type TradeSync } from '../lifecycle/brokerSync';
import type { AlertTimeSnapshot } from '../lifecycle/alertTimeSnapshot';
import { computeMetrics, journalScope, type JournalEntry } from '../../journal';

const NOCTX = (): SyncContext => ({ snap: null, candidate: null, record: null });
const iso = (hhmmss: string) => `2026-11-02T${hhmmss}Z`;

/** GM bracket: stop entry filled 223 @ 89.49, stop leg filled @ 89.19 (stopped out). */
const GM = (stage: 'pending' | 'filled' | 'closed') => ({
  id: 'gm-entry', symbol: 'GM', side: 'buy', type: 'stop', order_class: 'bracket', qty: '223', stop_price: '89.47', submitted_at: iso('19:06:53'),
  status: stage === 'pending' ? 'accepted' : 'filled', filled_qty: stage === 'pending' ? '0' : '223', filled_avg_price: stage === 'pending' ? null : '89.49', filled_at: stage === 'pending' ? null : iso('19:59:33'),
  legs: [
    { id: 'gm-tp', symbol: 'GM', side: 'sell', type: 'limit', status: stage === 'closed' ? 'canceled' : 'new', qty: '223', filled_qty: '0', filled_avg_price: null, submitted_at: iso('19:06:53') },
    { id: 'gm-sl', symbol: 'GM', side: 'sell', type: 'stop', status: stage === 'closed' ? 'filled' : 'held', qty: '223', filled_qty: stage === 'closed' ? '223' : '0', filled_avg_price: stage === 'closed' ? '89.19' : null, filled_at: stage === 'closed' ? iso('20:40:42') : null, submitted_at: iso('19:06:53') },
  ],
});
/** FIS bracket: stop entry filled 499 @ 40.05, both legs still working (position open). */
const FIS = {
  id: 'fis-entry', symbol: 'FIS', side: 'buy', type: 'stop', order_class: 'bracket', qty: '499', stop_price: '40.04', status: 'filled', filled_qty: '499', filled_avg_price: '40.05',
  submitted_at: iso('19:31:46'), filled_at: iso('20:23:43'),
  legs: [
    { id: 'fis-tp', symbol: 'FIS', side: 'sell', type: 'limit', status: 'new', qty: '499', filled_qty: '0', filled_avg_price: null, submitted_at: iso('19:31:46') },
    { id: 'fis-sl', symbol: 'FIS', side: 'sell', type: 'stop', status: 'held', qty: '499', filled_qty: '0', filled_avg_price: null, submitted_at: iso('19:31:46') },
  ],
};
const POSITIONS = [{ symbol: 'FIS', qty: '499' }];
const trades = (orders: unknown[], positions = POSITIONS) => reconcileBroker(brokerOrdersFrom(orders).orders, [], positions);

/** Minimal frozen alert-time snapshot (only the fields the sync reads). */
const snap = (decision: string, o: Partial<AlertTimeSnapshot> = {}): AlertTimeSnapshot => ({
  recordId: 'rec', ruleSet: 'RBTS-L-001', v11: { total: 74, tier: 'SKIP', decision, detail: '', components: null }, v12: { total: 71, max: 91, tierOptionA: 'SKIP', tierOptionB: 'WATCHLIST', decision: null },
  trade: { entry: 89.47, stop: 89.0, target: 90.41, shares: 223, positionValue: 19951.81, plannedRisk: 104.81, expectedReward: 209.62, orderType: 'BUY STOP' },
  ohlc: { open: 89.3, high: 89.45, low: 89.28, close: 89.44, atr: 0.2 }, provenance: { rulesVersion: 'RB v1.1' }, ...o,
}) as unknown as AlertTimeSnapshot;

describe('broker → journal mapping', () => {
  it('stopped-out trade (GM): 223 @ 89.49 → 223 @ 89.19, STOP_HIT, CLOSED, P/L −$66.90', () => {
    const e = journalEntryFromSync(trades([GM('closed')], [])[0], NOCTX());
    expect(e).toMatchObject({ source: 'broker_sync', brokerOrderId: 'gm-entry', ticker: 'GM', quantity: 223, actualFill: 89.49, exitPrice: 89.19, outcome: 'STOP_HIT', exitReason: 'STOP_HIT', positionStatus: 'CLOSED', brokerStatus: 'FILLED' });
    expect(computeMetrics([e]).totalPnl).toBeCloseTo(-66.9, 6);
    expect(e.entryFilledIso).toBe(iso('19:59:33').replace('Z', '.000Z'));
    expect(e.exitFilledIso).toBe(iso('20:40:42').replace('Z', '.000Z'));
  });
  it('open position (FIS): 499 @ 40.05, OPEN, no exit', () => {
    const e = journalEntryFromSync(trades([FIS])[0], NOCTX());
    expect(e).toMatchObject({ ticker: 'FIS', quantity: 499, actualFill: 40.05, exitPrice: null, outcome: 'OPEN', positionStatus: 'OPEN', exitReason: null });
  });
  it('filled entry, pending order, target hit, manual exit, EOD exit and canceled/unfilled', () => {
    const tgt = { ...GM('filled'), legs: [{ ...GM('filled').legs[0], status: 'filled', filled_qty: '223', filled_avg_price: '90.41', filled_at: iso('20:10:00') }, { ...GM('filled').legs[1], status: 'canceled' }] };
    expect(journalEntryFromSync(trades([tgt], [])[0], NOCTX())).toMatchObject({ outcome: 'TARGET_HIT', exitReason: 'TARGET_HIT', exitPrice: 90.41 });
    const close = (at: string) => ({ id: `x-${at}`, symbol: 'GM', side: 'sell', type: 'market', status: 'filled', qty: '223', filled_qty: '223', filled_avg_price: '89.60', submitted_at: iso(at), filled_at: iso(at), legs: [] });
    const open = { ...GM('filled'), legs: [] };
    expect(journalEntryFromSync(trades([open, close('18:30:00')].map((o, i) => (i ? o : { ...o, submitted_at: iso('17:00:00'), filled_at: iso('17:05:00') })), [])[0], NOCTX())).toMatchObject({ outcome: 'MANUAL_EXIT', exitReason: 'MANUAL_EXIT' });
    expect(journalEntryFromSync(trades([open, close('20:56:00')], [])[0], NOCTX())).toMatchObject({ outcome: 'MANUAL_EXIT', exitReason: 'CLOSED_EOD' });
    expect(journalEntryFromSync(trades([GM('filled')], [{ symbol: 'GM', qty: '223' }])[0], NOCTX())).toMatchObject({ outcome: 'OPEN', positionStatus: 'OPEN', brokerStatus: 'FILLED' });
    expect(journalEntryFromSync(trades([GM('pending')], [])[0], NOCTX())).toMatchObject({ outcome: 'OPEN', positionStatus: 'NONE', brokerStatus: 'PENDING', quantity: 0, actualFill: null });
    expect(journalEntryFromSync(trades([{ ...GM('pending'), status: 'canceled' }], [])[0], NOCTX())).toMatchObject({ outcome: 'CANCELED', exitReason: 'CANCELED', quantity: 0 });
  });
  it('no RB alert → strategy fields blank, no planned risk, no R invented', () => {
    const e = journalEntryFromSync(trades([GM('closed')], [])[0], NOCTX());
    expect(e).toMatchObject({ strategyDecision: 'NO ALERT', alertRecordId: null, expectedRisk: 0, plannedEntry: 0, v11Score: null, v12Score: null, plannedQty: null, ruleSet: null });
    expect(computeMetrics([e]).averageR).toBe(0);
    expect(computeMetrics([e]).closedTrades).toBe(1);
  });
  it('matched RB alert → frozen alert-time plan and scores, never recomputed from fills', () => {
    const t: TradeSync = { ...trades([GM('closed')], [])[0], recordId: 'rec' };
    const e = journalEntryFromSync(t, { snap: snap('NOT ELIGIBLE'), candidate: null, record: null });
    expect(e).toMatchObject({ plannedEntry: 89.47, stop: 89.0, target: 90.41, plannedQty: 223, expectedRisk: 104.81, v11Score: 74, v11Tier: 'SKIP', v12Score: 71, v12OptionA: 'SKIP', v12OptionB: 'WATCHLIST', ruleSet: 'RBTS-L-001', actualFill: 89.49 });
  });
});

describe('GM / FIS validation (independent states)', () => {
  const snaps = { gmRec: snap('NOT ELIGIBLE'), fisRec: snap('WATCHLIST') } as Record<string, AlertTimeSnapshot>;
  const base = trades([GM('closed'), FIS]).map((t) => ({ ...t, recordId: t.symbol === 'GM' ? 'gmRec' : 'fisRec' }));
  const [gm, fis] = withAlertTimeDecision(base, snaps);
  it('GM: Strategy NO TRADE · Override YES · Broker FILLED · Position CLOSED · stopped out', () => {
    expect(gm).toMatchObject({ strategyDecision: 'NO TRADE', manualOverride: true, brokerStatus: 'FILLED', positionStatus: 'CLOSED', exitReason: 'STOPPED OUT', realizedPL: -66.9 });
  });
  it('FIS: Strategy NO TICKET · Override YES · Broker FILLED · Position OPEN', () => {
    expect(fis).toMatchObject({ strategyDecision: 'NO TICKET', manualOverride: true, brokerStatus: 'FILLED', positionStatus: 'OPEN', entryQty: 499, entryAvg: 40.05 });
  });
  it('an alert RB ticketed at alert time stays READY (no override) even after it was marked submitted / expired', () => {
    const [t] = withAlertTimeDecision([{ ...base[0], strategyDecision: 'NO TICKET', manualOverride: true }], { gmRec: snap('HIGH PRIORITY — TRADE CONSIDERATION') });
    expect(t).toMatchObject({ strategyDecision: 'READY', manualOverride: false });
  });
});

describe('journal upsert', () => {
  it('identical broker responses polled repeatedly → one journal record each, same array when unchanged', () => {
    let j: JournalEntry[] = [];
    for (let i = 0; i < 5; i++) j = syncJournal(j, trades([GM('closed'), FIS]), NOCTX).journal;
    expect(j.map((e) => e.brokerOrderId)).toEqual(['gm-entry', 'fis-entry']);
    const again = syncJournal(j, trades([GM('closed'), FIS]), NOCTX);
    expect(again.changed).toBe(false);
    expect(again.journal).toBe(j);
  });
  it('pending → filled → closed updates the SAME record', () => {
    let r = syncJournal([], trades([GM('pending')], []), NOCTX);
    expect(r.added).toEqual(['broker-gm-entry']);
    r = syncJournal(r.journal, trades([GM('filled')], [{ symbol: 'GM', qty: '223' }]), NOCTX);
    expect([r.updated, r.journal.length, r.journal[0].outcome, r.journal[0].actualFill]).toEqual([['broker-gm-entry'], 1, 'OPEN', 89.49]);
    r = syncJournal(r.journal, trades([GM('closed')], []), NOCTX);
    expect([r.journal.length, r.journal[0].outcome, r.journal[0].exitPrice, r.journal[0].positionStatus]).toEqual([1, 'STOP_HIT', 89.19, 'CLOSED']);
  });
  it('never overwrites notes, the original strategy decision or frozen plan/scores', () => {
    const t0: TradeSync = { ...trades([GM('filled')], [{ symbol: 'GM', qty: '223' }])[0], recordId: 'rec', strategyDecision: 'NO TRADE', manualOverride: true };
    let j = syncJournal([], [t0], () => ({ snap: snap('NOT ELIGIBLE'), candidate: null, record: null })).journal;
    j = j.map((e) => ({ ...e, notes: 'my note' }));
    // a later poll with a different live decision and no snapshot context must not touch strategy fields
    const t1: TradeSync = { ...trades([GM('closed')], [])[0], recordId: 'rec', strategyDecision: 'READY', manualOverride: false };
    const e = syncJournal(j, [t1], NOCTX).journal[0];
    expect(e).toMatchObject({ notes: 'my note', strategyDecision: 'NO TRADE', manualOverride: true, plannedEntry: 89.47, stop: 89.0, target: 90.41, v11Score: 74, expectedRisk: 104.81, outcome: 'STOP_HIT', exitPrice: 89.19 });
  });
  it('manual entries are never modified; a look-alike manual entry is flagged, not merged', () => {
    const manual = { id: 'm1', ticker: 'GM', direction: 'LONG', date: '2026-11-02', time: '15:00', actualFill: 89.49, plannedEntry: 89.47, notes: 'mine', outcome: 'OPEN', quantity: 223 } as unknown as JournalEntry;
    const r = syncJournal([manual], trades([GM('closed')], []), NOCTX);
    expect(r.journal[0]).toBe(manual);
    expect(r.flagged).toEqual(['broker-gm-entry']);
    expect(r.journal[1].possibleDuplicateOf).toBe('m1');
  });
  it('the four states stay independent (every combination is representable)', () => {
    const e = syncJournal([], [{ ...trades([GM('closed')], [])[0], strategyDecision: 'NO TRADE', manualOverride: true }], NOCTX).journal[0];
    expect([e.strategyDecision, e.manualOverride, e.brokerStatus, e.positionStatus]).toEqual(['NO TRADE', true, 'FILLED', 'CLOSED']);
  });
  it('older journal entries (no broker fields) stay valid and round-trip through Backup/Restore JSON', () => {
    const old = { id: 'o', ticker: 'NVDA', date: '2026-10-29', time: '10:00', direction: 'LONG', open: 1, high: 1, low: 1, close: 1, atr: 1, alertPrice: 1, decision: 'BUY_STOP', orderType: 'BUY STOP', plannedEntry: 100, actualFill: 100, stop: 99, target: 102, quantity: 10, positionValue: 1000, expectedRisk: 10, expectedReward: 20, outcome: 'TARGET_HIT', exitPrice: 102, notes: '' } as JournalEntry;
    const synced = syncJournal([old], trades([FIS]), NOCTX).journal;
    expect(JSON.parse(JSON.stringify(synced))).toEqual(synced);
    expect(synced[0]).toBe(old);
  });
});

describe('dashboard scopes', () => {
  const rb = (id: string, entry: number, exit: number): JournalEntry => ({ id, ticker: id, date: '2026-10-29', time: '10:00', direction: 'LONG', open: 1, high: 1, low: 1, close: 1, atr: 1, alertPrice: 1, decision: 'BUY_STOP', orderType: 'BUY STOP', plannedEntry: entry, actualFill: entry, stop: entry - 1, target: entry + 2, quantity: 10, positionValue: 10 * entry, expectedRisk: 10, expectedReward: 20, outcome: exit > entry ? 'TARGET_HIT' : 'STOP_HIT', exitPrice: exit, notes: '' });
  const strategy = [rb('A', 100, 102), rb('B', 50, 49)];
  const overrides = syncJournal([], trades([GM('closed'), FIS]), NOCTX).journal; // NO ALERT → manual overrides
  const all = [...strategy, ...overrides];
  it('ALL / RB STRATEGY / MANUAL OVERRIDES partition the journal', () => {
    expect(journalScope(all, 'ALL')).toHaveLength(4);
    expect(journalScope(all, 'RB_STRATEGY').map((e) => e.id)).toEqual(['A', 'B']);
    expect(journalScope(all, 'MANUAL_OVERRIDE').map((e) => e.ticker)).toEqual(['GM', 'FIS']);
  });
  it('manual overrides do not change RB-strategy win rate or P/L', () => {
    const s = computeMetrics(journalScope(all, 'RB_STRATEGY'));
    const s0 = computeMetrics(strategy);
    expect([s.winRate, s.totalPnl, s.averageR, s.closedTrades]).toEqual([s0.winRate, s0.totalPnl, s0.averageR, s0.closedTrades]);
    expect(computeMetrics(journalScope(all, 'MANUAL_OVERRIDE'))).toMatchObject({ closedTrades: 1, open: 1, losses: 1 });
    expect(computeMetrics(journalScope(all, 'MANUAL_OVERRIDE')).totalPnl).toBeCloseTo(-66.9, 6);
  });
  it('a closed trade without planned risk has no R and does not pull average R toward 0', () => {
    expect(computeMetrics(all).averageR).toBe(computeMetrics(strategy).averageR);
  });
});
