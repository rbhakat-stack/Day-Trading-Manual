/**
 * CR-15 cross-day Journal reconciliation. The pre-CR-15 Journal is rebuilt with the real (unchanged) day-by-day sync
 * from the real 2 / 3 Nov broker day lists — which is exactly how the phantom FIS SHORT was written — then reconciled
 * against the real multi-day broker history (cr15-broker-orders.json).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { brokerOrdersFrom, reconcileBroker, syncJournal, type SyncContext } from '../lifecycle/brokerSync';
import {
  applyCrossDay, cr15Gate, crossDayEvidenceVerified, crossDayRequest, openBrokerTrades, planCrossDay, validateReconciledJournal,
  type CrossDayEvidence,
} from '../lifecycle/crossDayJournal';
import { activeEntries, computeMetrics, tradePnl, tradeR, type JournalEntry } from '../../journal';
import { ensurePreCr15Backup, JOURNAL_KEY, PRE_CR15_BACKUP_KEY, PRE_RESTORE_KEY, readBackup, restorePreCr15, type KeyValueStore } from '../../../lib/journalBackup';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FX = JSON.parse(readFileSync(join(__dirname, 'cr15-broker-orders.json'), 'utf8')) as { orders: Raw[]; positions: Raw[] };
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const bySym = (s: string) => FX.orders.filter((o) => o.symbol === s);
const FIS_P = bySym('FIS')[0];
const MCD_P = bySym('MCD')[0];
const GM_P = bySym('GM')[0];
const FIS_STOP = FIS_P.legs.find((l: Raw) => l.type === 'stop');
const leg = (p: Raw, type: string) => p.legs.find((l: Raw) => l.type === type);

/* ── the pre-CR-15 Journal, written by the unchanged day-by-day sync ── */
const noCtx = (): SyncContext => ({ snap: null, candidate: null, record: null });
const day = (orders: Raw[], positions: Raw[]) => reconcileBroker(brokerOrdersFrom(orders).orders, [], positions as never);
function legacyJournal(): JournalEntry[] {
  // 2 Nov after the close: GM closed same day; FIS bracket still working (TP new, SL held), 499 FIS held.
  const fisNov2 = { ...clone(FIS_P), legs: [{ ...leg(FIS_P, 'limit'), status: 'new', canceled_at: null }, { ...leg(FIS_P, 'stop'), status: 'held', filled_qty: '0', filled_avg_price: null, filled_at: null }] };
  let j = syncJournal([], day([clone(GM_P), fisNov2], [{ symbol: 'FIS', qty: '499', side: 'long' }]), noCtx).journal;
  // 3 Nov: the FIS stop leg is listed on its own (its parent is outside the day window) → the phantom SHORT; MCD opened.
  j = syncJournal(j, day([{ ...clone(FIS_STOP), legs: [] }, clone(MCD_P)], [{ symbol: 'MCD', qty: '75', side: 'long' }]), noCtx).journal;
  // Frozen plan / scores / your notes, as the production rows carry them (alert-owned + user-owned fields).
  return j.map((e) => e.ticker === 'FIS' && e.direction === 'LONG' ? { ...e, plannedEntry: 40.04, stop: 39.84, target: 40.44, expectedRisk: 99.8, plannedQty: 499, notes: 'FIS overnight — my note' }
    : e.ticker === 'MCD' ? { ...e, plannedEntry: 263.45, stop: 261.01, target: 268.33, expectedRisk: 183, plannedQty: 75, v11Score: 89, v11Tier: 'HIGH_PRIORITY', v12Score: 80, v12OptionB: 'HIGH_PRIORITY', ruleSet: 'RBTS-L-001', strategyDecision: 'READY', manualOverride: false, notes: 'MCD keep' }
      : e.ticker === 'GM' ? { ...e, plannedEntry: 89.47, stop: 89.22, target: 89.97, expectedRisk: 55.75, plannedQty: 223 } : e);
}
const J0 = legacyJournal();
const row = (j: JournalEntry[], f: (e: JournalEntry) => boolean) => j.find(f)!;
const FIS_LONG = (j: JournalEntry[]) => row(j, (e) => e.ticker === 'FIS' && e.direction === 'LONG');
const FIS_SHORT = (j: JournalEntry[]) => row(j, (e) => e.ticker === 'FIS' && e.direction === 'SHORT');
const MCD_ROW = (j: JournalEntry[]) => row(j, (e) => e.ticker === 'MCD');
const GM_ROW = (j: JournalEntry[]) => row(j, (e) => e.ticker === 'GM');

