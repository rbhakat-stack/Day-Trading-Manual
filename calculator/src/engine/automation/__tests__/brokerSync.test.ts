/**
 * CR-12 — read-only broker reconciliation: status mapping, fills/P&L, exit inference, and four independent answers
 * (strategy decision / manual override / broker status / position status). Synthetic orders only.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, type LiveQuote } from '../alertDecision';
import { buildQueue } from '../liveQueue';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../settings';
import { recordWith } from './fixtures';
import { mapBrokerStatus, parseBrokerOrders, reconcileBroker } from '../lifecycle/brokerSync';

const ALERT = '2026-10-30T10:15:04-04:00';
const T0 = Date.parse(ALERT);
const NOW = T0 + 60_000;
const q = (price: number): LiveQuote => ({ price, tradeIso: new Date(NOW - 1000).toISOString(), fetchedIso: new Date(NOW - 500).toISOString(), receivedMs: NOW - 500 });
const rowsFor = (price: number, values: Record<string, number> = {}) => {
  const rec = recordWith({ symbol: 'XYZ', direction: 'LONG', alertIso: ALERT, price: 100.95, values });
  return buildQueue({ records: [rec], candidates: [], positions: [], quotes: { XYZ: q(price) }, now: NOW, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify: () => ({ sector: 'S', industry: 'I', theme: '' }), parity: {}, strategyVersion: 'RB v1.1' }).rows;
};
const iso = (hhmm: string) => new Date(`2026-10-30T${hhmm}:00-04:00`).toISOString();
const bracket = (o: { status?: string; filled?: number; avg?: number; stop?: number; tp?: { status: string; filled: number; avg: number }; sl?: { status: string; filled: number; avg: number }; at?: string }) => ({
  id: 'E1', symbol: 'XYZ', side: 'buy', type: 'stop', order_class: 'bracket', status: o.status ?? 'filled', qty: '197', filled_qty: String(o.filled ?? 197), filled_avg_price: o.avg === undefined ? '101.03' : String(o.avg),
  stop_price: String(o.stop ?? 101.02), submitted_at: iso(o.at ?? '10:15'), filled_at: iso('10:17'),
  legs: [
    { id: 'TP', symbol: 'XYZ', side: 'sell', type: 'limit', status: o.tp?.status ?? 'new', qty: '197', filled_qty: String(o.tp?.filled ?? 0), filled_avg_price: o.tp ? String(o.tp.avg) : null, limit_price: '103.06', submitted_at: iso('10:17'), filled_at: o.tp?.filled ? iso('11:02') : null },
    { id: 'SL', symbol: 'XYZ', side: 'sell', type: 'stop', status: o.sl?.status ?? 'held', qty: '197', filled_qty: String(o.sl?.filled ?? 0), filled_avg_price: o.sl ? String(o.sl.avg) : null, stop_price: '100.00', submitted_at: iso('10:17'), filled_at: o.sl?.filled ? iso('10:40') : null },
  ],
});
const sync = (orders: unknown[], rows = rowsFor(100.95)) => {
  const p = parseBrokerOrders(JSON.stringify(orders));
  expect(p.errors).toEqual([]);
  return reconcileBroker(p.orders, rows);
};

describe('CR-12 status mapping', () => {
  it('new / accepted / pending_new → PENDING; partially_filled → PARTIAL; filled; canceled; expired', () => {
    expect(['new', 'accepted', 'pending_new'].map(mapBrokerStatus)).toEqual(['PENDING', 'PENDING', 'PENDING']);
    expect([mapBrokerStatus('partially_filled'), mapBrokerStatus('filled'), mapBrokerStatus('canceled'), mapBrokerStatus('expired'), mapBrokerStatus('nonsense')]).toEqual(['PARTIAL', 'FILLED', 'CANCELED', 'EXPIRED', 'UNKNOWN']);
  });
  it('invalid input is reported, never guessed', () => {
    expect(parseBrokerOrders('not json').errors[0]).toMatch(/JSON/);
    expect(parseBrokerOrders('[{"symbol":"X"}]').errors[0]).toMatch(/Order 1/);
  });
});

describe('CR-12 fills, P/L and exit inference', () => {
  it('pending entry → PENDING, position NONE, matched to the RB alert, no override', () => {
    const [t] = sync([bracket({ status: 'accepted', filled: 0, avg: null as unknown as number })]);
    expect(t).toMatchObject({ brokerStatus: 'PENDING', positionStatus: 'NONE', strategyDecision: 'READY', manualOverride: false, entryQty: 0 });
    expect(t.recordId).not.toBeNull();
  });
  it('partial entry fill → PARTIAL, OPEN with the filled quantity', () => {
    const [t] = sync([bracket({ status: 'partially_filled', filled: 100 })]);
    expect(t).toMatchObject({ brokerStatus: 'PARTIAL', positionStatus: 'OPEN', entryQty: 100 });
  });
  it('take-profit leg filled → TARGET HIT, CLOSED, P/L from fills', () => {
    const [t] = sync([bracket({ tp: { status: 'filled', filled: 197, avg: 103.06 }, sl: { status: 'canceled', filled: 0, avg: 0 } })]);
    expect(t).toMatchObject({ positionStatus: 'CLOSED', exitReason: 'TARGET HIT', exitQty: 197, realizedPL: 399.91 });
  });
  it('stop leg filled → STOPPED OUT with a negative P/L', () => {
    const [t] = sync([bracket({ sl: { status: 'filled', filled: 197, avg: 99.98 }, tp: { status: 'canceled', filled: 0, avg: 0 } })]);
    expect(t).toMatchObject({ exitReason: 'STOPPED OUT', positionStatus: 'CLOSED', realizedPL: -206.85 });
  });
  it('a separate closing order before 15:50 → MANUAL EXIT; at/after 15:50 → CLOSED — EOD', () => {
    const close = (at: string) => ({ id: `X${at}`, symbol: 'XYZ', side: 'sell', type: 'market', status: 'filled', qty: '197', filled_qty: '197', filled_avg_price: '101.50', submitted_at: iso(at), filled_at: iso(at) });
    expect(sync([bracket({}), close('13:00')])[0]).toMatchObject({ exitReason: 'MANUAL EXIT', positionStatus: 'CLOSED' });
    expect(sync([bracket({}), close('15:56')])[0]).toMatchObject({ exitReason: 'CLOSED — EOD', positionStatus: 'CLOSED', realizedPL: 92.59 });
  });
  it('filled with no exit yet → FILLED / OPEN', () => {
    expect(sync([bracket({})])[0]).toMatchObject({ brokerStatus: 'FILLED', positionStatus: 'OPEN', exitReason: null });
  });
});

describe('CR-12 independent answers (manual trades never rewrite strategy history)', () => {
  it('Strategy NO TRADE + Override YES + Broker FILLED + Position OPEN is possible', () => {
    const rows = rowsFor(101.4); // chased → NO TRADE
    expect(rows[0].lifecycle.finalActionability).toBe('NO TRADE');
    const before = JSON.stringify(rows[0].decision);
    const [t] = sync([bracket({ avg: 101.42 })], rows);
    expect(t).toMatchObject({ strategyDecision: 'NO TRADE', manualOverride: true, brokerStatus: 'FILLED', positionStatus: 'OPEN' });
    expect(JSON.stringify(rows[0].decision)).toBe(before);
  });
  it('an order with no RB alert is a manual trade (NO ALERT, override YES)', () => {
    const o = { ...bracket({}), symbol: 'ABC', legs: [] };
    expect(sync([o])[0]).toMatchObject({ strategyDecision: 'NO ALERT', manualOverride: true, recordId: null });
  });
});
