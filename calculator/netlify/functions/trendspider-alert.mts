/**
 * POST /.netlify/functions/trendspider-alert — TrendSpider webhook receiver.
 *
 * Authenticated with TRENDSPIDER_WEBHOOK_SECRET (the "token" field in the TrendSpider JSON note, compared in
 * constant time). Validates, de-duplicates, stores and enriches the alert with read-only market data.
 * It never places, modifies or cancels an order anywhere.
 */
import { clientIp, RateLimiter, safeEqual, webhookTokenFrom } from '../lib/auth';
import { BarCache } from '../lib/alpaca';
import { dataClient, env, json } from '../lib/env';
import { log } from '../lib/log';
import { processAlert } from '../lib/processAlert';
import { blobStore } from '../lib/store';
import { MAX_PAYLOAD_BYTES } from '../../src/engine/automation/alertPayload';

const limiter = new RateLimiter(120, 60_000); // per instance, per IP
const cache = new BarCache(60_000);

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' }, { allow: 'POST' });
  const ip = clientIp(req);
  if (!limiter.allow(ip)) {
    log('webhook_rejected', { reason: 'rate_limited', ip });
    return json(429, { error: 'Too many requests' });
  }
  const text = await req.text();
  if (text.length > MAX_PAYLOAD_BYTES) {
    log('webhook_rejected', { reason: 'payload_too_large', bytes: text.length, ip });
    return json(413, { error: 'Payload too large' });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    log('webhook_rejected', { reason: 'invalid_json', ip });
    return json(400, { error: 'Body must be JSON' });
  }
  const secret = env('TRENDSPIDER_WEBHOOK_SECRET');
  if (!secret) {
    log('webhook_rejected', { reason: 'server_not_configured' });
    return json(503, { error: 'Webhook not configured' });
  }
  if (!safeEqual(webhookTokenFrom(req, body), secret)) {
    log('webhook_rejected', { reason: 'unauthorized', ip });
    return json(401, { error: 'Unauthorized' });
  }
  const data = dataClient();
  if (!data) {
    log('webhook_rejected', { reason: 'market_data_not_configured' });
    return json(503, { error: 'Market data not configured' });
  }
  const out = await processAlert(body, { store: await blobStore(), data, log, now: Date.now, cache });
  switch (out.kind) {
    case 'REJECTED':
      return json(400, { error: 'Invalid alert', details: out.errors });
    case 'TEST_OK':
      return json(200, { ok: true, test: true, parsed: { symbol: out.alert.symbol, direction: out.alert.direction, alertTime: out.alert.alertTimeIso, lastPrice: out.alert.lastPrice } });
    case 'DUPLICATE':
      return json(200, { ok: true, duplicate: true, id: out.id });
    case 'STORED':
      return json(200, { ok: true, id: out.id, status: out.record.status });
  }
};
