/**
 * Load-race fix: (1) no journal write until today's alert feed and broker feed have loaded; (2) one-way repair of an
 * unlinked (NO_PRICE_MATCH) broker entry when a later reconciliation finds exactly one price match. MATCHED and
 * AMBIGUOUS entries are never relinked; zero matches stay unlinked. Synthetic data; nothing reaches a broker.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue, type QueueOutput } from '../liveQueue';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import type { Candidate } from '../../ranker/opportunityTypes';
import { RB_V1_DEFAULTS } from '../../settings';
import { recordWith } from './fixtures';
import { brokerOrdersFrom, reconcileBroker, syncJournal, syncJournalWhenReady, type SyncContext, type TradeSync } from '../lifecycle/brokerSync';
import type { JournalEntry } from '../../journal';

const D = '2026-10-30';
const A1 = '2026-10-30T10:15:04-04:00';
const A2 = '2026-10-30T10:27:04-04:00';
const q = (now: number): LiveQuote => ({ price: 100.95, tradeIso: new Date(now - 1000).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 });
const rec = (iso: string) => recordWith({ symbol: 'XYZ', direction: 'LONG', alertIso: iso, price: 100.95, values: {} });
function queueAt(records: AutoAlertRecord[], times: number[]): QueueOutput {
  let candidates: Candidate[] = [];
  let out!: QueueOutput;
  for (const now of times) {
    out = buildQueue({ records: records.filter((r) => r.receivedMs <= now), candidates, positions: [], quotes: { XYZ: q(now) }, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify: () => ({ sector: 'S', industry: 'I', theme: '' }), parity: {}, strategyVersion: 'RB v1.1' });
    candidates = out.candidates;
  }
  return out;
}
/** A filled bracket entry at `stop`, stopped out at 100.50 (closed). */
const order = (stop: string, submittedIso = '2026-10-30T14:16:30Z') => ({
  id: `o-${stop}`, symbol: 'XYZ', side: 'buy', type: 'stop', order_class: 'bracket', status: 'filled', qty: '197', filled_qty: '197', filled_avg_price: stop, stop_price: stop,
  submitted_at: submittedIso, filled_at: submittedIso,
  legs: [{ id: `sl-${stop}`, symbol: 'XYZ', side: 'sell', type: 'stop', status: 'filled', qty: '197', filled_qty: '197', filled_avg_price: '100.50', submitted_at: submittedIso, filled_at: '2026-10-30T15:00:00Z' }],
});
const reconcile = (rows: QueueOutput['rows'], o: ReturnType<typeof order>) => reconcileBroker(brokerOrdersFrom([o]).orders, rows, []);
const ctxOf = (out: QueueOutput, records: AutoAlertRecord[]) => (t: TradeSync): SyncContext => ({ snap: null, candidate: out.candidates.find((c) => c.id === t.recordId) ?? null, record: records.find((r) => r.id === t.recordId) ?? null });
const READY = { date: D, alertsLoadedFor: D, brokerLoadedFor: D };

describe('Fix 1 — no journal write before today\'s alert feed has loaded', () => {
  const records = [rec(A1)];
  const loaded = queueAt(records, [Date.parse(A1) + 60_000]);
  const empty = queueAt([], [Date.parse(A1) + 60_000]);
  it('broker answers first (alerts not loaded) → journal unchanged; alerts load → next poll creates the MATCHED row', () => {
    const early = reconcile(empty.rows, order('101.02'));
    expect(early[0].linkage).toBe('NO_PRICE_MATCH'); // what the race used to persist
    const j0: JournalEntry[] = [];
    const r1 = syncJournalWhenReady(j0, early, ctxOf(empty, []), { date: D, alertsLoadedFor: null, brokerLoadedFor: D });
    expect([r1.changed, r1.journal]).toEqual([false, j0]);
    const r2 = syncJournalWhenReady(r1.journal, reconcile(loaded.rows, order('101.02')), ctxOf(loaded, records), READY);
    expect(r2.journal).toHaveLength(1);
    expect(r2.journal[0]).toMatchObject({ alertLinkage: 'MATCHED', alertRecordId: records[0].id, plannedEntry: 101.02, strategyDecision: expect.any(String) });
    expect(r2.journal[0].strategyDecision).not.toBe('NO ALERT');
  });
  it('alerts loaded for a different date, or broker feed not loaded for today → no write', () => {
    const trades = reconcile(loaded.rows, order('101.02'));
    expect(syncJournalWhenReady([], trades, ctxOf(loaded, records), { date: D, alertsLoadedFor: '2026-10-29', brokerLoadedFor: D }).changed).toBe(false);
    expect(syncJournalWhenReady([], trades, ctxOf(loaded, records), { date: D, alertsLoadedFor: D, brokerLoadedFor: null }).changed).toBe(false);
    expect(syncJournalWhenReady([], trades, ctxOf(loaded, records), { date: D, alertsLoadedFor: D, brokerLoadedFor: '2026-10-29' }).changed).toBe(false);
  });
});

