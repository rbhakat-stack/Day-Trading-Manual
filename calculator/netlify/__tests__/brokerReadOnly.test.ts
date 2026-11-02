/**
 * CR-12 — READ-ONLY broker facts. GET of the two paper list endpoints is permitted; every trading mutation
 * (POST / PUT / PATCH / DELETE), every other path, host and query is impossible from RB. These tests ADD to the
 * existing NO TRADE EXECUTION guard tests (server.test.ts), which are unchanged.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { assertReadOnlyBrokerRequest, assertReadOnlyDataRequest, createAlpacaBrokerRead, createAlpacaData, type BrokerReadClient } from '../lib/alpaca';
import { handleBroker, sanitizeOrder } from '../functions/rb-broker.mts';

const P = 'https://paper-api.alpaca.markets';
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('broker guard: reads permitted', () => {
  it.each([
    `${P}/v2/orders?status=all&nested=true&direction=asc&limit=500&after=2026-10-30T08:00:00Z&until=2026-10-31T00:00:00Z`,
    `${P}/v2/orders?symbols=GM`,
    `${P}/v2/positions`,
  ])('GET %s', (url) => expect(() => assertReadOnlyBrokerRequest(url, 'GET')).not.toThrow());
});

describe('broker guard: every mutation and every other target is impossible', () => {
  const targets = [`${P}/v2/orders`, `${P}/v2/positions`, `${P}/v2/orders/abc-123`, `${P}/v2/positions/GM`];
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete', 'HEAD', 'OPTIONS'])('%s is rejected on every broker URL', (m) => {
    for (const t of targets) expect(() => assertReadOnlyBrokerRequest(t, m)).toThrow(/Blocked/);
  });
  it.each([
    ['per-order endpoint (cancel/replace target)', `${P}/v2/orders/abc-123`],
    ['per-position endpoint (close target)', `${P}/v2/positions/GM`],
    ['order by client id', `${P}/v2/orders:by_client_order_id?client_order_id=x`],
    ['account', `${P}/v2/account`],
    ['account configuration', `${P}/v2/account/configurations`],
    ['activities', `${P}/v2/account/activities`],
    ['watchlists', `${P}/v2/watchlists`],
    ['trailing slash', `${P}/v2/orders/`],
    ['live trading host', 'https://api.alpaca.markets/v2/orders'],
    ['market-data host', 'https://data.alpaca.markets/v2/orders'],
    ['http', 'http://paper-api.alpaca.markets/v2/orders'],
    ['credentials in URL', 'https://user:pw@paper-api.alpaca.markets/v2/orders'],
    ['explicit port', 'https://paper-api.alpaca.markets:8443/v2/orders'],
    ['look-alike host', 'https://paper-api.alpaca.markets.evil.example/v2/orders'],
    ['unknown query parameter', `${P}/v2/orders?cancel_orders=true`],
    ['query on positions', `${P}/v2/positions?cancel_orders=true`],
  ])('GET %s is rejected', (_, url) => expect(() => assertReadOnlyBrokerRequest(url, 'GET')).toThrow(/Blocked/));
  it('a wrong base URL fails at construction', () => {
    expect(() => createAlpacaBrokerRead({ keyId: 'k', secretKey: 's', baseUrl: 'https://api.alpaca.markets' })).toThrow(/Blocked/);
  });
  it('the market-data guard is unchanged: it still rejects the trading host and order paths', () => {
    expect(() => assertReadOnlyDataRequest(`${P}/v2/orders`, 'GET')).toThrow(/Blocked/);
    expect(() => createAlpacaData({ keyId: 'k', secretKey: 's', baseUrl: P, fetchImpl: vi.fn() as never })).not.toThrow();
  });
});

describe('broker client: every network call is a body-less GET to an allowed URL', () => {
  it('listOrders / listPositions', async () => {
    const fetchImpl = vi.fn(async () => ok([{ id: 'o1' }]));
    const c = createAlpacaBrokerRead({ keyId: 'k', secretKey: 's', fetchImpl: fetchImpl as never });
    expect(Object.keys(c).sort()).toEqual(['host', 'listOrders', 'listPositions']);
    await c.listOrders({ afterIso: '2026-10-30T08:00:00.000Z', untilIso: '2026-10-31T00:00:00.000Z' });
    await c.listPositions();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchImpl.mock.calls as unknown as [string, RequestInit][]) {
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect(() => assertReadOnlyBrokerRequest(url, 'GET')).not.toThrow();
    }
  });
  it('broker errors surface as errors (never retried into another endpoint)', async () => {
    const c = createAlpacaBrokerRead({ keyId: 'k', secretKey: 's', fetchImpl: (async () => new Response('forbidden', { status: 403 })) as never });
    await expect(c.listPositions()).rejects.toThrow(/403/);
  });
});

describe('static: the module contains no mutation capability', () => {
  const src = readFileSync(join(__dirname, '..', 'lib', 'alpaca.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  it('every fetch in alpaca.ts is guarded and GET', () => {
    expect(src).toContain("assertReadOnlyBrokerRequest(url, 'GET')");
    expect(src).not.toMatch(/method:\s*['"`](POST|PUT|PATCH|DELETE)/i);
    expect(src).not.toMatch(/\bbody:/);
    expect((src.match(/method:\s*'GET'/g) ?? []).length).toBe((src.match(/\bf\(url/g) ?? []).length);
  });
  it('the rb-broker endpoint has no outbound HTTP of its own', () => {
    const fn = readFileSync(join(__dirname, '..', 'functions', 'rb-broker.mts'), 'utf8');
    expect(fn).not.toMatch(/\bfetch\(/);
    expect(fn).not.toMatch(/alpaca\.markets/);
  });
});

describe('rb-broker endpoint', () => {
  const client: BrokerReadClient = {
    host: 'paper-api.alpaca.markets',
    listOrders: async () => [{ id: 'o1', symbol: 'GM', side: 'buy', status: 'filled', filled_qty: '10', account_id: 'SECRET-ACCOUNT', legs: [{ id: 'l1', symbol: 'GM', side: 'sell', status: 'held', extra: 'x' }] }],
    listPositions: async () => [{ symbol: 'GM', qty: '10', avg_entry_price: '85.5', account_number: 'PA123' }],
  };
  const req = (method = 'GET', auth = 'Bearer tok', q = '?date=2026-10-30') => new Request(`https://x/.netlify/functions/rb-broker${q}`, { method, headers: { authorization: auth } });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s → 405', async (m) => expect((await handleBroker(req(m), client, 'tok')).status).toBe(405));
  it('401 without the app token; 503 when disabled; 400 without a date', async () => {
    expect((await handleBroker(req('GET', 'Bearer nope'), client, 'tok')).status).toBe(401);
    expect((await handleBroker(req(), null, 'tok')).status).toBe(503);
    expect((await handleBroker(req('GET', 'Bearer tok', ''), client, 'tok')).status).toBe(400);
  });
  it('200 with sanitized orders (legs kept) and positions; account identifiers dropped', async () => {
    const res = await handleBroker(req(), client, 'tok');
    const j = await res.json();
    expect(j).toMatchObject({ account: 'PAPER', readOnly: true, orders: [{ id: 'o1', symbol: 'GM', legs: [{ id: 'l1' }] }], positions: [{ symbol: 'GM', qty: '10' }] });
    expect(JSON.stringify(j)).not.toMatch(/SECRET-ACCOUNT|PA123|extra/);
    expect(sanitizeOrder(null)).toEqual({ legs: [] });
  });
});
