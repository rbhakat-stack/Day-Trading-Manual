/**
 * GET /.netlify/functions/rb-broker?date=YYYY-MM-DD → READ-ONLY broker facts for the paper account: that ET day's
 * orders (with bracket legs), every order open now whatever day it was submitted (`openOrders`; null when the list may
 * be truncated) and the current positions, reduced to the fields RB reconciles.
 *
 * GET /.netlify/functions/rb-broker?symbols=FIS,MCD&from=YYYY-MM-DD → CR-15 history: every order (all statuses, bracket
 * legs nested) for those tickers submitted since `from` (04:00 ET), plus current positions. Bounded: 1–20 tickers, `from`
 * within the last 31 days, one page of 500 (`complete: false` when the page may be truncated). Same read-only client. Authenticated with
 * RB_APP_ACCESS_TOKEN; OFF unless RB_BROKER_SYNC_ENABLED=true. GET only — this endpoint cannot change anything.
 */
import { requireSession } from '../lib/session'; // CR-16: session guard (no-op unless RB_AUTH_ENABLED)
import { bearerFrom, clientIp, RateLimiter, safeEqual } from '../lib/auth';
import { OPEN_ORDERS_LIMIT, type BrokerReadClient } from '../lib/alpaca';
import { brokerReadClient, env, json } from '../lib/env';
import { log } from '../lib/log';
import { etToEpoch } from '../../src/engine/automation/etTime';

const limiter = new RateLimiter(120, 60_000);
const ORDER_FIELDS = ['id', 'symbol', 'side', 'type', 'order_type', 'status', 'qty', 'filled_qty', 'filled_avg_price', 'stop_price', 'limit_price', 'submitted_at', 'created_at', 'filled_at', 'canceled_at', 'expired_at', 'order_class', 'position_intent'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TICKER = /^[A-Z][A-Z0-9.]{0,9}$/;
export const HISTORY_MAX_SYMBOLS = 20;
export const HISTORY_MAX_DAYS = 31;
const HISTORY_PAGE = 500;
const POSITION_FIELDS = ['symbol', 'side', 'qty', 'avg_entry_price', 'current_price', 'market_value', 'unrealized_pl'];

const pick = (o: unknown, keys: string[]) => (o && typeof o === 'object' ? Object.fromEntries(keys.filter((k) => k in (o as object)).map((k) => [k, (o as Record<string, unknown>)[k]])) : {});
export const sanitizeOrder = (o: unknown): Record<string, unknown> => ({
  ...pick(o, ORDER_FIELDS),
  legs: Array.isArray((o as { legs?: unknown } | null)?.legs) ? (o as { legs: unknown[] }).legs.map(sanitizeOrder) : [],
});
export const sanitizePosition = (p: unknown) => pick(p, POSITION_FIELDS);

export async function handleBroker(req: Request, client: BrokerReadClient | null, token: string | undefined): Promise<Response> {
  if (req.method !== 'GET') return json(405, { error: 'GET only' });
  if (!limiter.allow(clientIp(req))) return json(429, { error: 'Too many requests' });
  if (!safeEqual(bearerFrom(req), token)) return json(401, { error: 'Unauthorized' });
  if (!client) return json(503, { error: 'Broker sync not enabled (RB_BROKER_SYNC_ENABLED)' });
  const url = new URL(req.url);
  if (url.searchParams.has('symbols')) return history(url, client);
  const date = url.searchParams.get('date') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { error: 'date=YYYY-MM-DD required' });
  try {
    const [orders, openOrders, positions] = await Promise.all([
      client.listOrders({ afterIso: new Date(etToEpoch(date, '04:00')).toISOString(), untilIso: new Date(etToEpoch(date, '20:00')).toISOString() }),
      client.listOpenOrders(),
      client.listPositions(),
    ]);
    log('broker_read', { orders: orders.length, openOrders: openOrders.length, positions: positions.length });
    return json(200, {
      serverTime: new Date().toISOString(), host: client.host, account: 'PAPER', readOnly: true,
      orders: orders.map(sanitizeOrder),
      openOrders: openOrders.length >= OPEN_ORDERS_LIMIT ? null : openOrders.map(sanitizeOrder),
      positions: positions.map(sanitizePosition),
    });
  } catch (e) {
    log('broker_read_failed', { error: (e as Error).message });
    return json(502, { error: (e as Error).message });
  }
}

/** CR-15 bounded order history for the given tickers (see the module notes). */
async function history(url: URL, client: BrokerReadClient): Promise<Response> {
  const symbols = [...new Set((url.searchParams.get('symbols') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];
  const from = url.searchParams.get('from') ?? '';
  if (!symbols.length || symbols.length > HISTORY_MAX_SYMBOLS || !symbols.every((s) => TICKER.test(s))) return json(400, { error: `symbols=A,B (1–${HISTORY_MAX_SYMBOLS} tickers) required` });
  if (!DATE.test(from)) return json(400, { error: 'from=YYYY-MM-DD required' });
  const fromMs = etToEpoch(from, '04:00');
  if (!Number.isFinite(fromMs) || fromMs > Date.now() || Date.now() - fromMs > HISTORY_MAX_DAYS * 86_400_000) return json(400, { error: `from must be within the last ${HISTORY_MAX_DAYS} days` });
  try {
    const [orders, positions] = await Promise.all([client.listOrders({ afterIso: new Date(fromMs).toISOString(), limit: HISTORY_PAGE, symbols }), client.listPositions()]);
    log('broker_history_read', { symbols: symbols.length, orders: orders.length, positions: positions.length });
    return json(200, { serverTime: new Date().toISOString(), host: client.host, account: 'PAPER', readOnly: true, mode: 'history', from, symbols, complete: orders.length < HISTORY_PAGE, orders: orders.map(sanitizeOrder), positions: positions.map(sanitizePosition) });
  } catch (e) {
    log('broker_history_failed', { error: (e as Error).message });
    return json(502, { error: (e as Error).message });
  }
}

export default async (req: Request): Promise<Response> => (await requireSession(req)) ?? handleBroker(req, brokerReadClient(), env('RB_APP_ACCESS_TOKEN')); // CR-16 guard first