const ev = (orders: Raw[], positions: Raw[], o: Partial<CrossDayEvidence> = {}): CrossDayEvidence => ({ verified: true, complete: true, from: '2026-11-02', symbols: ['FIS', 'MCD'], orders, positions: positions as never, asOfMs: Date.parse('2026-11-03T21:30:00Z'), ...o });
const REAL = () => ev(clone(FX.orders.filter((o) => ['FIS', 'MCD'].includes(o.symbol))), clone(FX.positions));
const NOW = '2026-11-03T21:30:00.000Z';
const run = (j: JournalEntry[], e: CrossDayEvidence) => { const p = planCrossDay(j, e); return { p, j: applyCrossDay(j, p, NOW) }; };

/** MCD bracket variants on 4 Nov (synthetic exits on the real MCD order). */
const mcdWith = (o: { sl?: Raw; tp?: Raw }) => ({ ...clone(MCD_P), legs: [{ ...leg(MCD_P, 'limit'), ...(o.tp ?? { status: 'canceled', canceled_at: '2026-11-04T15:00:00Z' }) }, { ...leg(MCD_P, 'stop'), ...(o.sl ?? { status: 'canceled', canceled_at: '2026-11-04T15:00:00Z' }) }] });
const nov4 = (mcd: Raw, extra: Raw[] = [], positions: Raw[] = []) => ev([clone(FIS_P), mcd, ...extra], positions, { asOfMs: Date.parse('2026-11-04T21:00:00Z') });

describe('the pre-CR-15 Journal (as production wrote it)', () => {
  it('FIS LONG stayed OPEN; a phantom FIS SHORT was written for the 3 Nov stop leg; GM closed; MCD open', () => {
    expect(J0.map((e) => `${e.ticker} ${e.direction} ${e.outcome}`).sort()).toEqual(['FIS LONG OPEN', 'FIS SHORT MANUAL_EXIT', 'GM LONG STOP_HIT', 'MCD LONG OPEN']);
    expect(FIS_SHORT(J0).brokerOrderId).toBe(FIS_STOP.id);
    expect(computeMetrics(J0)).toMatchObject({ totalEntries: 4, closedTrades: 1, open: 2 });
  });
});

