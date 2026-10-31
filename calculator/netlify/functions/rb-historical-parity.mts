/**
 * POST /.netlify/functions/rb-historical-parity — HISTORICAL SIP PARITY TEST (diagnostic only).
 *
 * Body: { "symbol": "IBM", "direction": "LONG", "alertEt": "2026-10-30 15:55:10", "label": "optional" }
 * Authenticated with RB_APP_ACCESS_TOKEN. Fetches historical SIP 5m bars only (feed forced to sip, never the current
 * price), rebuilds the RB v1 alert-time snapshot with the shared engine and returns it. Stores nothing, creates no
 * alert, candidate or ticket, and never places an order.
 */
import { bearerFrom, clientIp, RateLimiter, safeEqual } from '../lib/auth';
import { env, json } from '../lib/env';
import { runHistoricalSipTest } from '../lib/historicalSip';
import { log } from '../lib/log';

const limiter = new RateLimiter(30, 60_000);

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' }, { allow: 'POST' });
  const ip = clientIp(req);
  if (!limiter.allow(ip)) return json(429, { error: 'Too many requests' });
  if (!safeEqual(bearerFrom(req), env('RB_APP_ACCESS_TOKEN'))) {
    log('read_rejected', { endpoint: 'rb-historical-parity', ip });
    return json(401, { error: 'Unauthorized' });
  }
  const text = await req.text();
  if (text.length > 2048) return json(413, { error: 'Payload too large' });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: 'Body must be JSON', errors: ['Body must be JSON'] });
  }
  const out = await runHistoricalSipTest(body, { keyId: env('ALPACA_API_KEY'), secretKey: env('ALPACA_SECRET_KEY'), baseUrl: env('ALPACA_DATA_BASE_URL'), now: Date.now, log });
  if (out.ok) return json(200, { ok: true, result: out.result });
  return json(out.status, { ok: false, kind: out.kind, error: out.errors.join(' '), errors: out.errors });
};
