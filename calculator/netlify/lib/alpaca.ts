/**
 * READ-ONLY Alpaca Market Data client.
 *
 * Architectural guard: every request goes through `assertReadOnlyDataRequest`, which allows ONLY HTTP GET to the
 * Market Data host (data.alpaca.markets / data.sandbox.alpaca.markets) under /v2/stocks/. The Trading API host
 * (api.alpaca.markets, paper-api.alpaca.markets) and every order/position/account path are rejected, so this
 * module cannot place, modify or cancel an order even if misused.
 */
import type { Bar } from '../../src/engine/automation/indicators';
import type { QuoteSnapshot } from '../../src/engine/automation/alertDecision';

export const ALLOWED_DATA_HOSTS = ['data.alpaca.markets', 'data.sandbox.alpaca.markets'];

export function assertReadOnlyDataRequest(url: string, method: string): void {
  const u = new URL(url);
  if (method.toUpperCase() !== 'GET') throw new Error(`Blocked: market-data client only performs GET (got ${method}).`);
  if (u.protocol !== 'https:' || !ALLOWED_DATA_HOSTS.includes(u.hostname)) throw new Error(`Blocked: ${u.hostname} is not an Alpaca market-data host.`);
  if (!u.pathname.startsWith('/v2/stocks/')) throw new Error(`Blocked: ${u.pathname} is not a market-data path.`);
  if (/order|position|account|asset|watchlist/i.test(u.pathname)) throw new Error('Blocked: trading endpoint.');
}

export interface MarketDataClient {
  readonly name: 'Alpaca';
  readonly feed: string;
  readonly host: string;
  getBars5(symbol: string, startIso: string, endIso: string): Promise<Bar[]>;
  getLatestTrades(symbols: string[]): Promise<Record<string, QuoteSnapshot>>;
}

export interface AlpacaOptions {
  keyId: string;
  secretKey: string;
  baseUrl?: string;
  feed?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  attempts?: number;
  now?: () => number;
}

export class DataFetchError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createAlpacaData(o: AlpacaOptions): MarketDataClient {
  const base = (o.baseUrl || 'https://data.alpaca.markets').replace(/\/+$/, '');
  const feed = (o.feed || 'sip').toLowerCase();
  if (!['sip', 'iex', 'delayed_sip', 'boats', 'overnight'].includes(feed)) throw new Error(`Unsupported ALPACA_DATA_FEED "${feed}".`);
  const f = o.fetchImpl ?? fetch;
  const attempts = Math.max(1, Math.min(4, o.attempts ?? 3));
  const timeoutMs = o.timeoutMs ?? 2500;
  const now = o.now ?? Date.now;
  const host = new URL(base).hostname;

  async function get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = `${base}${path}?${new URLSearchParams(params).toString()}`;
    assertReadOnlyDataRequest(url, 'GET');
    let last: DataFetchError | null = null;
    for (let i = 0; i < attempts; i++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await f(url, { method: 'GET', headers: { 'APCA-API-KEY-ID': o.keyId, 'APCA-API-SECRET-KEY': o.secretKey, accept: 'application/json' }, signal: ctl.signal });
        if (res.ok) return await res.json();
        const text = (await res.text()).slice(0, 300);
        last = new DataFetchError(`Alpaca ${res.status}: ${text}`, res.status);
        if (res.status !== 429 && res.status < 500) break; // 4xx (auth, subscription, bad symbol) will not fix itself
      } catch (e) {
        last = new DataFetchError(`Alpaca request failed: ${(e as Error).name === 'AbortError' ? `timeout after ${timeoutMs} ms` : (e as Error).message}`, null);
      } finally {
        clearTimeout(timer);
      }
      if (i < attempts - 1) await sleep(250 * 3 ** i); // bounded backoff: 250 ms, 750 ms, 2250 ms
    }
    throw last ?? new DataFetchError('Alpaca request failed.', null);
  }

  return {
    name: 'Alpaca',
    feed,
    host,
    async getBars5(symbol, startIso, endIso) {
      const out: Bar[] = [];
      let page: string | undefined;
      for (let n = 0; n < 10; n++) {
        const params: Record<string, string> = { timeframe: '5Min', start: startIso, end: endIso, adjustment: 'raw', feed, limit: '10000', sort: 'asc' };
        if (page) params.page_token = page;
        const j = (await get(`/v2/stocks/${encodeURIComponent(symbol)}/bars`, params)) as { bars?: { t: string; o: number; h: number; l: number; c: number; v: number }[] | null; next_page_token?: string | null };
        for (const b of j.bars ?? []) out.push({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
        page = j.next_page_token ?? undefined;
        if (!page) break;
      }
      return out;
    },
    async getLatestTrades(symbols) {
      const j = (await get('/v2/stocks/trades/latest', { symbols: symbols.join(','), feed })) as { trades?: Record<string, { t: string; p: number }> };
      const fetchedIso = new Date(now()).toISOString();
      const out: Record<string, QuoteSnapshot> = {};
      for (const [s, t] of Object.entries(j.trades ?? {})) if (t && Number.isFinite(t.p) && t.p > 0) out[s] = { price: t.p, tradeIso: t.t, fetchedIso };
      return out;
    },
  };
}

/** Short-lived cache for COMPLETED historical bars only (never for current prices). */
export class BarCache {
  private m = new Map<string, { at: number; bars: Bar[] }>();
  constructor(private ttlMs = 60_000) {}
  get(key: string, now = Date.now()) {
    const x = this.m.get(key);
    return x && now - x.at < this.ttlMs ? x.bars : null;
  }
  set(key: string, bars: Bar[], now = Date.now()) {
    if (this.m.size > 500) this.m.clear();
    this.m.set(key, { at: now, bars });
  }
}