describe('real cases (1–10)', () => {
  const { p, j } = run(J0, REAL());
  it('(1, 2) FIS 2 Nov LONG closed by its 3 Nov bracket stop: 499 @ 39.82, STOP_HIT, realized −$114.77', () => {
    const x = p.trades.find((t) => t.symbol === 'FIS')!;
    expect(x).toMatchObject({ status: 'CLOSED', closedQty: 499, realizedPnl: -114.77, entry: { qty: 499, avg: 40.05 } });
    expect(x.exits).toEqual([expect.objectContaining({ orderId: FIS_STOP.id, qty: 499, avg: 39.82, reason: 'STOP_HIT', evidence: 'BRACKET_LEG' })]);
    expect(FIS_LONG(j)).toMatchObject({ outcome: 'STOP_HIT', exitPrice: 39.82, exitQty: 499, exitReason: 'STOP_HIT', positionStatus: 'CLOSED', realizedPnl: -114.77, exitOrderIds: [FIS_STOP.id], reconciliation: 'CR15', reconciledIso: NOW });
    expect(tradePnl(FIS_LONG(j))).toBe(-114.77);
    expect(tradeR(FIS_LONG(j))).toBe(-1.15); // −114.77 ÷ frozen planned risk 99.80 (never the slippage-adjusted risk)
  });
  it('(3) the phantom SHORT is superseded by the LONG\'s exit — kept with its order id, excluded from the Dashboard', () => {
    expect(p.supersede).toEqual([expect.objectContaining({ id: FIS_SHORT(J0).id, by: FIS_LONG(J0).id, orderId: FIS_STOP.id })]);
    const s = FIS_SHORT(j);
    expect(s).toMatchObject({ supersededBy: FIS_LONG(J0).id, brokerOrderId: FIS_STOP.id, direction: 'SHORT', supersededIso: NOW });
    expect(s.supersededReason).toMatch(/Exit of LONG FIS/);
    expect(j).toHaveLength(J0.length); // nothing deleted
    expect(activeEntries(j).map((e) => e.id)).not.toContain(s.id);
  });
  it('(4, 35) strategy decision, manual override, plan, scores and notes are preserved', () => {
    for (const k of ['strategyDecision', 'manualOverride', 'plannedEntry', 'stop', 'target', 'expectedRisk', 'plannedQty', 'notes', 'date', 'time', 'alertLinkage'] as const) expect(FIS_LONG(j)[k]).toEqual(FIS_LONG(J0)[k]);
    expect(validateReconciledJournal(J0, j)).toBeNull();
    expect(MCD_ROW(j)).toBe(MCD_ROW(J0)); // untouched object
  });
  it('(5) MCD stays one OPEN LONG until a broker-confirmed exit: no invented exit or P/L', () => {
    expect(p.trades.find((t) => t.symbol === 'MCD')).toMatchObject({ status: 'OPEN', closedQty: 0, realizedPnl: null, patch: null });
  });
  it('(6) MCD stop fills on 4 Nov → the same LONG closes, STOP_HIT, P/L from the actual fill', () => {
    const r = run(J0, nov4(mcdWith({ sl: { status: 'filled', filled_qty: '75', filled_avg_price: '260.95', filled_at: '2026-11-04T15:10:00Z' } })));
    expect(MCD_ROW(r.j)).toMatchObject({ outcome: 'STOP_HIT', exitPrice: 260.95, exitQty: 75, realizedPnl: -195, plannedEntry: 263.45, expectedRisk: 183, v11Score: 89, v12Score: 80, notes: 'MCD keep' });
    expect(r.j.filter((e) => e.ticker === 'MCD')).toHaveLength(1); // no phantom MCD SHORT
  });
  it('(7) MCD target fills on 4 Nov → TARGET_HIT', () => {
    const r = run(J0, nov4(mcdWith({ tp: { status: 'filled', filled_qty: '75', filled_avg_price: '268.33', filled_at: '2026-11-04T17:00:00Z' } })));
    expect(MCD_ROW(r.j)).toMatchObject({ outcome: 'TARGET_HIT', exitPrice: 268.33, realizedPnl: 358.5 });
  });
  it('(8, 18) MCD manual close on 4 Nov (sell_to_close) → MANUAL_EXIT; after 15:50 ET → CLOSED_EOD', () => {
    const close = (at: string) => ({ id: 'mcd-manual', symbol: 'MCD', side: 'sell', type: 'market', status: 'filled', qty: '75', filled_qty: '75', filled_avg_price: '264.00', submitted_at: at, filled_at: at, order_class: '', position_intent: 'sell_to_close', legs: [] });
    const a = run(J0, nov4(mcdWith({}), [close('2026-11-04T16:00:00Z')]));
    expect(MCD_ROW(a.j)).toMatchObject({ outcome: 'MANUAL_EXIT', exitReason: 'MANUAL_EXIT', realizedPnl: 33.75, exitOrderIds: ['mcd-manual'] });
    expect(a.p.trades.find((t) => t.symbol === 'MCD')!.exits[0].evidence).toBe('POSITION_INTENT');
    const b = run(J0, nov4(mcdWith({}), [close('2026-11-04T20:52:00Z')]));
    expect(MCD_ROW(b.j)).toMatchObject({ outcome: 'MANUAL_EXIT', exitReason: 'CLOSED_EOD' });
  });
  it('(9) GM (already closed: 223 @ 89.49 → 89.19, −$66.90, −1.20 R) is unchanged', () => {
    const g = GM_ROW(j);
    expect(g).toBe(GM_ROW(J0));
    expect([g.outcome, g.actualFill, g.exitPrice, tradePnl(g), tradeR(g)]).toEqual(['STOP_HIT', 89.49, 89.19, -66.9, -1.2]);
  });
  it('(10) CTVA canceled bracket: no completed trade, no P/L', () => {
    const ctva = syncJournal([], day(clone(bySym('CTVA').filter((o) => o.qty === '5000')), []), noCtx).journal;
    expect(ctva.map((e) => e.outcome)).toEqual(['CANCELED']);
    const r = run(ctva, ev(clone(bySym('CTVA')), [], { symbols: ['CTVA'], from: '2026-10-29' }));
    expect(r.j).toBe(ctva);
    expect(computeMetrics(r.j)).toMatchObject({ closedTrades: 0, canceled: 1, totalPnl: 0 });
  });
  it('(38) Dashboard: one logical FIS trade, not two broker legs', () => {
    const m = computeMetrics(j);
    expect(m).toMatchObject({ totalEntries: 3, closedTrades: 2, open: 1, losses: 2, totalPnl: -181.67 });
    expect(m.byTicker.map((g) => [g.key, g.trades, g.totalPnl])).toEqual([['FIS', 1, -114.77], ['GM', 1, -66.9]]);
  });
});

