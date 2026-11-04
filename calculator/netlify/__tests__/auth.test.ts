/**
 * CR-16 — username/password authentication (isolated feature). In-memory session store; no Netlify runtime.
 * Covers: flag OFF = legacy, misconfiguration fails closed, invalid login, throttling, valid login + cookie attributes,
 * protected endpoints refuse without a session, logout, expired sessions, credential rotation, CSRF guards, the
 * TrendSpider webhook staying open to its own secret, and no auth secret reaching the browser bundle.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import authFn from '../functions/rb-auth.mts';
import healthFn from '../functions/rb-health.mts';
import alertsFn from '../functions/rb-alerts.mts';
import brokerFn from '../functions/rb-broker.mts';
import quotesFn from '../functions/rb-quotes.mts';
import parityFn from '../functions/rb-historical-parity.mts';
import {
  authEnabled, hashPassword, MemorySessionStore, parsePasswordHash, readSession, authConfig, requireSession,
  SESSION_COOKIE, SESSION_TTL_MS, setSessionStoreForTests, verifyPassword, type SessionStore,
} from '../lib/session';

const USER = 'rbtester';
const PASS = 'synthetic-pass-123';
let HASH = '';
const BASE = 'https://site.test/.netlify/functions/';

beforeAll(async () => {
  HASH = await hashPassword(PASS);
});

let store: MemorySessionStore;
let ipSeq = 0;
let ip = '';
beforeEach(() => {
  store = new MemorySessionStore();
  setSessionStoreForTests(store);
  ip = `203.0.113.${++ipSeq}`;
  vi.stubEnv('RB_APP_ACCESS_TOKEN', 'apptok');
});
afterEach(() => {
  setSessionStoreForTests(null);
  vi.unstubAllEnvs();
});

const enable = (o: { user?: string; hash?: string } = {}) => {
  vi.stubEnv('RB_AUTH_ENABLED', 'true');
  vi.stubEnv('RB_AUTH_USERNAME', o.user ?? USER);
  vi.stubEnv('RB_AUTH_PASSWORD_HASH', o.hash ?? HASH);
};
const req = (fn: string, init: RequestInit & { cookie?: string; bearer?: boolean } = {}) => {
  const h = new Headers(init.headers);
  h.set('x-nf-client-connection-ip', ip);
  if (init.cookie) h.set('cookie', init.cookie);
  if (init.bearer) h.set('authorization', 'Bearer apptok');
  return new Request(BASE + fn, { ...init, headers: h });
};
const post = (body: unknown, extra: Record<string, string> = {}, cookie?: string) =>
  authFn(req('rb-auth', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...extra }, cookie }));
const loginOk = async () => {
  const res = await post({ action: 'login', username: USER, password: PASS });
  expect(res.status).toBe(200);
  const set = res.headers.get('set-cookie') ?? '';
  const sid = new RegExp(`^${SESSION_COOKIE}=([^;]+)`).exec(set)?.[1];
  expect(sid).toBeTruthy();
  return { res, set, cookie: `${SESSION_COOKIE}=${sid}`, sid: sid! };
};
const sessionKeys = () => [...store.data.keys()].filter((k) => k.startsWith('session/'));

/** A store that fails the test if touched (flag OFF must not reach it). */
const forbidden: SessionStore = {
  get: async () => { throw new Error('store touched'); },
  set: async () => { throw new Error('store touched'); },
  delete: async () => { throw new Error('store touched'); },
};

describe('password hashing', () => {
  it('scrypt hash verifies only the right password; the password never appears in the hash', async () => {
    expect(HASH).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(HASH).not.toContain(PASS);
    expect(await verifyPassword(PASS, HASH)).toBe(true);
    expect(await verifyPassword(PASS + 'x', HASH)).toBe(false);
    expect(await verifyPassword('', HASH)).toBe(false);
    expect(await verifyPassword(undefined, HASH)).toBe(false);
    expect(await verifyPassword(PASS, undefined)).toBe(false);
    expect(await hashPassword(PASS)).not.toBe(HASH); // random salt
  });
  it('malformed or weak-parameter hashes are rejected', () => {
    expect(parsePasswordHash('plaintext')).toBeNull();
    expect(parsePasswordHash(HASH.replace('scrypt$16384', 'scrypt$1024'))).toBeNull();
    expect(parsePasswordHash(HASH.replace('scrypt$16384', 'scrypt$20000'))).toBeNull();
    expect(parsePasswordHash('scrypt$16384$8$1$AA==$AA==')).toBeNull();
    expect(parsePasswordHash(HASH)).not.toBeNull();
  });
});

