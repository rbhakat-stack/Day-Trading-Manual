/**
 * GET /.netlify/functions/rb-quotes?symbols=NVDA,GM → latest trade per symbol (live current price, never cached).
 * Authenticated with RB_APP_ACCESS_TOKEN. Read-only market data.
 */
import { bearerFrom, clientIp, RateLimiter, safeEqual } from '../lib/auth';
import { dataClient, env, json } from '../lib/env';
import { log } from '../lib/log';

const limiter = new RateLimiter(600, 60_000);
const SYMBOL = /^[A-Z]{1,5}([.-][A-Z]{1,2})?$/;

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'GET') return json(405, { error: 'GET only' });
  const ip = clientIp(req);
  if (!limiter.allow(ip)) return json(429, { error: 'Too many requests' });
  if (!safeEqual(bearerFrom(req), env('RB_APP_ACCESS_TOKEN'))) {
    log('read_rejected', { endpoint: 'rb-quotes', ip });
    return json(401, { error: 'Unauthorized' });
  }
  const symbols = [...new Set((new URL(req.url).searchParams.get('symbols') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (!symbols.length || symbols.length > 50 || !symbols.every((s) => SYMBOL.test(s))) return json(400, { error: '1–50 valid symbols required' });
  const data = dataClient();
  if (!data) return json(503, { error: 'Market data not configured' });
  try {
    const quotes = await data.getLatestTrades(symbols);
    log('quotes_served', { count: Object.keys(quotes).length });
    return json(200, { serverTime: new Date().toISOString(), feed: data.feed, quotes });
  } catch (e) {
    log('market_data_fetch_failed', { endpoint: 'rb-quotes', error: (e as Error).message });
    return json(502, { error: (e as Error).message });
  }
};