/* ── generic order builders for lifecycle cases ── */
let n = 0;
const ord = (o: Raw): Raw => ({ id: `o${++n}`, symbol: 'XYZ', side: 'buy', type: 'stop', status: 'filled', qty: '100', filled_qty: '100', filled_avg_price: '10.00', stop_price: '10.00', submitted_at: '2026-11-02T15:00:00Z', filled_at: '2026-11-02T15:01:00Z', order_class: 'bracket', position_intent: null, legs: [], ...o });
const bracket = (entry: Raw, sl: Raw, tp: Raw): Raw => ({ ...entry, legs: [ord({ side: entry.side === 'buy' ? 'sell' : 'buy', type: 'stop', status: 'held', filled_qty: '0', filled_avg_price: null, filled_at: null, ...sl }), ord({ side: entry.side === 'buy' ? 'sell' : 'buy', type: 'limit', status: 'new', filled_qty: '0', filled_avg_price: null, filled_at: null, ...tp })] });
const trade = (o: Raw, j: Partial<JournalEntry> = {}): JournalEntry => ({ id: `broker-${o.id}`, ticker: o.symbol, date: '2026-11-02', time: '10:01', direction: o.side === 'buy' ? 'LONG' : 'SHORT', open: 0, high: 0, low: 0, close: 0, atr: 0, alertPrice: 0, decision: 'BUY_STOP', orderType: 'BUY STOP', plannedEntry: 10, actualFill: Number(o.filled_avg_price), stop: 9.5, target: 11, quantity: Number(o.filled_qty), positionValue: 1000, expectedRisk: 50, expectedReward: 100, outcome: 'OPEN', exitPrice: null, notes: 'n', source: 'broker_sync', brokerOrderId: o.id, alertRecordId: null, alertLinkage: 'NO_PRICE_MATCH', strategyDecision: 'NO ALERT', manualOverride: true, positionStatus: 'OPEN', ...j } as JournalEntry);
const xev = (orders: Raw[], positions: Raw[] = [], symbols = ['XYZ']) => ev(orders, positions, { symbols });