describe('RB_AUTH_ENABLED flag (server-controlled)', () => {
  it.each([[undefined, false], ['', false], ['false', false], ['FALSE', false], ['0', false], ['off', false], ['true', true], ['TRUE', true], ['yes', true], ['ture', true]])(
    '%s → %s (mistyped values fail closed)', (v, on) => {
      if (v !== undefined) vi.stubEnv('RB_AUTH_ENABLED', v);
      expect(authEnabled()).toBe(on);
    });
});

describe('flag OFF — legacy behaviour preserved', () => {
  it('rb-auth reports disabled; the guard is a no-op and never touches the session store', async () => {
    setSessionStoreForTests(forbidden);
    expect(await (await authFn(req('rb-auth'))).json()).toEqual({ enabled: false });
    expect(await requireSession(req('rb-health'))).toBeNull();
    const h = await healthFn(req('rb-health', { bearer: true }));
    expect(h.status).toBe(200);
    expect((await healthFn(req('rb-health'))).status).toBe(401); // the existing token check is unchanged
    expect(await (await healthFn(req('rb-health'))).json()).toEqual({ error: 'Unauthorized' });
  });
  it('login is refused when auth is not enabled (no session created)', async () => {
    expect((await post({ action: 'login', username: USER, password: PASS })).status).toBe(409);
    expect(store.data.size).toBe(0);
  });
});

describe('flag ON but misconfigured — fails closed', () => {
  it.each([
    ['no username', { user: '' }],
    ['no hash', { hash: '' }],
    ['plaintext instead of a hash', { hash: PASS }],
  ])('%s: status says not configured, login 503, every protected endpoint 401', async (_n, o) => {
    enable(o);
    expect(await (await authFn(req('rb-auth'))).json()).toMatchObject({ enabled: true, configured: false, authenticated: false });
    expect((await post({ action: 'login', username: USER, password: PASS })).status).toBe(503);
    for (const r of [await healthFn(req('rb-health', { bearer: true })), await alertsFn(req('rb-alerts?date=2026-11-03', { bearer: true })), await brokerFn(req('rb-broker?date=2026-11-03', { bearer: true }))]) {
      expect(r.status).toBe(401);
      expect((await r.json()).auth).toBe('session');
    }
  });
});

