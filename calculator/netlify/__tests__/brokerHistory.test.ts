/**
 * CR-15 rb-broker history mode (GET ?symbols=…&from=…): bounded, read-only, same auth / PAPER client as the day mode.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleBroker } from '../functions/rb-broker.mts';
import { assertReadOnlyBrokerRequest, createAlpacaBrokerRead, type BrokerReadClient } from '../lib/alpaca';

const etDate = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
const TODAY = etDate(Date.now());
const DAYS_AGO = (d: number) => etDate(Date.now() - d * 86_400_000);
const order = (o: Record<string, unknown> = {}) => ({ id: 'o1', symbol: 'FIS', side: 'buy', status: 'filled', filled_qty: '499', position_intent: 'buy_to_open', account_id: 'SECRET-ACCOUNT', legs: [{ id: 'l1', symbol: 'FIS', side: 'sell', status: 'filled', position_intent: 'sell_to_close', extra: 'x' }], ...o });
const client = (orders: unknown[] = [order()]) => {
  const calls: Record<string, unknown>[] = [];
  const c: BrokerReadClient = {
    host: 'paper-api.alpaca.markets',
    listOrders: async (o) => { calls.push(o as Record<string, unknown>); return orders; },
    listOpenOrders: async () => [],
    listPositions: async () => [{ symbol: 'MCD', qty: '75', account_number: 'PA123' }],
  };
  return { c, calls };
};
const req = (q: string, method = 'GET', auth = 'Bearer tok') => new Request(`https://x/.netlify/functions/rb-broker${q}`, { method, headers: { authorization: auth } });

describe('rb-broker history mode (CR-15)', () => {
  it('returns every order for the tickers since `from`, legs nested, sanitized (position_intent kept, account ids dropped)', async () => {
    const { c, calls } = client();
    const res = await handleBroker(req(`?symbols=fis,MCD&from=${DAYS_AGO(1)}`), c, 'tok');
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ account: 'PAPER', readOnly: true, mode: 'history', symbols: ['FIS', 'MCD'], from: DAYS_AGO(1), complete: true, orders: [{ id: 'o1', position_intent: 'buy_to_open', legs: [{ id: 'l1', position_intent: 'sell_to_close' }] }], positions: [{ symbol: 'MCD', qty: '75' }] });
    expect(JSON.stringify(j)).not.toMatch(/SECRET-ACCOUNT|PA123|extra/);
    expect(calls).toEqual([expect.objectContaining({ symbols: ['FIS', 'MCD'], limit: 500 })]);
  });
  it('(41) a full page is reported as possibly truncated (complete: false)', async () => {
    const { c } = client(Array.from({ length: 500 }, (_, i) => order({ id: `o${i}` })));
    expect((await (await handleBroker(req(`?symbols=FIS&from=${TODAY}`), c, 'tok')).json()).complete).toBe(false);
  });
  it('bounded: 1–20 valid tickers and `from` within the last 31 days', async () => {
    const { c } = client();
    for (const q of ['?symbols=&from=' + TODAY, `?symbols=${Array.from({ length: 21 }, (_, i) => `T${i}`).join(',')}&from=${TODAY}`, `?symbols=FIS;DROP&from=${TODAY}`, '?symbols=FIS', `?symbols=FIS&from=${DAYS_AGO(40)}`, '?symbols=FIS&from=2099-01-01']) {
      expect((await handleBroker(req(q), c, 'tok')).status).toBe(400);
    }
  });
  it('(46) GET only, authenticated, and off when broker sync is disabled', async () => {
    const { c } = client();
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect((await handleBroker(req(`?symbols=FIS&from=${TODAY}`, m), c, 'tok')).status).toBe(405);
    expect((await handleBroker(req(`?symbols=FIS&from=${TODAY}`, 'GET', 'Bearer nope'), c, 'tok')).status).toBe(401);
    expect((await handleBroker(req(`?symbols=FIS&from=${TODAY}`), null, 'tok')).status).toBe(503);
  });
  it('(42) a broker failure (incl. a rate limit) is an error, never a partial answer', async () => {
    const c: BrokerReadClient = { ...client().c, listOrders: async () => { throw new Error('Alpaca broker 429: too many requests'); } };
    expect((await handleBroker(req(`?symbols=FIS&from=${TODAY}`), c, 'tok')).status).toBe(502);
  });
  it('(50) logs carry counts only — never the token, keys or account identifiers', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await handleBroker(req(`?symbols=FIS&from=${TODAY}`, 'GET', 'Bearer tok-secret-value'), client().c, 'tok-secret-value');
    expect(res.status).toBe(200);
    const text = spy.mock.calls.flat().join(' ');
    spy.mockRestore();
    expect(text).toMatch(/broker_history_read/);
    expect(text).not.toMatch(/tok-secret-value|SECRET-ACCOUNT|PA123|APCA/);
  });
  it('(45) the symbols query is a GET to the PAPER list endpoint through the read-only guard', async () => {
    const fetchImpl = vi.fn(async () => new Response('[]', { status: 200 }));
    const c = createAlpacaBrokerRead({ keyId: 'k', secretKey: 's', fetchImpl: fetchImpl as never });
    await c.listOrders({ afterIso: '2026-11-02T09:00:00.000Z', symbols: ['FIS', 'MCD'] });
    const [url, init] = (fetchImpl.mock.calls as unknown as [string, RequestInit][])[0];
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(new URL(url).host).toBe('paper-api.alpaca.markets');
    expect(new URL(url).searchParams.get('symbols')).toBe('FIS,MCD');
    expect(() => assertReadOnlyBrokerRequest(url, 'GET')).not.toThrow();
    expect(() => assertReadOnlyBrokerRequest(url.replace('paper-api', 'api'), 'GET')).toThrow(/paper/);
  });
});
