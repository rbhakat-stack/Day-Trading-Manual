import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RateLimiter, safeEqual, webhookTokenFrom } from '../lib/auth';
import { assertReadOnlyDataRequest, BarCache, createAlpacaData, type MarketDataClient } from '../lib/alpaca';
import { redact } from '../lib/log';
import { enrichRecord, processAlert, type ProcessDeps } from '../lib/processAlert';
import { MemoryStore } from '../lib/store';
import { daysUpTo, sessionBars } from '../../src/engine/automation/__tests__/fixtures';
import { etToEpoch } from '../../src/engine/automation/etTime';
import type { Bar } from '../../src/engine/automation/indicators';

const D = '2026-10-30';
const ALERT_MS = etToEpoch(D, '10:15:04');
const BARS = sessionBars(daysUpTo(D), { untilEt: '10:20' });
const body = (o: Record<string, unknown> = {}) => ({ strategy: 'RB_V1', symbol: 'GM', direction: 'LONG', alert_name: 'RB v1 LONG Setup', alert_time: new Date(ALERT_MS).toISOString(), token: 'whsec', ...o });

function fakeData(o: { bars?: Bar[]; fail?: string; price?: number } = {}): MarketDataClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: 'Alpaca', feed: 'sip', host: 'data.alpaca.markets', calls,
    async getBars5(symbol) {
      calls.push(`bars:${symbol}`);
      if (o.fail) throw new Error(o.fail);
      return o.bars ?? BARS;
    },
    async getLatestTrades(symbols) {
      calls.push(`trades:${symbols.join(',')}`);
      if (o.fail) throw new Error(o.fail);
      return Object.fromEntries(symbols.map((s) => [s, { price: o.price ?? 106.0, tradeIso: new Date(ALERT_MS + 1000).toISOString(), fetchedIso: new Date(ALERT_MS + 1500).toISOString() }]));
    },
  };
}

const deps = (o: Partial<ProcessDeps> = {}): ProcessDeps & { logs: [string, Record<string, unknown>][] } => {
  const logs: [string, Record<string, unknown>][] = [];
  return { store: new MemoryStore(), data: fakeData(), log: (e, f = {}) => void logs.push([e, f]), now: () => ALERT_MS + 2000, sleep: async () => {}, logs, ...o };
};

/* ───────────────────────── authentication ───────────────────────── */

describe('webhook authentication', () => {
  it('constant-time comparison; empty/missing never authenticates', () => {
    expect(safeEqual('whsec', 'whsec')).toBe(true);
    expect(safeEqual('whsec ', 'whsec')).toBe(false);
    expect(safeEqual('', 'whsec')).toBe(false);
    expect(safeEqual(undefined, 'whsec')).toBe(false);
    expect(safeEqual('anything', undefined)).toBe(false);
    expect(safeEqual('', '')).toBe(false);
  });
  it('token from the JSON body (TrendSpider) or the x-rb-webhook-token header', () => {
    const r = new Request('https://x/', { method: 'POST' });
    expect(webhookTokenFrom(r, { token: 'a' })).toBe('a');
    expect(webhookTokenFrom(new Request('https://x/', { method: 'POST', headers: { 'x-rb-webhook-token': 'h' } }), { token: 'a' })).toBe('h');
  });
  it('rate limiter', () => {
    const l = new RateLimiter(2, 1000);
    expect([l.allow('ip', 0), l.allow('ip', 1), l.allow('ip', 2), l.allow('ip', 1500)]).toEqual([true, true, false, true]);
  });
});

/* ───────────────────────── read-only market data ───────────────────────── */

