/**
 * CR-12 — broker order / fill synchronisation (READ ONLY, IMPORT BASED).
 *
 * The app has no broker connection by design (the static NO TRADE EXECUTION guard forbids any trading-API host or
 * order/position path in the code). This module therefore reconciles Alpaca ORDER DATA THE USER PASTES (the JSON the
 * Alpaca dashboard/API returns for orders, including bracket legs) with RB alerts. It never sends anything anywhere.
 *
 * Four answers are kept independent, so a manual trade never rewrites strategy history:
 *   Strategy Decision — what RB decided for the alert (READY / NO TICKET / NO TRADE, or NO ALERT)
 *   Manual Override   — YES when the broker shows an entry fill the strategy did not ticket
 *   Broker Status     — mapped from the Alpaca order status
 *   Position Status   — NONE / OPEN / CLOSED, from the fills
 * e.g. Strategy = NO TRADE, Override = YES, Broker = FILLED, Position = OPEN is a valid, recorded combination.
 * The manual "Mark order submitted / filled" fallback is unchanged.
 */
import { etParts } from '../etTime';
import type { QueueRow } from '../liveQueue';

export type BrokerStatus = 'PENDING' | 'PARTIAL' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'REJECTED' | 'UNKNOWN';
export type PositionStatus = 'NONE' | 'OPEN' | 'CLOSED';
export type ExitReason = 'TARGET HIT' | 'STOPPED OUT' | 'MANUAL EXIT' | 'CLOSED — EOD';

const STATUS_MAP: Record<string, BrokerStatus> = {
  new: 'PENDING', accepted: 'PENDING', pending_new: 'PENDING', accepted_for_bidding: 'PENDING', held: 'PENDING', calculated: 'PENDING',
  pending_replace: 'PENDING', pending_cancel: 'PENDING', replaced: 'PENDING', suspended: 'PENDING',
  partially_filled: 'PARTIAL', partial_fill: 'PARTIAL',
  filled: 'FILLED',
  canceled: 'CANCELED', cancelled: 'CANCELED', done_for_day: 'CANCELED', stopped: 'CANCELED',
  expired: 'EXPIRED',
  rejected: 'REJECTED',
};

export function mapBrokerStatus(s: string | null | undefined): BrokerStatus {
  return STATUS_MAP[(s ?? '').trim().toLowerCase()] ?? 'UNKNOWN';
}

/** The subset of an Alpaca order object this module reads (snake_case as Alpaca returns it). */
export interface BrokerOrder {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  status: string;
  qty: number | null;
  filledQty: number;
  filledAvgPrice: number | null;
  stopPrice: number | null;
  limitPrice: number | null;
  submittedAt: number | null;
  filledAt: number | null;
  orderClass: string;
  legs: BrokerOrder[];
}

const num = (x: unknown): number | null => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const ms = (x: unknown): number | null => (typeof x === 'string' && Number.isFinite(Date.parse(x)) ? Date.parse(x) : null);

function toOrder(o: Record<string, unknown>): BrokerOrder | null {
  const symbol = typeof o.symbol === 'string' ? o.symbol.toUpperCase() : '';
  const side = o.side === 'buy' || o.side === 'sell' ? o.side : null;
  if (!symbol || !side || typeof o.status !== 'string') return null;
  return {
    id: String(o.id ?? o.client_order_id ?? `${symbol}-${o.submitted_at ?? ''}`),
    symbol, side,
    type: String(o.type ?? o.order_type ?? ''),
    status: o.status,
    qty: num(o.qty),
    filledQty: num(o.filled_qty) ?? 0,
    filledAvgPrice: num(o.filled_avg_price),
    stopPrice: num(o.stop_price),
    limitPrice: num(o.limit_price),
    submittedAt: ms(o.submitted_at) ?? ms(o.created_at),
    filledAt: ms(o.filled_at),
    orderClass: String(o.order_class ?? ''),
    legs: Array.isArray(o.legs) ? o.legs.map((l) => toOrder(l as Record<string, unknown>)).filter((l): l is BrokerOrder => !!l) : [],
  };
}