describe('order lifecycle (11–25)', () => {
  it('(11) LONG overnight: day-2 stop leg closes it', () => {
    const e = bracket(ord({}), { status: 'filled', filled_qty: '100', filled_avg_price: '9.50', filled_at: '2026-11-03T15:00:00Z' }, { status: 'canceled' });
    expect(planCrossDay([trade(e)], xev([e])).trades[0]).toMatchObject({ status: 'CLOSED', realizedPnl: -50 });
  });
  it('(12) SHORT overnight: day-2 BUY stop leg closes the SHORT (P/L sign by direction)', () => {
    const e = bracket(ord({ side: 'sell', position_intent: 'sell_to_open' }), { status: 'filled', filled_qty: '100', filled_avg_price: '10.40', filled_at: '2026-11-03T15:00:00Z' }, { status: 'canceled' });
    const x = planCrossDay([trade(e)], xev([e])).trades[0];
    expect(x).toMatchObject({ direction: 'SHORT', status: 'CLOSED', realizedPnl: -40 });
  });
  it('(13, 20) partial entry fill, rest canceled: the trade is the filled 60 shares', () => {
    const e = bracket(ord({ status: 'canceled', filled_qty: '60' }), { status: 'filled', filled_qty: '60', filled_avg_price: '10.50', filled_at: '2026-11-03T15:00:00Z' }, { status: 'canceled' });
    expect(planCrossDay([trade(e)], xev([e])).trades[0]).toMatchObject({ status: 'CLOSED', closedQty: 60, realizedPnl: 30, entry: { qty: 60 } });
  });
  it('(14) partial exit: stays OPEN, partial realized P/L recorded, no exit price', () => {
    const e = bracket(ord({}), { status: 'partially_filled', filled_qty: '40', filled_avg_price: '9.50', filled_at: '2026-11-03T15:00:00Z' }, { status: 'held' });
    const { j } = run([trade(e)], xev([e], [{ symbol: 'XYZ', qty: '60', side: 'long' }]));
    expect(j[0]).toMatchObject({ outcome: 'OPEN', exitPrice: null, exitQty: 40, realizedPnl: -20 });
    expect(tradePnl(j[0])).toBeNull();
  });
  it('(15) several partial exits across days → CLOSED at the weighted average exit', () => {
    const e = ord({});
    const a = ord({ side: 'sell', type: 'limit', qty: '30', filled_qty: '30', filled_avg_price: '11.00', submitted_at: '2026-11-03T15:00:00Z', filled_at: '2026-11-03T15:00:00Z', position_intent: 'sell_to_close', order_class: '' });
    const b = ord({ side: 'sell', type: 'market', qty: '70', filled_qty: '70', filled_avg_price: '10.50', submitted_at: '2026-11-04T15:00:00Z', filled_at: '2026-11-04T15:00:00Z', position_intent: 'sell_to_close', order_class: '' });
    const { p, j } = run([trade(e)], xev([e, a, b]));
    expect(p.trades[0]).toMatchObject({ status: 'CLOSED', closedQty: 100, realizedPnl: 65 });
    expect(j[0]).toMatchObject({ exitPrice: 10.65, exitOrderIds: [a.id, b.id], outcome: 'MANUAL_EXIT' });
  });
  it('(16, 17) bracket stop → STOP_HIT; bracket target → TARGET_HIT', () => {
    const s = bracket(ord({}), { status: 'filled', filled_qty: '100', filled_avg_price: '9.50', filled_at: '2026-11-03T15:00:00Z' }, { status: 'canceled' });
    const t = bracket(ord({}), { status: 'canceled' }, { status: 'filled', filled_qty: '100', filled_avg_price: '11.00', filled_at: '2026-11-03T15:00:00Z' });
    expect(run([trade(s)], xev([s])).j[0].outcome).toBe('STOP_HIT');
    expect(run([trade(t)], xev([t])).j[0]).toMatchObject({ outcome: 'TARGET_HIT', realizedPnl: 100 });
  });
  it('(19, 21) canceled / rejected entry with zero fill: not a trade CR-15 changes', () => {
    for (const status of ['canceled', 'rejected']) {
      const e = ord({ status, filled_qty: '0', filled_avg_price: null, filled_at: null });
      expect(planCrossDay([trade(e, { quantity: 0, actualFill: null })], xev([e])).trades[0]).toMatchObject({ status: 'NO_CHANGE', patch: null });
    }
  });
  it('(22, 23) two open trades in one ticker: a non-leg closing order is AMBIGUOUS — attributed to neither', () => {
    const a = ord({}), b = ord({ submitted_at: '2026-11-02T16:00:00Z', filled_at: '2026-11-02T16:01:00Z' });
    const close = ord({ side: 'sell', type: 'market', filled_avg_price: '10.20', submitted_at: '2026-11-03T15:00:00Z', filled_at: '2026-11-03T15:00:00Z', position_intent: 'sell_to_close', order_class: '' });
    const p = planCrossDay([trade(a), trade(b, { time: '11:01' })], xev([a, b, close], [{ symbol: 'XYZ', qty: '100', side: 'long' }]));
    expect(p.trades.map((t) => [t.status, t.closedQty])).toEqual([['OPEN', 0], ['OPEN', 0]]);
    expect(p.trades[0].notes.join(' ')).toMatch(/AMBIGUOUS/);
    expect(p.exitOrderIds).not.toContain(close.id);
  });
  it('(24) reversal: a closing order larger than the position closes only this trade; the excess is not attributed', () => {
    const e = ord({});
    const big = ord({ side: 'sell', type: 'market', qty: '250', filled_qty: '250', filled_avg_price: '10.10', submitted_at: '2026-11-03T15:00:00Z', filled_at: '2026-11-03T15:00:00Z', order_class: '' });
    const x = planCrossDay([trade(e)], xev([e, big], [{ symbol: 'XYZ', qty: '-150', side: 'short' }])).trades[0];
    expect(x).toMatchObject({ status: 'CLOSED', closedQty: 100, realizedPnl: 10 });
    expect(x.notes.join(' ')).toMatch(/150 more than this position/);
  });
  it('(24b) an opposite-side order the broker marks *_to_open is a NEW position, never an exit', () => {
    const e = ord({});
    const short = ord({ side: 'sell', type: 'market', filled_avg_price: '10.10', submitted_at: '2026-11-03T15:00:00Z', filled_at: '2026-11-03T15:00:00Z', position_intent: 'sell_to_open', order_class: '' });
    expect(planCrossDay([trade(e)], xev([e, short], [{ symbol: 'XYZ', qty: '100', side: 'long' }])).trades[0]).toMatchObject({ status: 'OPEN', closedQty: 0 });
  });
  it('(25) a new independent trade after the previous one went flat keeps its own exits', () => {
    const first = bracket(ord({}), { status: 'filled', filled_qty: '100', filled_avg_price: '9.50', filled_at: '2026-11-02T18:00:00Z' }, { status: 'canceled' });
    const second = bracket(ord({ submitted_at: '2026-11-03T15:00:00Z', filled_at: '2026-11-03T15:01:00Z', filled_avg_price: '10.20' }), {}, {});
    const j = [trade(first, { outcome: 'STOP_HIT', exitPrice: 9.5 }), trade(second, { date: '2026-11-03' })];
    const p = planCrossDay(j, xev([first, second], [{ symbol: 'XYZ', qty: '100', side: 'long' }]));
    expect(p.trades.map((t) => [t.tradeId, t.status])).toEqual([[`broker-${second.id}`, 'OPEN']]);
  });
  it('a stale entry with no verified exit while the account is flat → RECONCILIATION INCOMPLETE (no exit invented)', () => {
    const e = ord({});
    expect(planCrossDay([trade(e)], xev([e], [])).trades[0]).toMatchObject({ status: 'INCOMPLETE', patch: null });
  });
});

