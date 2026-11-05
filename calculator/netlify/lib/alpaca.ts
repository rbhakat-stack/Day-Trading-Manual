/**
 * READ-ONLY Alpaca clients: market data (below) and, separately guarded, broker facts (orders/positions of the paper
 * account, GET list endpoints only — end of this file). Nothing in this module can submit, modify, cancel or close
 * an order or position.
 *
 * READ-ONLY Alpaca Market Data client.
 *
 * Architectural guard: every request goes through `assertReadOnlyDataRequest`, which allows ONLY HTTP GET to the
 * Market Data host (data.alpaca.markets / data.sandbox.alpaca.markets) under /v2/stocks/. The Trading API host
 * (api.alpaca.markets, paper-api.alpaca.markets) and every order/position/account path are rejected, so this
 * module cannot place, modify or cancel an order even if misused.
 */
import type { Bar } from '../../src/engine/automation/indicators';
import type { QuoteSnapshot } from '../../src/engine/automation/alertDecision';
import { isEligibleTrade } from '../../src/engine/automation/tradeEligibility';

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
  /** 1-minute bars (used only by the Historical SIP Parity Test for intrabar reconstruction). */
  getBars1?(symbol: string, startIso: string, endIso: string): Promise<Bar[]>;
  getLatestTrades(symbols: string[]): Promise<Record<string, QuoteSnapshot>>;
  /** Step 3 · A — every trade print in [start, end] (ascending), or null when more than `maxPages` pages (incomplete). */
  getTrades?(symbol: string, startIso: string, endIso: string, maxPages?: number): Promise<RawTrade[] | null>;
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
    async getBars1(symbol, startIso, endIso) {
      const out: Bar[] = [];
      let page: string | undefined;
      for (let n = 0; n < 10; n++) {
        const params: Record<string, string> = { timeframe: '1Min', start: startIso, end: endIso, adjustment: 'raw', feed, limit: '10000', sort: 'asc' };
        if (page) params.page_token = page;
        const j = (await get(`/v2/stocks/${encodeURIComponent(symbol)}/bars`, params)) as { bars?: { t: string; o: number; h: number; l: number; c: number; v: number }[] | null; next_page_token?: string | null };
        for (const b of j.bars ?? []) out.push({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
        page = j.next_page_token ?? undefined;
        if (!page) break;
      }
      return out;
    },
    /**
     * Step 3 · D — latest ELIGIBLE trade per symbol (tradeEligibility.ts). The provider's latest-trade endpoint does not
     * filter conditions, so when its print is ineligible (odd lot, average-price, derivatively priced, out of sequence …)
     * the newest eligible print of the last LATEST_ELIGIBLE_LOOKBACK_MS is used instead (newest-first, bounded pages).
     * A symbol with no eligible print in that window, or whose lookup fails, is left out — the client then has no current
     * price for it (no ticket, fail closed); other symbols are unaffected. Freshness is judged downstream by trade time.
     */
    async getLatestTrades(symbols) {
      const j = (await get('/v2/stocks/trades/latest', { symbols: symbols.join(','), feed })) as { trades?: Record<string, RawTrade> };
      const fetchedMs = now();
      const fetchedIso = new Date(fetchedMs).toISOString();
      const out: Record<string, QuoteSnapshot> = {};
      await Promise.all(Object.entries(j.trades ?? {}).map(async ([s, t]) => {
        if (!t || !Number.isFinite(t.p) || !(t.p > 0)) return;
        if (isEligibleTrade(t)) { out[s] = { price: t.p, tradeIso: t.t, fetchedIso, conditions: t.c ?? [], tape: t.z ?? undefined, priceSource: 'LATEST', skipped: null }; return; }
        try {
          const e = await newestEligible(s, new Date(fetchedMs - LATEST_ELIGIBLE_LOOKBACK_MS).toISOString(), fetchedIso);
          if (e) out[s] = { price: e.p, tradeIso: e.t, fetchedIso, conditions: e.c ?? [], tape: e.z ?? undefined, priceSource: 'LATEST_ELIGIBLE', skipped: { price: t.p, tradeIso: t.t, conditions: t.c ?? [], tape: t.z ?? null } };
        } catch {
          /* no eligible price for this symbol on this poll — fail closed for it only */
        }
      }));
      return out;
    },
    async getTrades(symbol, startIso, endIso, maxPages = 5) {
      const out: RawTrade[] = [];
      let page: string | undefined;
      for (let n = 0; n < maxPages; n++) {
        const params: Record<string, string> = { start: startIso, end: endIso, feed, limit: '10000', sort: 'asc' };
        if (page) params.page_token = page;
        const j = (await get(`/v2/stocks/${encodeURIComponent(symbol)}/trades`, params)) as { trades?: RawTrade[] | null; next_page_token?: string | null };
        out.push(...(j.trades ?? []));
        page = j.next_page_token ?? undefined;
        if (!page) return out;
      }
      return null; // more pages than allowed: incomplete — callers fail closed
    },
  };

  async function newestEligible(symbol: string, startIso: string, endIso: string): Promise<RawTrade | null> {
    let page: string | undefined;
    for (let n = 0; n < 3; n++) {
      const params: Record<string, string> = { start: startIso, end: endIso, feed, limit: '1000', sort: 'desc' };
      if (page) params.page_token = page;
      const j = (await get(`/v2/stocks/${encodeURIComponent(symbol)}/trades`, params)) as { trades?: RawTrade[] | null; next_page_token?: string | null };
      const hit = (j.trades ?? []).find((t) => Number.isFinite(t.p) && t.p > 0 && isEligibleTrade(t));
      if (hit) return hit;
      page = j.next_page_token ?? undefined;
      if (!page) return null;
    }
    return null;
  }
}