/** Parse pasted Alpaca order JSON (an array, or an object with an `orders` array). Bad entries are reported, not guessed. */
export function parseBrokerOrders(text: string): { orders: BrokerOrder[]; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { orders: [], errors: ['Not valid JSON — paste the Alpaca orders JSON (array of orders).'] };
  }
  const arr = Array.isArray(raw) ? raw : Array.isArray((raw as { orders?: unknown })?.orders) ? (raw as { orders: unknown[] }).orders : null;
  if (!arr) return { orders: [], errors: ['Expected an array of orders.'] };
  return brokerOrdersFrom(arr);
}

/** Orders from raw Alpaca order objects (the read-only rb-broker feed or a pasted export). */
export function brokerOrdersFrom(arr: unknown[]): { orders: BrokerOrder[]; errors: string[] } {
  const orders: BrokerOrder[] = [];
  const errors: string[] = [];
  arr.forEach((o, i) => {
    const x = o && typeof o === 'object' ? toOrder(o as Record<string, unknown>) : null;
    if (x) orders.push(x);
    else errors.push(`Order ${i + 1}: missing symbol, side or status`);
  });
  return { orders, errors };
}

export interface TradeSync {
  recordId: string | null;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryOrderId: string;
  strategyDecision: 'READY' | 'NO TICKET' | 'NO TRADE' | 'NO ALERT';
  manualOverride: boolean;
  brokerStatus: BrokerStatus;
  positionStatus: PositionStatus;
  entryQty: number;
  entryAvg: number | null;
  exitQty: number;
  exitAvg: number | null;
  exitReason: ExitReason | null;
  /** Realized P/L on the closed quantity (fills only; fees not included). */
  realizedPL: number | null;
  notes: string[];
}

const EOD_EXIT_FROM = 15 * 60 + 50;
const minutesEt = (t: number) => { const h = etParts(t).hhmm; return Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5)); };
const isFilled = (o: BrokerOrder) => o.filledQty > 0;

/** Find the RB alert this entry order belongs to: same ticker and side, same ET day, entry stop within 2 ¢ of RB's entry. */
function matchRow(o: BrokerOrder, rows: QueueRow[]): QueueRow | null {
  const dir = o.side === 'buy' ? 'LONG' : 'SHORT';
  const t = o.submittedAt;
  const cands = rows.filter((r) => r.record.alert.symbol === o.symbol && r.record.alert.direction === dir && (t === null || (etParts(t).date === etParts(r.record.alert.alertTimeMs).date && t >= r.record.alert.alertTimeMs - 60_000)));
  const entry = (r: QueueRow) => r.candidate?.entry ?? null;
  const priced = cands.filter((r) => o.stopPrice !== null && entry(r) !== null && Math.abs((entry(r) as number) - (o.stopPrice as number)) <= 0.02 + 1e-9);
  const pool = priced.length ? priced : cands;
  return pool.sort((a, b) => b.record.alert.alertTimeMs - a.record.alert.alertTimeMs)[0] ?? null;
}

/**
 * Reconcile imported orders with the queue rows. Entry = an order without a parent that opens (buy for LONG / sell
 * for SHORT, first per ticker); exits = its filled bracket legs, then opposite-side orders for the same ticker after it.
 */