describe('Alpaca client is market-data only (no trading endpoints possible)', () => {
  it.each([
    ['https://api.alpaca.markets/v2/orders', 'GET'],
    ['https://paper-api.alpaca.markets/v2/orders', 'POST'],
    ['https://data.alpaca.markets/v2/stocks/AAPL/bars', 'POST'],
    ['https://data.alpaca.markets/v2/account', 'GET'],
    ['http://data.alpaca.markets/v2/stocks/AAPL/bars', 'GET'],
    ['https://evil.example/v2/stocks/AAPL/bars', 'GET'],
    ['https://data.alpaca.markets/v2/stocks/orders', 'GET'],
  ])('blocks %s %s', (url, m) => expect(() => assertReadOnlyDataRequest(url, m)).toThrow(/Blocked/));
  it('allows GET market-data paths', () => {
    expect(() => assertReadOnlyDataRequest('https://data.alpaca.markets/v2/stocks/AAPL/bars?timeframe=5Min', 'GET')).not.toThrow();
    expect(() => assertReadOnlyDataRequest('https://data.alpaca.markets/v2/stocks/trades/latest?symbols=A', 'GET')).not.toThrow();
  });
  it('refuses a trading base URL at construction time of a request', async () => {
    const c = createAlpacaData({ keyId: 'k', secretKey: 's', baseUrl: 'https://paper-api.alpaca.markets', fetchImpl: vi.fn() as never });
    await expect(c.getBars5('AAPL', 'a', 'b')).rejects.toThrow(/Blocked/);
  });

  const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200 });
  it('GET with key headers, pagination, raw adjustment, the configured feed', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(ok({ bars: [{ t: '2026-10-30T13:30:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }], next_page_token: 'p2' }))
      .mockResolvedValueOnce(ok({ bars: [{ t: '2026-10-30T13:35:00Z', o: 1.5, h: 2, l: 1, c: 1.8, v: 20 }], next_page_token: null }));
    const c = createAlpacaData({ keyId: 'KEY', secretKey: 'SEC', fetchImpl: f as never, feed: 'sip' });
    const bars = await c.getBars5('GM', '2026-10-23T13:30:00Z', '2026-10-30T14:15:04Z');
    expect(bars.map((b) => b.c)).toEqual([1.5, 1.8]);
    const [url, init] = f.mock.calls[1];
    expect(init.method).toBe('GET');
    expect(init.headers['APCA-API-KEY-ID']).toBe('KEY');
    expect(url).toMatch(/^https:\/\/data\.alpaca\.markets\/v2\/stocks\/GM\/bars\?/);
    expect(url).toContain('feed=sip');
    expect(url).toContain('adjustment=raw');
    expect(url).toContain('page_token=p2');
  });
  it('bounded retries on 5xx / 429, none on 4xx', async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response('busy', { status: 503 })).mockResolvedValueOnce(ok({ trades: { GM: { t: '2026-10-30T14:15:05Z', p: 85.45 } } }));
    const c = createAlpacaData({ keyId: 'k', secretKey: 's', fetchImpl: f as never, attempts: 2 });
    expect((await c.getLatestTrades(['GM'])).GM.price).toBe(85.45);
    const g = vi.fn().mockResolvedValue(new Response('{"message":"subscription does not permit querying recent SIP data"}', { status: 403 }));
    const c2 = createAlpacaData({ keyId: 'k', secretKey: 's', fetchImpl: g as never, attempts: 3 });
    await expect(c2.getLatestTrades(['GM'])).rejects.toThrow(/403/);
    expect(g).toHaveBeenCalledTimes(1);
  });
  it('bar cache only serves fresh entries', () => {
    const c = new BarCache(1000);
    c.set('k', [], 0);
    expect(c.get('k', 500)).toEqual([]);
    expect(c.get('k', 1500)).toBeNull();
  });
});

/* ───────────────────────── alert processing ───────────────────────── */