describe('persistence and idempotency (26–37)', () => {
  it('(26, 30) repeated polling and duplicated events: same result, applied once', () => {
    const once = run(J0, REAL());
    const dup = ev([...(REAL().orders as Raw[]), ...clone(REAL().orders as Raw[])], clone(FX.positions));
    const again = run(once.j, dup);
    expect(again.p.changed).toBe(false);
    expect(again.j).toBe(once.j);
    expect(run(J0, dup).j).toEqual(once.j);
  });
  it('(27, 28, 29) reload / browser closed overnight / historical backfill: the stored Journal reconciles the same way', () => {
    const reloaded = JSON.parse(JSON.stringify(J0)) as JournalEntry[];
    expect(run(reloaded, REAL()).j).toEqual(run(J0, REAL()).j);
  });
  it('(31) a failed validation writes nothing', () => {
    const p = planCrossDay(J0, REAL());
    const bad = applyCrossDay(J0, p, NOW).map((e) => (e.ticker === 'FIS' && e.direction === 'LONG' ? { ...e, notes: 'changed' } : e));
    expect(validateReconciledJournal(J0, bad)).toMatch(/Protected fields changed/);
    expect(validateReconciledJournal(J0, applyCrossDay(J0, p, NOW).slice(1))).toMatch(/Row count changed/);
  });
  const mem = (init: Record<string, string> = {}, opts: { failWrite?: string; corruptRead?: string } = {}): KeyValueStore & { data: Record<string, string> } => {
    const data = { ...init };
    return { data, getItem: (k) => (k === opts.corruptRead && k in data ? `${data[k]}x` : data[k] ?? null), setItem: (k, v) => { if (k === opts.failWrite) throw new Error('quota'); data[k] = v; } };
  };
  it('(32) backup: created once, verified, immutable; a failed write or read-back blocks the migration', () => {
    const s = mem({ [JOURNAL_KEY]: JSON.stringify(J0), other: 'keep' });
    const a = ensurePreCr15Backup(s, NOW);
    expect(a).toMatchObject({ ok: true, created: true });
    s.data[JOURNAL_KEY] = JSON.stringify(run(J0, REAL()).j);
    expect(ensurePreCr15Backup(s, '2026-11-05T00:00:00Z')).toMatchObject({ ok: true, created: false });
    expect(readBackup(s)!.journalJson).toBe(JSON.stringify(J0)); // never overwritten
    expect(s.data.other).toBe('keep');
    expect(ensurePreCr15Backup(mem({ [JOURNAL_KEY]: JSON.stringify(J0) }, { failWrite: PRE_CR15_BACKUP_KEY }), NOW)).toMatchObject({ ok: false });
    expect(ensurePreCr15Backup(mem({ [JOURNAL_KEY]: JSON.stringify(J0) }, { corruptRead: PRE_CR15_BACKUP_KEY }), NOW)).toMatchObject({ ok: false });
    expect(ensurePreCr15Backup(mem({ [JOURNAL_KEY]: '{"not":"an array"}' }), NOW)).toMatchObject({ ok: false });
  });
  it('(33) restore puts back the exact pre-CR-15 Journal; the migrated one is kept under the pre-restore key', () => {
    const original = JSON.stringify(J0);
    const s = mem({ [JOURNAL_KEY]: original });
    ensurePreCr15Backup(s, NOW);
    const migrated = JSON.stringify(run(J0, REAL()).j);
    s.data[JOURNAL_KEY] = migrated;
    const r = restorePreCr15(s, NOW);
    expect(r.ok).toBe(true);
    expect(s.data[JOURNAL_KEY]).toBe(original);
    expect(JSON.parse(s.data[PRE_RESTORE_KEY]).journalJson).toBe(migrated);
    expect(restorePreCr15(mem({ [JOURNAL_KEY]: original }), NOW)).toMatchObject({ ok: false });
  });
  it('(34) legacy compatibility: migrated rows only ADD optional fields; every legacy field keeps its type', () => {
    const migrated = run(J0, REAL()).j;
    const added = new Set(['exitOrderIds', 'exitQty', 'realizedPnl', 'reconciliation', 'reconciledIso', 'supersededBy', 'supersededReason', 'supersededIso']);
    for (const [k, e] of migrated.entries()) {
      const was = J0[k] as unknown as Raw, now = e as unknown as Raw;
      for (const key of Object.keys(was)) if (was[key] !== null && now[key] !== null) expect([key, typeof now[key]]).toEqual([key, typeof was[key]]);
      for (const key of Object.keys(e)) if (!(key in J0[k])) expect(added.has(key)).toBe(true);
    }
  });
  it('(36) CR-15 OFF: the effective gate is off; an unknown server flag is OFF even with a cached client mode', () => {
    expect(cr15Gate(null, 'AUTO')).toEqual({ on: false, autoWrites: false });
    expect(cr15Gate(false, 'AUTO')).toEqual({ on: false, autoWrites: false });
    expect(cr15Gate(true, 'OFF')).toEqual({ on: false, autoWrites: false });
    expect(cr15Gate(true, 'PREVIEW')).toEqual({ on: true, autoWrites: false });
    expect(cr15Gate(true, 'AUTO')).toEqual({ on: true, autoWrites: true });
    expect(activeEntries(J0)).toBe(J0); // no superseded rows → legacy metrics input unchanged
  });
  it('(37) preview is a dry run: planning never mutates the Journal', () => {
    const before = JSON.stringify(J0);
    planCrossDay(J0, REAL());
    expect(JSON.stringify(J0)).toBe(before);
  });
  it('a superseded row is never re-synced as a trade of its own by the day sync', () => {
    const migrated = run(J0, REAL()).j;
    const again = syncJournal(migrated, day([{ ...clone(FIS_STOP), legs: [] }], []), noCtx);
    expect(again.journal).toBe(migrated);
  });
});