describe('login', () => {
  beforeEach(() => enable());
  it('invalid username or password → 401 with one generic message and no session', async () => {
    for (const body of [{ username: USER, password: 'wrong-pass' }, { username: 'someone', password: PASS }, { username: USER }, {}]) {
      const r = await post({ action: 'login', ...body });
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: 'Invalid username or password' });
      expect(r.headers.get('set-cookie')).toBeNull();
    }
    expect(sessionKeys()).toEqual([]);
  });
  it('throttled after 5 failures from one client, even with the right password; other clients unaffected', async () => {
    for (let i = 0; i < 5; i++) expect((await post({ action: 'login', username: USER, password: 'wrong-pass' })).status).toBe(401);
    expect((await post({ action: 'login', username: USER, password: PASS })).status).toBe(429);
    ip = '198.51.100.7';
    await loginOk();
  });
  it('valid login → HttpOnly, Secure, SameSite=Strict __Host- cookie (12 h); no secret or session id in the body; server keeps only a hash', async () => {
    const { res, set, sid } = await loginOk();
    expect(set).toMatch(/^__Host-rb_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200$/);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ ok: true, user: USER });
    for (const s of [sid, PASS, HASH]) expect(text).not.toContain(s);
    expect(sessionKeys()).toHaveLength(1);
    expect(sessionKeys()[0]).not.toContain(sid);
    expect([...store.data.values()].join()).not.toContain(sid);
  });
  it('cross-origin or non-JSON sign-in is refused', async () => {
    expect((await post({ action: 'login', username: USER, password: PASS }, { origin: 'https://evil.example' })).status).toBe(403);
    const form = await authFn(req('rb-auth', { method: 'POST', body: 'username=a&password=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } }));
    expect(form.status).toBe(415);
    expect((await authFn(req('rb-auth', { method: 'PUT' }))).status).toBe(405);
    expect(sessionKeys()).toEqual([]);
  });
});

describe('protected endpoints with auth ON', () => {
  beforeEach(() => enable());
  const endpoints: [string, () => Promise<Response>, (cookie: string) => Promise<Response>][] = [
    ['rb-health', () => healthFn(req('rb-health', { bearer: true })), (c) => healthFn(req('rb-health', { cookie: c }))],
    ['rb-alerts', () => alertsFn(req('rb-alerts?date=2026-11-03', { bearer: true })), (c) => alertsFn(req('rb-alerts?date=2026-11-03', { cookie: c }))],
    ['rb-broker', () => brokerFn(req('rb-broker?date=2026-11-03', { bearer: true })), (c) => brokerFn(req('rb-broker?date=2026-11-03', { cookie: c }))],
    ['rb-quotes', () => quotesFn(req('rb-quotes?symbols=GM', { bearer: true })), (c) => quotesFn(req('rb-quotes?symbols=GM', { cookie: c }))],
    ['rb-historical-parity', () => parityFn(req('rb-historical-parity', { method: 'POST', body: '{}', bearer: true })), (c) => parityFn(req('rb-historical-parity', { method: 'POST', body: '{}', cookie: c }))],
  ];
  it.each(endpoints)('%s: bearer token alone → 401 (session required); session without token → the existing 401', async (_n, withTokenOnly, withSessionOnly) => {
    const r = await withTokenOnly();
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ auth: 'session' });
    const { cookie } = await loginOk();
    const s = await withSessionOnly(cookie);
    expect(s.status).toBe(401);
    expect((await s.json()).auth).toBeUndefined(); // passed the session guard; refused by the unchanged token check
  });
  it('session + token → rb-health 200; a forged or malformed cookie → 401', async () => {
    const { cookie } = await loginOk();
    expect((await healthFn(req('rb-health', { cookie, bearer: true }))).status).toBe(200);
    expect((await healthFn(req('rb-health', { cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}`, bearer: true }))).status).toBe(401);
    expect((await healthFn(req('rb-health', { cookie: `${SESSION_COOKIE}=../../x`, bearer: true }))).status).toBe(401);
    expect((await healthFn(req('rb-health', { cookie: `other=1`, bearer: true }))).status).toBe(401);
  });
  it('rb-broker stays GET-only (mutations never reach the broker client)', async () => {
    const { cookie } = await loginOk();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await brokerFn(req('rb-broker?date=2026-11-03', { method, body: '{}', cookie, bearer: true }))).status).toBe(405);
    }
  });
  it('a session store outage refuses access (never bypasses)', async () => {
    const { cookie } = await loginOk();
    setSessionStoreForTests(forbidden);
    const r = await healthFn(req('rb-health', { cookie, bearer: true }));
    expect(r.status).toBe(401);
    expect((await authFn(req('rb-auth', { cookie }))).status).toBe(503);
  });
});

describe('session lifecycle', () => {
  beforeEach(() => enable());
  it('status reports the signed-in user; logout deletes the server session and clears the cookie; the old cookie is dead', async () => {
    const { cookie } = await loginOk();
    expect(await (await authFn(req('rb-auth', { cookie }))).json()).toMatchObject({ enabled: true, configured: true, authenticated: true, user: USER });
    const out = await post({ action: 'logout' }, {}, cookie);
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toBe(`${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    expect(sessionKeys()).toEqual([]);
    expect(await (await authFn(req('rb-auth', { cookie }))).json()).toMatchObject({ authenticated: false });
    expect((await healthFn(req('rb-health', { cookie, bearer: true }))).status).toBe(401);
  });
  it('an expired session is refused and removed', async () => {
    const { cookie } = await loginOk();
    const cfg = authConfig()!;
    const r = req('rb-health', { cookie });
    expect(await readSession(r, cfg, Date.now() + SESSION_TTL_MS - 1000)).not.toBeNull();
    expect(await readSession(r, cfg, Date.now() + SESSION_TTL_MS + 1)).toBeNull();
    expect(sessionKeys()).toEqual([]);
    expect((await healthFn(req('rb-health', { cookie, bearer: true }))).status).toBe(401);
  });
  it('rotating the password hash or the user name invalidates every existing session', async () => {
    const { cookie } = await loginOk();
    enable({ hash: await hashPassword('another-synthetic-pass') });
    expect((await healthFn(req('rb-health', { cookie, bearer: true }))).status).toBe(401);
    enable({ user: 'renamed' });
    expect((await healthFn(req('rb-health', { cookie, bearer: true }))).status).toBe(401);
    enable();
    expect((await healthFn(req('rb-health', { cookie, bearer: true }))).status).toBe(200);
  });
  it('turning the flag OFF (emergency rollback) restores legacy access without any session', async () => {
    const { cookie } = await loginOk();
    vi.stubEnv('RB_AUTH_ENABLED', 'false');
    expect((await healthFn(req('rb-health', { bearer: true }))).status).toBe(200);
    expect((await healthFn(req('rb-health', { cookie, bearer: true }))).status).toBe(200);
  });
});

describe('TrendSpider webhook is not behind the session guard', () => {
  beforeEach(() => {
    vi.resetModules();
    enable();
    vi.stubEnv('TRENDSPIDER_WEBHOOK_SECRET', 'whsec');
    vi.stubEnv('ALPACA_API_KEY', 'AKTEST');
    vi.stubEnv('ALPACA_SECRET_KEY', 'SKTEST');
  });
  it('with auth ON a webhook without a session is judged only by its own secret', async () => {
    const { MemoryStore } = await import('../lib/store');
    vi.doMock('../lib/store', async (orig) => ({ ...(await orig<typeof import('../lib/store')>()), blobStore: async () => new MemoryStore() }));
    const hook = (await import('../functions/trendspider-alert.mts')).default;
    const call = (b: unknown) => hook(new Request(BASE + 'trendspider-alert', { method: 'POST', body: JSON.stringify(b) }));
    const wrong = await call({ strategy: 'RB_V1', symbol: 'GM', direction: 'LONG', alert_name: 'x', alert_time: new Date().toISOString(), token: 'wrong' });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).auth).toBeUndefined();
    const ok = await call({ strategy: 'RB_V1', symbol: 'GM', direction: 'LONG', alert_name: 'RB v1 LONG Setup', alert_time: new Date().toISOString(), token: 'whsec', test: true });
    expect(ok.status).toBe(200);
    vi.doUnmock('../lib/store');
  });
  it('the webhook source does not import the session guard', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../functions/trendspider-alert.mts'), 'utf8');
    expect(src).not.toMatch(/session/i);
  });
});

describe('no authentication secret reaches the browser', () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : []);
  it('frontend auth code never names the server-side auth settings', () => {
    for (const f of walk(join(ROOT, 'src/auth')).filter((f) => !f.includes('__tests__'))) {
      const s = readFileSync(f, 'utf8');
      for (const n of ['RB_AUTH_PASSWORD_HASH', 'RB_AUTH_USERNAME', 'scrypt', 'localStorage']) expect(s.includes(n), `${f} mentions ${n}`).toBe(false);
    }
  });
  it('the production bundle (if built) contains no auth setting names or hashes', () => {
    for (const f of walk(join(ROOT, 'dist')).filter((f) => /\.(js|html|css|map)$/.test(f))) {
      const s = readFileSync(f, 'utf8');
      for (const n of ['RB_AUTH_PASSWORD_HASH', 'RB_AUTH_USERNAME', 'scrypt$']) expect(s.includes(n), `${f} contains ${n}`).toBe(false);
    }
  });
});
