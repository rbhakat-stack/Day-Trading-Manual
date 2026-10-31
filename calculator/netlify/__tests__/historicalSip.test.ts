import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertHistoricalBarsRequest, classifyFailure, runHistoricalSipTest, type HistoricalDeps } from '../lib/historicalSip';
import { DataFetchError, type MarketDataClient } from '../lib/alpaca';
import { enrichRecord, processAlert, type ProcessDeps } from '../lib/processAlert';
import { MemoryStore } from '../lib/store';
import { daysUpTo, minuteBars, sessionBars, toFive } from '../../src/engine/automation/__tests__/fixtures';
import { etToEpoch } from '../../src/engine/automation/etTime';
import { buildAlertSnapshot } from '../../src/engine/automation/alertSnapshot';
import { historicalWindow, requestWindows } from '../../src/engine/automation/historicalParity';
import type { Bar } from '../../src/engine/automation/indicators';

const D = '2026-10-30';
const ALERT = etToEpoch(D, '15:54');
const NOW = ALERT + 3600_000;
const MIN1 = minuteBars(daysUpTo(D));
const BARS = toFive(MIN1);
const REQ = { symbol: 'IBM', direction: 'LONG', alertEt: '2026-10-30 15:54', label: 'IBM parity' };

/** Fake Alpaca HTTP: serves bars, records every URL; `status` simulates provider errors. */
function fakeFetch(o: { bars?: Bar[]; min1?: Bar[]; status?: number; text?: string } = {}) {
  const urls: string[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    expect(init?.method).toBe('GET');
    if (o.status) return new Response(o.text ?? '{"message":"error"}', { status: o.status });
    const u = new URL(url);
    const s = Date.parse(u.searchParams.get('start')!);
    const e = Date.parse(u.searchParams.get('end')!);
    const src = u.searchParams.get('timeframe') === '1Min' ? (o.min1 ?? MIN1) : (o.bars ?? BARS);
    const bars = src.filter((b) => b.t >= s && b.t <= e).map((b) => ({ ...b, t: new Date(b.t).toISOString() })); // Alpaca: end inclusive
    return new Response(JSON.stringify({ bars, next_page_token: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { f: f as unknown as typeof fetch, urls };
}

const deps = (f: typeof fetch, o: Partial<HistoricalDeps> = {}): HistoricalDeps & { logs: [string, Record<string, unknown>][] } => {
  const logs: [string, Record<string, unknown>][] = [];
  return { keyId: 'AKHISTKEY', secretKey: 'SKHISTSECRET', fetchImpl: f, now: () => NOW, log: (e, x = {}) => void logs.push([e, x]), logs, ...o };
};

describe('historical SIP guard — bars only, SIP only, historical only', () => {
  const ok = `https://data.alpaca.markets/v2/stocks/IBM/bars?timeframe=5Min&feed=sip&end=${encodeURIComponent(new Date(ALERT).toISOString())}`;
  it('allows 1Min, blocks other timeframes', () => {
    expect(() => assertHistoricalBarsRequest(ok.replace('5Min', '1Min'), 'GET', NOW)).not.toThrow();
    expect(() => assertHistoricalBarsRequest(ok.replace('5Min', '1Day'), 'GET', NOW)).toThrow(/Blocked/);
    expect(() => assertHistoricalBarsRequest(ok.replace('timeframe=5Min&', ''), 'GET', NOW)).toThrow(/Blocked/);
  });
  it('allows a historical SIP bars request', () => expect(() => assertHistoricalBarsRequest(ok, 'GET', NOW)).not.toThrow());
  it.each([
    ['latest trades', 'https://data.alpaca.markets/v2/stocks/trades/latest?symbols=IBM&feed=sip'],
    ['latest quotes', 'https://data.alpaca.markets/v2/stocks/quotes/latest?symbols=IBM&feed=sip'],
    ['per-symbol latest trade', 'https://data.alpaca.markets/v2/stocks/IBM/trades/latest?feed=sip'],
    ['snapshot', 'https://data.alpaca.markets/v2/stocks/IBM/snapshot?feed=sip'],
    ['snapshots', 'https://data.alpaca.markets/v2/stocks/snapshots?symbols=IBM&feed=sip'],
    ['IEX feed', ok.replace('feed=sip', 'feed=iex')],
    ['no feed', ok.replace('&feed=sip', '')],
    ['no end', 'https://data.alpaca.markets/v2/stocks/IBM/bars?timeframe=5Min&feed=sip'],
    ['trading host', ok.replace('data.alpaca.markets', 'paper-api.alpaca.markets')],
  ])('blocks %s', (_n, url) => expect(() => assertHistoricalBarsRequest(url, 'GET', NOW)).toThrow(/Blocked/));
  it('blocks non-GET and an end newer than 16 minutes', () => {
    expect(() => assertHistoricalBarsRequest(ok, 'POST', NOW)).toThrow(/Blocked/);
    expect(() => assertHistoricalBarsRequest(ok, 'GET', ALERT + 10 * 60_000)).toThrow(/too recent/);
  });
});

describe('runHistoricalSipTest', () => {
  beforeEach(() => vi.stubEnv('ALPACA_DATA_FEED', 'iex'));
  afterEach(() => vi.unstubAllEnvs());

  it('never calls latest-trade / latest-quote / snapshot endpoints — bars only', async () => {
    const { f, urls } = fakeFetch();
    const out = await runHistoricalSipTest(REQ, deps(f));
    expect(out.ok).toBe(true);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(new URL(u).pathname).toBe('/v2/stocks/IBM/bars');
      expect(u).not.toMatch(/latest|snapshot|quotes|trades/i);
    }
    expect(urls.map((u) => new URL(u).searchParams.get('timeframe')).sort()).toEqual(['1Min', '5Min']);
  });

  it('forces feed=sip even when ALPACA_DATA_FEED=iex, and leaves the env variable unchanged', async () => {
    const { f, urls } = fakeFetch();
    await runHistoricalSipTest(REQ, deps(f));
    for (const u of urls) expect(new URL(u).searchParams.get('feed')).toBe('sip');
    expect(process.env.ALPACA_DATA_FEED).toBe('iex');
    vi.stubEnv('ALPACA_API_KEY', 'AK');
    vi.stubEnv('ALPACA_SECRET_KEY', 'SK');
    const { dataClient } = await import('../lib/env');
    expect(dataClient()?.feed).toBe('iex'); // the live client is unaffected
  });

  it('5m history starts where the live path starts and ends before the active bucket; 1m covers the bucket to the cutoff', async () => {
    const { f, urls } = fakeFetch();
    await runHistoricalSipTest(REQ, deps(f));
    const by = (tf: string) => new URL(urls.find((u) => u.includes(`timeframe=${tf}`))!);
    const w = historicalWindow(ALERT);
    expect([by('5Min').searchParams.get('start'), by('5Min').searchParams.get('end')]).toEqual([w.startIso, new Date(etToEpoch(D, '15:49:59')).toISOString()]);
    expect([by('1Min').searchParams.get('start'), by('1Min').searchParams.get('end')]).toEqual([new Date(etToEpoch(D, '15:50')).toISOString(), new Date(etToEpoch(D, '15:54:59')).toISOString()]);
    // live enrichRecord for the same alert requests the identical bars window
    const seen: string[][] = [];
    const data: MarketDataClient = { name: 'Alpaca', feed: 'iex', host: 'h', getBars5: async (_s, a, b) => (seen.push([a, b]), BARS), getLatestTrades: async () => ({}) };
    const live = await processAlert({ strategy: 'RB_V1', symbol: 'IBM', direction: 'LONG', alert_name: 'RB v1 LONG Setup', alert_time: new Date(ALERT).toISOString() }, { store: new MemoryStore(), data, log: () => {}, now: () => ALERT + 2000, sleep: async () => {} });
    expect(live.kind).toBe('STORED');
    expect(seen[0][0]).toBe(w.startIso); // same warm-up start as live
    expect(requestWindows({ alertMs: ALERT, cutoffs: [{ key: 'EXACT', ms: ALERT }] }).history5m.startIso).toBe(w.startIso);
  });

  it('IBM ≈15:54: active 15:50–15:55, 15m 15:30–15:45; LATEST bound = the completed-candle (old) snapshot values', async () => {
    const { f } = fakeFetch();
    const out = await runHistoricalSipTest(REQ, deps(f));
    if (!out.ok) throw new Error(out.errors.join());
    expect(out.result.timing).toMatchObject({ activeLabel: '15:50–15:55', confirm15mLabel: '15:30–15:45' });
    expect(out.result.precision).toBe('APPROXIMATE_MINUTE');
    const old = buildAlertSnapshot(BARS, etToEpoch(D, '15:55:10'), 'LONG').values!;
    expect({ ...out.result.bounds[1].snapshot.values, rvol: 0 }).toEqual({ ...old, rvol: 0 }); // RVOL: parity formula (tested in historicalParity.test.ts)
    expect(out.result.bounds[1].snapshot.rvolParity?.legacy).toBe(old.rvol);
    expect(out.result.bounds[0].snapshot.minutesUsed).toEqual(['15:50', '15:51', '15:52', '15:53']);
    expect(out.result).toMatchObject({ mode: 'HISTORICAL_DIAGNOSTIC', provider: { name: 'Alpaca', feed: 'sip', host: 'data.alpaca.markets' }, request: { currentPriceFetched: false }, testLabel: 'IBM parity' });
    expect(out.result.bounds.every((b) => b.derived)).toBe(true);
  });
  it('NEE ≈15:44 SHORT: active 15:40–15:45 (not 15:35–15:40), completed 15m 15:15–15:30', async () => {
    const { f } = fakeFetch();
    const out = await runHistoricalSipTest({ symbol: 'NEE', direction: 'SHORT', alertEt: '2026-10-30 15:44', label: '' }, deps(f));
    if (!out.ok) throw new Error(out.errors.join());
    expect(out.result.timing).toMatchObject({ activeLabel: '15:40–15:45', confirm15mLabel: '15:15–15:30' });
  });
  it('requests never reach past the cutoff (no future data requested)', async () => {
    const { f, urls } = fakeFetch();
    await runHistoricalSipTest({ ...REQ, alertEt: '2026-10-30 15:52:00' }, deps(f));
    const cutoff = etToEpoch(D, '15:52:00');
    for (const u of urls) expect(Date.parse(new URL(u).searchParams.get('end')!)).toBeLessThan(cutoff);
  });

  it('an alert too recent for historical SIP is refused before any request', async () => {
    const { f, urls } = fakeFetch();
    const out = await runHistoricalSipTest(REQ, deps(f, { now: () => ALERT + 5 * 60_000 }));
    expect(out).toMatchObject({ ok: false, status: 400, kind: 'INVALID_REQUEST' });
    expect(urls).toHaveLength(0);
  });

  it('insufficient historical bars fail closed (no values, no ticket)', async () => {
    const { f } = fakeFetch({ bars: sessionBars([D]).slice(-30) });
    const out = await runHistoricalSipTest(REQ, deps(f));
    if (!out.ok) throw new Error('expected a result');
    for (const b of out.result.bounds) {
      expect(b.snapshot.values).toBeNull();
      expect(b.derived).toBeNull();
      expect(b.snapshot.issues.map((i) => i.code)).toContain('INSUFFICIENT_HISTORY');
    }
  });

  it('SIP entitlement / authorization errors are surfaced cleanly; never retried on IEX; secrets never echoed', async () => {
    const ent = fakeFetch({ status: 403, text: '{"message":"subscription does not permit querying recent SIP data"}' });
    const a = await runHistoricalSipTest(REQ, deps(ent.f));
    expect(a).toMatchObject({ ok: false, kind: 'ENTITLEMENT' });
    if (!a.ok) expect(a.errors[0]).toMatch(/SIP entitlement failure \(HTTP 403\).*subscription does not permit/);
    expect(ent.urls.every((u) => u.includes('feed=sip'))).toBe(true);

    const auth = fakeFetch({ status: 401, text: '{"message":"unauthorized. key AKHISTKEY"}' });
    const b = await runHistoricalSipTest(REQ, deps(auth.f));
    expect(b).toMatchObject({ ok: false, kind: 'AUTHORIZATION' });
    expect(JSON.stringify(b)).not.toContain('AKHISTKEY');
    expect(JSON.stringify(b)).not.toContain('SKHISTSECRET');

    const win = await runHistoricalSipTest(REQ, deps(fakeFetch({ status: 422, text: '{"message":"invalid start"}' }).f));
    expect(win).toMatchObject({ ok: false, kind: 'HISTORICAL_WINDOW' });
  });

  it('classifies network failures and missing configuration', async () => {
    expect(classifyFailure(new DataFetchError('Alpaca request failed: timeout after 4000 ms', null)).kind).toBe('NETWORK');
    expect(classifyFailure(new DataFetchError('Alpaca 503: down', 503)).kind).toBe('PROVIDER');
    expect(await runHistoricalSipTest(REQ, deps(fakeFetch().f, { keyId: undefined }))).toMatchObject({ ok: false, status: 503, kind: 'NOT_CONFIGURED' });
  });
});

/* ───────────────────────── isolation from the live pipeline ───────────────────────── */

describe('isolation: no live alert, no candidate, no capital, no heat, no journal, no dedupe collision', () => {
  const ROOT = join(__dirname, '..', '..');
  const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const FILES = ['netlify/lib/historicalSip.ts', 'netlify/functions/rb-historical-parity.mts', 'src/engine/automation/historicalParity.ts', 'src/components/live/HistoricalSipTest.tsx'];

  it('historical modules import nothing that stores alerts or touches ranker / portfolio / journal / queue state', () => {
    for (const f of FILES) {
      // value imports only (`import type` is erased at build time and carries no behaviour)
      const imports = [...src(f).matchAll(/^import\s+(?!type\s)[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]);
      expect(imports.length, f).toBeGreaterThan(0);
      for (const i of imports) expect(i, `${f} imports ${i}`).not.toMatch(/store|blobs|ranker|portfolio|journal|liveQueue|alertDecision'?$|processAlert|storage|opportunity|candidate/i);
    }
  });

  it('the historical function never opens Netlify Blobs or the alert store', async () => {
    vi.resetModules();
    const getStore = vi.fn();
    const blobStore = vi.fn();
    vi.doMock('@netlify/blobs', () => ({ getStore }));
    vi.doMock('../lib/store', async (orig) => ({ ...(await orig<typeof import('../lib/store')>()), blobStore }));
    vi.stubEnv('RB_APP_ACCESS_TOKEN', 'apptok');
    vi.stubEnv('ALPACA_API_KEY', 'AKHISTKEY');
    vi.stubEnv('ALPACA_SECRET_KEY', 'SKHISTSECRET');
    vi.stubEnv('ALPACA_DATA_FEED', 'iex');
    const { f, urls } = fakeFetch();
    vi.stubGlobal('fetch', f);
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      const h = (await import('../functions/rb-historical-parity.mts')).default;
      expect((await h(new Request('https://s/', { method: 'POST', body: JSON.stringify(REQ) }))).status).toBe(401);
      expect((await h(new Request('https://s/', { method: 'GET', headers: { authorization: 'Bearer apptok' } }))).status).toBe(405);
      const res = await h(new Request('https://s/', { method: 'POST', headers: { authorization: 'Bearer apptok' }, body: JSON.stringify(REQ) }));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ ok: true, result: { mode: 'HISTORICAL_DIAGNOSTIC', provider: { feed: 'sip' } } });
      for (const s of ['AKHISTKEY', 'SKHISTSECRET', 'apptok']) expect(text).not.toContain(s);
      expect(urls.every((u) => u.includes('feed=sip') && u.includes('/bars?'))).toBe(true);
      const bad = await h(new Request('https://s/', { method: 'POST', headers: { authorization: 'Bearer apptok' }, body: JSON.stringify({ ...REQ, symbol: 'IBM;DROP' }) }));
      expect(bad.status).toBe(400);
      expect(getStore).not.toHaveBeenCalled();
      expect(blobStore).not.toHaveBeenCalled();
      expect(process.env.ALPACA_DATA_FEED).toBe('iex');
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.doUnmock('@netlify/blobs');
      vi.doUnmock('../lib/store');
    }
  });

  it('a live webhook for the same ticker / direction / time after a historical test is stored normally (no dedupe collision)', async () => {
    const store = new MemoryStore();
    const { f } = fakeFetch();
    await runHistoricalSipTest(REQ, deps(f));
    expect(await store.list(D)).toHaveLength(0);
    const data: MarketDataClient = { name: 'Alpaca', feed: 'sip', host: 'h', getBars5: async () => BARS, getLatestTrades: async (s) => Object.fromEntries(s.map((x) => [x, { price: 258, tradeIso: new Date(ALERT).toISOString(), fetchedIso: new Date(ALERT).toISOString() }])) };
    const d: ProcessDeps = { store, data, log: () => {}, now: () => ALERT + 2000, sleep: async () => {} };
    const live = await processAlert({ strategy: 'RB_V1', symbol: 'IBM', direction: 'LONG', alert_name: 'RB v1 LONG Setup', alert_time: new Date(ALERT).toISOString() }, d);
    expect(live.kind).toBe('STORED');
    expect(await store.list(D)).toHaveLength(1);
    // and the live record is the normal live output: current price fetched, calculator reference computed
    if (live.kind === 'STORED') {
      expect(live.record.initialQuote?.price).toBe(258);
      expect(live.record.snapshot).toEqual(buildAlertSnapshot(BARS, ALERT, 'LONG'));
      expect((await enrichRecord(live.record, d)).status).toBe('OK');
    }
  });
});