describe('operational safety (39–50)', () => {
  it('(39, 40) outage, stale, wrong tickers, truncated or unreadable history: nothing is reconciled', () => {
    expect(planCrossDay(J0, null).blocked).toMatch(/not verified/);
    expect(planCrossDay(J0, { ...REAL(), verified: false })).toMatchObject({ changed: false, trades: [] });
    expect(planCrossDay(J0, { ...REAL(), complete: false }).blocked).toMatch(/truncated/);
    expect(planCrossDay(J0, { ...REAL(), orders: [{ id: 'x' }] }).blocked).toMatch(/unreadable/);
    const req = crossDayRequest(J0, '2026-11-03');
    expect(req).toEqual({ symbols: ['FIS', 'MCD'], from: '2026-11-02', outOfRange: [] });
    const now = Date.parse(NOW);
    expect(crossDayEvidenceVerified({ status: 'LIVE', lastOkMs: now - 10_000, from: '2026-11-02', symbols: ['MCD', 'FIS'] }, req, now)).toBe(true);
    expect(crossDayEvidenceVerified({ status: 'LIVE', lastOkMs: now - 121_000, from: '2026-11-02', symbols: ['FIS', 'MCD'] }, req, now)).toBe(false);
    expect(crossDayEvidenceVerified({ status: 'ERROR', lastOkMs: now, from: '2026-11-02', symbols: ['FIS', 'MCD'] }, req, now)).toBe(false); // incl. HTTP 429
    expect(crossDayEvidenceVerified({ status: 'LIVE', lastOkMs: now, from: '2026-11-02', symbols: ['FIS'] }, req, now)).toBe(false);
  });
  it('(40b) bounded lookback: trades older than 10 days are reported, not requested', () => {
    const old = [{ ...FIS_LONG(J0), date: '2026-10-20' }];
    expect(crossDayRequest(old, '2026-11-03')).toEqual({ symbols: [], from: null, outOfRange: [FIS_LONG(J0).id] });
  });
  it('(43, 44) unknown entry order id / partial order data → INCOMPLETE, never guessed', () => {
    const j = [{ ...MCD_ROW(J0), brokerOrderId: 'unknown-order' }];
    expect(planCrossDay(j, REAL()).trades[0]).toMatchObject({ status: 'INCOMPLETE', patch: null });
    expect(openBrokerTrades(J0).map((e) => e.ticker).sort()).toEqual(['FIS', 'MCD']);
  });
  it('(47) CR-15 changes no score, plan, decision or note (validator enforces it)', () => {
    const j = run(J0, REAL()).j;
    expect(validateReconciledJournal(J0, j)).toBeNull();
    expect(validateReconciledJournal(J0, j.map((e) => (e.ticker === 'MCD' ? { ...e, v11Score: 85 } : e)))).toMatch(/Protected/);
  });
  it('(50) the module performs no I/O and logs nothing', () => {
    const src = readFileSync(join(__dirname, '..', 'lifecycle', 'crossDayJournal.ts'), 'utf8');
    expect(src).not.toMatch(/\bfetch\(|localStorage|console\.|alpaca\.markets/);
    const spy = vi.spyOn(console, 'log');
    planCrossDay(J0, REAL());
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