describe('processAlert', () => {
  it('stores an immutable OK snapshot with signal 10:10–10:15 and 15m 10:00–10:15', async () => {
    const d = deps();
    const out = await processAlert(body(), d);
    expect(out.kind).toBe('STORED');
    if (out.kind !== 'STORED') return;
    const r = out.record;
    expect(r.status).toBe('OK');
    expect(r.snapshot?.signal?.label).toBe('10:10–10:15');
    expect(r.snapshot?.confirm15m?.label).toBe('10:00–10:15');
    expect(r.snapshot?.values?.high).toBe(BARS.find((b) => b.t === etToEpoch(D, '10:10'))!.h);
    expect(r.initialQuote?.price).toBe(106);
    expect(r.calcAtAlert?.entry).not.toBeNull();
    expect(r.payload).not.toHaveProperty('token');
    expect(r.versions).toEqual({ rules: 'RB v1.1', scoring: 'RB v1.1', strategy: 'RB v1.1' });
    expect(d.logs.map((l) => l[0])).toEqual(expect.arrayContaining(['webhook_received', 'market_data_fetch_started', 'candidate_enriched', 'calculator_result', 'hard_rule_result', 'record_stored']));
  });
  it('duplicate alert (same ticker, direction, timestamp, type) is not stored twice', async () => {
    const d = deps();
    const a = await processAlert(body(), d);
    const b = await processAlert(body(), d);
    expect(b).toMatchObject({ kind: 'DUPLICATE', id: (a as { id: string }).id });
    expect((await (d.store as MemoryStore).list(D)).length).toBe(1);
  });
  it('a later alert for the same ticker is stored and linked to the earlier one', async () => {
    const d = deps({ now: () => etToEpoch(D, '10:20:06') });
    const a = await processAlert(body(), d);
    const b = await processAlert(body({ alert_time: new Date(etToEpoch(D, '10:20:04')).toISOString() }), d);
    expect(b.kind === 'STORED' && b.record.sameTickerEarlier).toEqual([(a as { id: string }).id]);
  });
  it('malformed payloads are rejected and logged', async () => {
    const d = deps();
    expect(await processAlert({ ...body(), symbol: '' }, d)).toMatchObject({ kind: 'REJECTED', status: 400 });
    expect(d.logs[0][0]).toBe('webhook_rejected');
  });
  it('test payloads are validated but never stored or enriched', async () => {
    const d = deps();
    expect((await processAlert(body({ test: true }), d)).kind).toBe('TEST_OK');
    expect((d.data as ReturnType<typeof fakeData>).calls).toEqual([]);
  });
  it('market-data failure → DATA_ERROR with the reason, no invented values; retry later fills it', async () => {
    const d = deps({ data: fakeData({ fail: 'Alpaca 503: busy' }) });
    const out = await processAlert(body(), d);
    expect(out.kind === 'STORED' && out.record).toMatchObject({ status: 'DATA_ERROR', snapshot: null, errors: ['Alpaca 503: busy'] });
    expect(d.logs.some((l) => l[0] === 'market_data_fetch_failed')).toBe(true);
    const rec = (out as Extract<typeof out, { kind: 'STORED' }>).record;
    const fixed = await enrichRecord(rec, { ...d, data: fakeData() });
    expect(fixed.status).toBe('OK');
    expect(fixed.attempts).toBe(2);
  });
  it('a completed (OK) snapshot is immutable', async () => {
    const d = deps();
    const out = await processAlert(body(), d);
    const rec = (out as { record: import('../../src/engine/automation/alertDecision').AutoAlertRecord }).record;
    const again = await enrichRecord(rec, { ...d, data: fakeData({ price: 1 }) });
    expect(again).toEqual(rec);
    const tampered = { ...rec, status: 'RECEIVED' as const };
    const stored = await enrichRecord(tampered, { ...d, data: fakeData({ price: 1 }) });
    expect(stored.initialQuote?.price).toBe(106); // the stored OK record wins over a concurrent re-run
  });
  it('the signal candle missing from the feed → OK record with an INCOMPLETE issue (fails closed in the app)', async () => {
    const d = deps({ data: fakeData({ bars: BARS.filter((b) => b.t !== etToEpoch(D, '10:10')) }) });
    const out = await processAlert(body(), d);
    expect(out.kind === 'STORED' && out.record.snapshot?.issues.map((i) => i.code)).toContain('SIGNAL_CANDLE_MISSING');
    expect(out.kind === 'STORED' && out.record.snapshot?.values).toBeNull();
  });
  it('waits for the just-closed signal candle to settle before fetching', async () => {
    const waits: number[] = [];
    const d = deps({ now: () => etToEpoch(D, '10:15:00') + 500, sleep: async (ms) => void waits.push(ms) });
    await processAlert(body({ alert_time: new Date(etToEpoch(D, '10:15:00')).toISOString() }), d);
    expect(waits[0]).toBe(2500);
  });
});

/* ───────────────────────── HTTP handlers ───────────────────────── */

describe('trendspider-alert handler', () => {
  const store = new MemoryStore();
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('TRENDSPIDER_WEBHOOK_SECRET', 'whsec');
    vi.stubEnv('ALPACA_API_KEY', 'AKTEST');
    vi.stubEnv('ALPACA_SECRET_KEY', 'SKTEST');
    vi.doMock('../lib/store', async (orig) => ({ ...(await orig<typeof import('../lib/store')>()), blobStore: async () => store }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('../lib/store');
  });
  const call = async (init: RequestInit) => (await import('../functions/trendspider-alert.mts')).default(new Request('https://site/.netlify/functions/trendspider-alert', init));
  it('rejects GET, invalid JSON, oversize, wrong token; never echoes the secret', async () => {
    expect((await call({ method: 'GET' })).status).toBe(405);
    expect((await call({ method: 'POST', body: '{nope' })).status).toBe(400);
    expect((await call({ method: 'POST', body: 'x'.repeat(5000) })).status).toBe(413);
    const bad = await call({ method: 'POST', body: JSON.stringify(body({ token: 'wrong' })) });
    expect(bad.status).toBe(401);
    expect(await bad.text()).not.toContain('whsec');
  });
  it('503 when the server secret is not configured (fails closed)', async () => {
    vi.stubEnv('TRENDSPIDER_WEBHOOK_SECRET', '');
    expect((await call({ method: 'POST', body: JSON.stringify(body()) })).status).toBe(503);
  });
  it('accepts a valid test alert', async () => {
    const res = await call({ method: 'POST', body: JSON.stringify(body({ test: true, alert_time: new Date().toISOString() })) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, test: true, parsed: { symbol: 'GM', direction: 'LONG' } });
  });
});

