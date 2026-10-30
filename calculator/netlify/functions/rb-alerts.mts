/**
 * GET  /.netlify/functions/rb-alerts?date=YYYY-MM-DD  → the day's alert records (immutable snapshots).
 * POST /.netlify/functions/rb-alerts {"action":"reprocess","id":"…","date":"…"} → retry enrichment of a
 *      RECEIVED / DATA_ERROR record only (bounded to 3 attempts). Completed snapshots are never rewritten.
 * Authenticated with RB_APP_ACCESS_TOKEN (Authorization: Bearer). Read-only with respect to any broker.
 */
import { bearerFrom, clientIp, RateLimiter, safeEqual } from '../lib/auth';
import { dataClient, env, json } from '../lib/env';
import { log } from '../lib/log';
import { enrichRecord } from '../lib/processAlert';
import { blobStore } from '../lib/store';

const limiter = new RateLimiter(600, 60_000);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async (req: Request): Promise<Response> => {
  const ip = clientIp(req);
  if (!limiter.allow(ip)) return json(429, { error: 'Too many requests' });
  if (!safeEqual(bearerFrom(req), env('RB_APP_ACCESS_TOKEN'))) {
    log('read_rejected', { endpoint: 'rb-alerts', ip });
    return json(401, { error: 'Unauthorized' });
  }
  const store = await blobStore();
  if (req.method === 'GET') {
    const date = new URL(req.url).searchParams.get('date') ?? '';
    if (!DATE.test(date)) return json(400, { error: 'date=YYYY-MM-DD required' });
    const records = await store.list(date);
    return json(200, { serverTime: new Date().toISOString(), records });
  }
  if (req.method === 'POST') {
    let b: { action?: string; id?: string; date?: string };
    try {
      b = await req.json();
    } catch {
      return json(400, { error: 'JSON body required' });
    }
    if (b.action !== 'reprocess' || typeof b.id !== 'string' || !DATE.test(b.date ?? '')) return json(400, { error: 'action=reprocess, id and date required' });
    const rec = await store.get(b.date as string, b.id);
    if (!rec) return json(404, { error: 'Not found' });
    if (rec.status === 'OK') return json(200, { record: rec, note: 'Snapshot already complete; it is immutable.' });
    if (rec.attempts >= 3) return json(200, { record: rec, note: 'Retry limit reached — MANUAL REVIEW REQUIRED.' });
    const data = dataClient();
    if (!data) return json(503, { error: 'Market data not configured' });
    const done = await enrichRecord(rec, { store, data, log, now: Date.now, settleMs: 0 });
    return json(200, { record: done });
  }
  return json(405, { error: 'GET or POST only' });
};
