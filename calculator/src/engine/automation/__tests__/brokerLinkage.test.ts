/**
 * Broker order → RB alert linkage is deterministic or absent: exactly one same-ticker/direction alert (same ET day,
 * at or before submission) whose planned entry is within 2 ¢ of the order's stop price. Zero matches → unlinked
 * (never the "latest" alert); several → AMBIGUOUS, unlinked, no candidate decision used.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue, type QueueRow } from '../liveQueue';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import type { Candidate } from '../../ranker/opportunityTypes';
import { RB_V1_DEFAULTS } from '../../settings';
import { recordWith } from './fixtures';
import { brokerOrdersFrom, reconcileBroker, syncJournal, withAlertTimeDecision } from '../lifecycle/brokerSync';
import type { AlertTimeSnapshot } from '../lifecycle/alertTimeSnapshot';
import { journalScope } from '../../journal';

const A1 = '2026-10-30T10:15:04-04:00';
const A2 = '2026-10-30T10:27:04-04:00'; // 12 min later: the first alert is stale, so the second gets its own candidate
const q = (now: number): LiveQuote => ({ price: 100.95, tradeIso: new Date(now - 1000).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 });
const rec = (iso: string) => recordWith({ symbol: 'XYZ', direction: 'LONG', alertIso: iso, price: 100.95, values: {} });
function rowsAt(records: AutoAlertRecord[], times: number[]): QueueRow[] {
  let candidates: Candidate[] = [];
  let rows: QueueRow[] = [];
  for (const now of times) {
    const out = buildQueue({ records: records.filter((r) => r.receivedMs <= now), candidates, positions: [], quotes: { XYZ: q(now) }, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify: () => ({ sector: 'S', industry: 'I', theme: '' }), parity: {}, strategyVersion: 'RB v1.1' });
    candidates = out.candidates;
    rows = out.rows;
  }
  return rows;
}
const order = (stop: string, submittedIso: string) => ({ id: `o-${stop}`, symbol: 'XYZ', side: 'buy', type: 'stop', status: 'filled', qty: '197', filled_qty: '197', filled_avg_price: stop, stop_price: stop, submitted_at: submittedIso, filled_at: submittedIso, legs: [] });
const reconcile = (rows: QueueRow[], o: ReturnType<typeof order>) => reconcileBroker(brokerOrdersFrom([o]).orders, rows, [{ symbol: 'XYZ', qty: '197' }])[0];
const readySnap = { v11: { decision: 'TRADE NOW — ELITE' } } as unknown as AlertTimeSnapshot;

describe('alert linkage', () => {
  const one = rowsAt([rec(A1)], [Date.parse(A1) + 60_000]);
  it('exactly one price match → MATCHED and linked (the GM / FIS case)', () => {
    expect(one[0].candidate!.entry).toBe(101.02);
    const t = reconcile(one, order('101.02', '2026-10-30T14:16:30Z'));
    expect(t).toMatchObject({ linkage: 'MATCHED', recordId: one[0].record.id });
  });
  it('zero price matches → unlinked, NO ALERT, manual override, diagnostic — never the most recent alert', () => {
    const t = reconcile(one, order('101.50', '2026-10-30T14:16:30Z'));
    expect(t).toMatchObject({ linkage: 'NO_PRICE_MATCH', recordId: null, strategyDecision: 'NO ALERT', manualOverride: true });
    expect(t.notes).toContain('No RB alert matched this order price (manual trade).');
    // even a READY snapshot for the only same-ticker alert cannot be inherited
    expect(withAlertTimeDecision([t], { [one[0].record.id]: readySnap })[0]).toMatchObject({ strategyDecision: 'NO ALERT', manualOverride: true });
  });
  it('an order with no stop price (e.g. market) is unlinked', () => {
    const t = reconcile(one, { ...order('101.02', '2026-10-30T14:16:30Z'), type: 'market', stop_price: null as unknown as string });
    expect(t).toMatchObject({ linkage: 'NO_PRICE_MATCH', recordId: null, strategyDecision: 'NO ALERT' });
  });
  it('two alerts at the same price → AMBIGUOUS, unlinked, no candidate decision used', () => {
    const rows = rowsAt([rec(A1), rec(A2)], [Date.parse(A1) + 60_000, Date.parse(A2) + 60_000]);
    expect(rows.filter((r) => r.candidate?.entry === 101.02)).toHaveLength(2);
    const t = reconcile(rows, order('101.02', '2026-10-30T14:28:30Z'));
    expect(t).toMatchObject({ linkage: 'AMBIGUOUS', recordId: null, strategyDecision: 'NO ALERT', manualOverride: true });
    expect(t.notes.join(' ')).toMatch(/^AMBIGUOUS — 2 RB alerts match this order price/);
    const snaps = Object.fromEntries(rows.map((r) => [r.record.id, readySnap]));
    expect(withAlertTimeDecision([t], snaps)[0]).toMatchObject({ strategyDecision: 'NO ALERT', manualOverride: true });
  });
  it('an alert after the order was submitted is never a candidate', () => {
    const rows = rowsAt([rec(A1), rec(A2)], [Date.parse(A1) + 60_000, Date.parse(A2) + 60_000]);
    expect(reconcile(rows, order('101.02', '2026-10-30T14:20:00Z'))).toMatchObject({ linkage: 'MATCHED', recordId: rows.find((r) => r.record.alert.alertTimeMs === Date.parse(A1))!.record.id });
  });
  it('journal + dashboard: unlinked trades carry their linkage and count as manual overrides, once', () => {
    const rows = rowsAt([rec(A1), rec(A2)], [Date.parse(A1) + 60_000, Date.parse(A2) + 60_000]);
    const trades = [reconcile(rows, order('101.02', '2026-10-30T14:28:30Z')), reconcile(one, order('101.50', '2026-10-30T14:16:30Z'))];
    let j = syncJournal([], trades, () => ({ snap: null, candidate: null, record: null })).journal;
    j = syncJournal(j, trades, () => ({ snap: null, candidate: null, record: null })).journal;
    expect(j.map((e) => [e.alertLinkage, e.alertRecordId, e.strategyDecision, e.manualOverride])).toEqual([['AMBIGUOUS', null, 'NO ALERT', true], ['NO_PRICE_MATCH', null, 'NO ALERT', true]]);
    expect(journalScope(j, 'RB_STRATEGY')).toHaveLength(0);
    expect(journalScope(j, 'MANUAL_OVERRIDE')).toHaveLength(2);
  });
});