export function reconcileBroker(orders: BrokerOrder[], rows: QueueRow[], positions?: { symbol: string; qty?: string | number }[]): TradeSync[] {
  // Live broker positions (when supplied) are the authority for open/closed; fills alone may miss an exit outside the window.
  const held = positions ? new Set(positions.filter((p) => Number(p.qty ?? 0) !== 0).map((p) => p.symbol.toUpperCase())) : null;
  const sorted = [...orders].sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0));
  // Bracket legs are exits of their parent, never entries of their own (even when listed at top level too).
  const used = new Set<string>(sorted.flatMap((o) => o.legs.map((l) => l.id)));
  const out: TradeSync[] = [];
  for (const o of sorted) {
    if (used.has(o.id)) continue;
    used.add(o.id);
    o.legs.forEach((l) => used.add(l.id));
    const direction = o.side === 'buy' ? 'LONG' : 'SHORT';
    const row = matchRow(o, rows);
    const lc = row?.lifecycle;
    const strategyDecision: TradeSync['strategyDecision'] = !row ? 'NO ALERT' : row.decision.ticket ? 'READY' : lc?.finalActionability === 'NO TRADE' ? 'NO TRADE' : 'NO TICKET';
    // Exits: bracket legs first, then later opposite-side orders in the same ticker (manual / EOD closes).
    const exitSide = o.side === 'buy' ? 'sell' : 'buy';
    const later = sorted.filter((x) => !used.has(x.id) && x.symbol === o.symbol && x.side === exitSide && (x.submittedAt ?? 0) >= (o.submittedAt ?? 0));
    let remaining = o.filledQty;
    const exits: { o: BrokerOrder; reason: ExitReason }[] = [];
    for (const l of o.legs.filter(isFilled)) exits.push({ o: l, reason: /limit/i.test(l.type) ? 'TARGET HIT' : /stop/i.test(l.type) ? 'STOPPED OUT' : 'MANUAL EXIT' });
    remaining -= exits.reduce((n, e) => n + e.o.filledQty, 0);
    for (const x of later) {
      if (remaining <= 0) break;
      if (!isFilled(x)) continue;
      used.add(x.id);
      exits.push({ o: x, reason: x.filledAt !== null && minutesEt(x.filledAt) >= EOD_EXIT_FROM ? 'CLOSED — EOD' : 'MANUAL EXIT' });
      remaining -= x.filledQty;
    }
    const exitQty = exits.reduce((n, e) => n + e.o.filledQty, 0);
    const exitAvg = exitQty ? exits.reduce((n, e) => n + e.o.filledQty * (e.o.filledAvgPrice ?? 0), 0) / exitQty : null;
    const closedQty = Math.min(exitQty, o.filledQty);
    const sign = direction === 'LONG' ? 1 : -1;
    const realizedPL = closedQty && o.filledAvgPrice !== null && exitAvg !== null ? Math.round(sign * (exitAvg - o.filledAvgPrice) * closedQty * 100) / 100 : null;
    const fromFills: PositionStatus = o.filledQty <= 0 ? 'NONE' : exitQty >= o.filledQty ? 'CLOSED' : 'OPEN';
    const positionStatus: PositionStatus = held && fromFills === 'OPEN' && !held.has(o.symbol) ? 'CLOSED' : held && fromFills === 'CLOSED' && held.has(o.symbol) ? 'OPEN' : fromFills;
    const notes: string[] = [];
    if (!row) notes.push('No RB alert matched this order (manual trade).');
    if (positionStatus !== fromFills) notes.push(`Position status from broker positions (fills in the window say ${fromFills}).`);
    if (exits.length > 1 && new Set(exits.map((e) => e.reason)).size > 1) notes.push(`Mixed exits: ${exits.map((e) => `${e.o.filledQty} ${e.reason}`).join(', ')}`);
    out.push({
      recordId: row?.record.id ?? null, symbol: o.symbol, direction, entryOrderId: o.id,
      strategyDecision, manualOverride: o.filledQty > 0 && strategyDecision !== 'READY',
      brokerStatus: mapBrokerStatus(o.status), positionStatus,
      entryQty: o.filledQty, entryAvg: o.filledAvgPrice, exitQty, exitAvg,
      exitReason: positionStatus === 'CLOSED' ? (exits[exits.length - 1]?.reason ?? null) : null,
      realizedPL, notes,
    });
  }
  return out;
}

/** CR-13 — broker facts for the EOD flatness check: tickers with an open position, and unfilled entry orders. */
export function brokerEodFacts(feed: { orders: unknown[]; positions: { symbol: string; qty?: string | number }[] }): { openTickers: string[]; pendingTickers: string[] } {
  const { orders } = brokerOrdersFrom(feed.orders);
  return {
    openTickers: feed.positions.filter((p) => Number(p.qty ?? 0) !== 0).map((p) => p.symbol.toUpperCase()),
    pendingTickers: orders.filter((o) => ['PENDING', 'PARTIAL'].includes(mapBrokerStatus(o.status)) && o.filledQty < (o.qty ?? Infinity)).map((o) => o.symbol),
  };
}
