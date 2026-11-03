/**
 * GET /.netlify/functions/rb-broker?date=YYYY-MM-DD → READ-ONLY broker facts for the paper account: that ET day's
 * orders (with bracket legs), every order open now whatever day it was submitted (`openOrders`; null when the list may
 * be truncated) and the current positions, reduced to the fields RB reconciles. Authenticated with
 * RB_APP_ACCESS_TOKEN; OFF unless RB_BROKER_SYNC_ENABLED=true. GET only — this endpoint cannot change anything.
 */
import { bearerFrom, clientIp, RateLimiter, safeEqual } from '../lib/auth';
import { OPEN_ORDERS_LIMIT, type BrokerReadClient } from '../lib/alpaca';
import { brokerReadClient, env, json } from '../lib/env';
import { log } from '../lib/log';
import { etToEpoch } from '../../src/engine/automation/etTime';

const limiter = new RateLimiter(120, 60_000);
const ORDER_FIELDS = ['id', 'symbol', 'side', 'type', 'order_type', 'status', 'qty', 'filled_qty', 'filled_avg_price', 'stop_price', 'limit_price', 'submitted_at', 'created_at', 'filled_at', 'canceled_at', 'expired_at', 'order_class'];
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
  const date = new URL(req.url).searchParams.get('date') ?? '';
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

export default (req: Request): Promise<Response> => handleBroker(req, brokerReadClient(), env('RB_APP_ACCESS_TOKEN'));