describe('read endpoints require the app access token', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('RB_APP_ACCESS_TOKEN', 'apptok');
    vi.doMock('../lib/store', async (orig) => ({ ...(await orig<typeof import('../lib/store')>()), blobStore: async () => new MemoryStore() }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('../lib/store');
  });
  it('rb-alerts / rb-quotes / rb-health → 401 without the bearer token; health shows booleans only', async () => {
    const alerts = (await import('../functions/rb-alerts.mts')).default;
    const quotes = (await import('../functions/rb-quotes.mts')).default;
    const health = (await import('../functions/rb-health.mts')).default;
    expect((await alerts(new Request('https://s/?date=2026-10-30'))).status).toBe(401);
    expect((await quotes(new Request('https://s/?symbols=GM'))).status).toBe(401);
    expect((await health(new Request('https://s/'))).status).toBe(401);
    const auth = { headers: { authorization: 'Bearer apptok' } };
    expect((await alerts(new Request('https://s/?date=2026-10-30', auth))).status).toBe(200);
    vi.stubEnv('ALPACA_API_KEY', 'AKSECRETVALUE');
    const h = await (await health(new Request('https://s/', auth))).text();
    expect(h).toContain('"alpacaKeySet":true');
    expect(h).not.toContain('AKSECRETVALUE');
    expect(h).not.toContain('apptok');
  });
});

/* ───────────────────────── logging & no-execution verification ───────────────────────── */

describe('logs never contain secrets', () => {
  it('credential-like fields are dropped and secret values masked', () => {
    const out = JSON.stringify(redact({ token: 'abc', nested: { apiKey: 'k', note: 'x MYSECRET1 y' }, ok: 1 }, ['MYSECRET1']));
    expect(out).toBe('{"nested":{"note":"x [REDACTED] y"},"ok":1}');
  });
});

describe('NO TRADE EXECUTION — static verification of all server and app code', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) {
        if (!['node_modules', '__tests__', 'dist'].includes(f)) walk(p);
      } else if (/\.(m?ts|tsx)$/.test(f)) files.push(p);
    }
  };
  walk(join(__dirname, '..'));
  walk(join(__dirname, '..', '..', 'src'));
  const src = files.map((f) => [f, readFileSync(f, 'utf8')] as const);
  it('scans the code', () => expect(files.length).toBeGreaterThan(30));
  it.each([
    ['Alpaca trading hosts', /(paper-)?api\.alpaca\.markets/],
    ['order endpoints', /\/v2\/orders|\/v2\/positions|\/v2\/account\b/],
    ['SignalStack', /signalstack\.com\/|hooks\.signalstack/i],
  ])('no %s', (_, re) => {
    const hits = src.filter(([f, t]) => re.test(t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')) && !f.endsWith('alpaca.ts'));
    expect(hits.map(([f]) => f)).toEqual([]);
  });
  it('the only outbound HTTP in the functions is the guarded GET market-data client', () => {
    const fetchers = src.filter(([f, t]) => f.includes('netlify') && /\bfetch\(|\bf\(url/.test(t)).map(([f]) => f.replace(/\\/g, '/').split('/netlify/')[1]);
    expect(fetchers).toEqual(['lib/alpaca.ts']);
    const alp = src.find(([f]) => f.endsWith('alpaca.ts'))![1];
    expect(alp).toContain("assertReadOnlyDataRequest(url, 'GET')");
    expect(alp).toContain("method: 'GET'");
    expect(alp).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
  });
  it('the browser app never calls a broker (only the app\'s own functions)', () => {
    const app = src.filter(([f]) => !f.includes(`${join('netlify', '')}`));
    const urls = app.flatMap(([, t]) => [...t.matchAll(/fetch\(\s*[`'"]([^`'"]+)/g)].map((m) => m[1]));
    expect(urls.every((u) => u.startsWith('/.netlify/functions/'))).toBe(true);
  });
});