describe('Fix 2 — one-way repair of unlinked entries', () => {
  const records = [rec(A1)];
  const loaded = queueAt(records, [Date.parse(A1) + 60_000]);
  const empty = queueAt([], [Date.parse(A1) + 60_000]);
  const unlinked = () => syncJournal([], reconcile(empty.rows, order('101.02')), ctxOf(empty, [])).journal; // as written by the race
  it('NO_PRICE_MATCH entry + later exactly one match → same row upgraded to MATCHED, no duplicate', () => {
    const j0 = unlinked();
    expect(j0[0]).toMatchObject({ alertLinkage: 'NO_PRICE_MATCH', strategyDecision: 'NO ALERT', plannedEntry: 0, expectedRisk: 0 });
    const r = syncJournal(j0, reconcile(loaded.rows, order('101.02')), ctxOf(loaded, records));
    expect(r.repaired).toEqual([j0[0].id]);
    expect(r.journal).toHaveLength(1);
    const c = loaded.candidates[0];
    expect(r.journal[0]).toMatchObject({ id: j0[0].id, alertLinkage: 'MATCHED', alertRecordId: records[0].id, plannedEntry: c.entry, stop: c.stop, target: c.target, plannedQty: c.shares, expectedRisk: c.plannedRisk });
    expect(r.journal[0].strategyDecision).not.toBe('NO ALERT');
    expect(r.journal[0].alertTimeIso).toBe(new Date(records[0].alert.alertTimeMs).toISOString());
  });
  it('repair preserves notes, actual fill, quantity, exit, broker status, position status and P/L', () => {
    const j0 = unlinked().map((e) => ({ ...e, notes: 'keep me', date: '2026-10-30', time: '10:16' }));
    const before = j0[0];
    const after = syncJournal(j0, reconcile(loaded.rows, order('101.02')), ctxOf(loaded, records)).journal[0];
    for (const k of ['notes', 'date', 'time', 'actualFill', 'quantity', 'positionValue', 'exitPrice', 'outcome', 'brokerStatus', 'positionStatus', 'exitReason', 'entryFilledIso', 'exitFilledIso', 'brokerOrderId', 'source'] as (keyof JournalEntry)[]) {
      expect(after[k], k).toEqual(before[k]);
    }
    expect([after.actualFill, after.exitPrice, after.quantity]).toEqual([101.02, 100.5, 197]);
  });
  it('zero match stays NO ALERT', () => {
    const j0 = syncJournal([], reconcile(empty.rows, order('101.50')), ctxOf(empty, [])).journal;
    const r = syncJournal(j0, reconcile(loaded.rows, order('101.50')), ctxOf(loaded, records));
    expect(r.repaired).toEqual([]);
    expect(r.journal[0]).toMatchObject({ alertLinkage: 'NO_PRICE_MATCH', strategyDecision: 'NO ALERT', alertRecordId: null, plannedEntry: 0 });
  });
  it('ambiguous stays AMBIGUOUS (never upgraded), and NO_PRICE_MATCH is not upgraded by an ambiguous result', () => {
    const two = [rec(A1), rec(A2)];
    const both = queueAt(two, [Date.parse(A1) + 60_000, Date.parse(A2) + 60_000]);
    const late = '2026-10-30T14:28:30Z';
    const amb = syncJournal([], reconcile(both.rows, order('101.02', late)), ctxOf(both, two)).journal;
    expect(amb[0]).toMatchObject({ alertLinkage: 'AMBIGUOUS', alertRecordId: null });
    expect(syncJournal(amb, reconcile(both.rows, order('101.02', late)), ctxOf(both, two)).journal[0]).toMatchObject({ alertLinkage: 'AMBIGUOUS', alertRecordId: null });
    const j0 = syncJournal([], reconcile(empty.rows, order('101.02', late)), ctxOf(empty, [])).journal;
    expect(syncJournal(j0, reconcile(both.rows, order('101.02', late)), ctxOf(both, two)).journal[0]).toMatchObject({ alertLinkage: 'NO_PRICE_MATCH', alertRecordId: null });
  });
  it('once MATCHED, a later reconciliation can never relink it (to another alert, NO ALERT or AMBIGUOUS)', () => {
    const matched = syncJournal([], reconcile(loaded.rows, order('101.02')), ctxOf(loaded, records)).journal;
    const frozen = { ...matched[0] };
    const other: TradeSync = { ...reconcile(loaded.rows, order('101.02'))[0], recordId: 'some-other-alert', linkage: 'MATCHED', strategyDecision: 'READY' };
    for (const t of [other, { ...other, recordId: null, linkage: 'NO_PRICE_MATCH' as const, strategyDecision: 'NO ALERT' as const }, { ...other, recordId: null, linkage: 'AMBIGUOUS' as const, strategyDecision: 'NO ALERT' as const }]) {
      const e = syncJournal(matched, [t], () => ({ snap: null, candidate: null, record: null })).journal[0];
      expect([e.alertLinkage, e.alertRecordId, e.strategyDecision, e.plannedEntry, e.expectedRisk]).toEqual([frozen.alertLinkage, frozen.alertRecordId, frozen.strategyDecision, frozen.plannedEntry, frozen.expectedRisk]);
    }
  });
});