/** A provider trade print (Alpaca v2): time, price, size, exchange, conditions, tape. */
export interface RawTrade { t: string; p: number; s?: number; x?: string; c?: string[] | null; z?: string | null }

/** Look-back for the newest eligible print when the provider's latest print is ineligible. */
export const LATEST_ELIGIBLE_LOOKBACK_MS = 5 * 60_000;

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

/* ───────────────────────── READ-ONLY broker facts (CR-12) ───────────────────────── */

/**
 * READ-ONLY Alpaca broker client (orders and positions of the PAPER account only).
 *
 * Narrowest possible extension of the no-execution boundary, separate from the market-data guard above:
 *   • method: GET only — the request below hard-codes `method: 'GET'` and sends no body;
 *   • host: the paper Trading API host only (the live trading host is NOT allowed);
 *   • paths: exactly the two LIST endpoints `/v2/orders` and `/v2/positions` — no ids, no sub-paths, so the
 *     per-order / per-position endpoints (which accept DELETE/PATCH) are unreachable, and `/v2/account`,
 *     activities, watchlists, assets and everything else are rejected;
 *   • query: an allowlist of read filters only.
 * There is no function here that submits, replaces, cancels or closes anything; tests assert POST/PUT/PATCH/DELETE
 * are rejected for every URL and that every network call is a GET without a body.
 */
export const ALLOWED_BROKER_HOSTS = ['paper-api.alpaca.markets'];
export const DEFAULT_BROKER_BASE_URL = 'https://paper-api.alpaca.markets';
const BROKER_PATHS: Record<string, string[]> = {
  '/v2/orders': ['status', 'limit', 'after', 'until', 'direction', 'nested', 'symbols'],
  '/v2/positions': [],
};

export function assertReadOnlyBrokerRequest(url: string, method: string): void {
  const u = new URL(url);
  if (method.toUpperCase() !== 'GET') throw new Error(`Blocked: broker client only performs GET (got ${method}).`);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !ALLOWED_BROKER_HOSTS.includes(u.hostname)) throw new Error(`Blocked: ${u.hostname} is not the Alpaca paper trading host.`);
  const allowed = BROKER_PATHS[u.pathname];
  if (!allowed) throw new Error(`Blocked: ${u.pathname} is not a read-only broker list endpoint.`);
  for (const k of u.searchParams.keys()) if (!allowed.includes(k)) throw new Error(`Blocked: query parameter "${k}" is not allowed.`);
}

/** Page size of the open-order list; a full page may be truncated (the caller treats it as unknown). */
export const OPEN_ORDERS_LIMIT = 500;

export interface BrokerReadClient {
  readonly host: string;
  /** Raw Alpaca order objects (with bracket legs when nested=true), oldest first. */
  listOrders(o: { afterIso: string; untilIso?: string; limit?: number; symbols?: string[] }): Promise<unknown[]>;
  /** Raw Alpaca order objects that are open NOW, whatever day they were submitted (bracket legs nested). */
  listOpenOrders(): Promise<unknown[]>;
  /** Raw Alpaca position objects. */
  listPositions(): Promise<unknown[]>;
}

export function createAlpacaBrokerRead(o: { keyId: string; secretKey: string; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): BrokerReadClient {
  const base = (o.baseUrl || DEFAULT_BROKER_BASE_URL).replace(/\/+$/, '');
  assertReadOnlyBrokerRequest(`${base}/v2/positions`, 'GET'); // fail fast on a wrong host
  const f = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 4000;
  async function read(path: string, params: Record<string, string>): Promise<unknown[]> {
    const qs = new URLSearchParams(params).toString();
    const url = `${base}${path}${qs ? `?${qs}` : ''}`;
    assertReadOnlyBrokerRequest(url, 'GET');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await f(url, { method: 'GET', headers: { 'APCA-API-KEY-ID': o.keyId, 'APCA-API-SECRET-KEY': o.secretKey, accept: 'application/json' }, signal: ctl.signal });
      if (!res.ok) throw new DataFetchError(`Alpaca broker ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
      const j = await res.json();
      return Array.isArray(j) ? j : [];
    } catch (e) {
      if (e instanceof DataFetchError) throw e;
      throw new DataFetchError(`Alpaca broker request failed: ${(e as Error).name === 'AbortError' ? `timeout after ${timeoutMs} ms` : (e as Error).message}`, null);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    host: new URL(base).hostname,
    listOrders: ({ afterIso, untilIso, limit = 500, symbols }) => read('/v2/orders', { status: 'all', nested: 'true', direction: 'asc', limit: String(Math.min(500, Math.max(1, limit))), after: afterIso, ...(untilIso ? { until: untilIso } : {}), ...(symbols?.length ? { symbols: symbols.join(',') } : {}) }),
    listOpenOrders: () => read('/v2/orders', { status: 'open', nested: 'true', direction: 'asc', limit: String(OPEN_ORDERS_LIMIT) }),
    listPositions: () => read('/v2/positions', {}),
  };
}
