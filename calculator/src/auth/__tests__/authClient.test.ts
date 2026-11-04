/** CR-16 — browser sign-in state: fails closed on anything that is not a well-formed server answer. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAuthStatus, interpretStatus, login, logout, nextState, type AuthState } from '../authClient';

describe('interpretStatus', () => {
  it('maps well-formed server answers', () => {
    expect(interpretStatus(200, { enabled: false })).toEqual({ kind: 'disabled' });
    expect(interpretStatus(200, { enabled: true, configured: false, authenticated: false })).toEqual({ kind: 'misconfigured' });
    expect(interpretStatus(200, { enabled: true, configured: true, authenticated: false })).toEqual({ kind: 'login' });
    expect(interpretStatus(200, { enabled: true, configured: true, authenticated: true, user: 'u', expiresAt: '2026-11-04T12:00:00.000Z' }))
      .toEqual({ kind: 'authenticated', user: 'u', expiresAt: '2026-11-04T12:00:00.000Z' });
  });
  it('anything else is unreachable — the app is never shown on an unknown answer', () => {
    for (const [s, b] of [[500, { enabled: false }], [404, null], [200, null], [200, 'index.html'], [200, {}], [200, { enabled: 'false' }], [503, { enabled: true }]] as const) {
      expect(interpretStatus(s, b).kind).toBe('unreachable');
    }
    expect(interpretStatus(200, { enabled: true, configured: true, authenticated: true })).toEqual({ kind: 'login' }); // no user → not signed in
  });
});

describe('nextState (periodic re-check)', () => {
  const authed: AuthState = { kind: 'authenticated', user: 'u', expiresAt: null };
  it('a network blip does not change a decided state; a definitive answer does', () => {
    expect(nextState(authed, { kind: 'unreachable', error: 'x' })).toBe(authed);
    expect(nextState({ kind: 'disabled' }, { kind: 'unreachable', error: 'x' })).toEqual({ kind: 'disabled' });
    expect(nextState(authed, { kind: 'login' })).toEqual({ kind: 'login' }); // expired / logged out elsewhere
    expect(nextState({ kind: 'checking' }, { kind: 'unreachable', error: 'x' }).kind).toBe('unreachable');
  });
});

describe('fetch wrappers (same-origin, no browser storage)', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('status / login / logout call rb-auth only and never touch storage', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      const body = init?.method === 'POST' ? JSON.parse(String(init.body)) : null;
      if (body?.action === 'login') return new Response(JSON.stringify(body.password === 'right' ? { ok: true } : { error: 'Invalid username or password' }), { status: body.password === 'right' ? 200 : 401 });
      if (body?.action === 'logout') return new Response('{"ok":true}', { status: 200 });
      return new Response('{"enabled":true,"configured":true,"authenticated":false}', { status: 200 });
    });
    expect(await fetchAuthStatus()).toEqual({ kind: 'login' });
    expect(await login('u', 'wrong')).toEqual({ ok: false, error: 'Invalid username or password' });
    expect(await login('u', 'right')).toEqual({ ok: true });
    expect(await logout()).toBe(true);
    expect(calls.every(([u, i]) => u === '/.netlify/functions/rb-auth' && i?.credentials === 'same-origin')).toBe(true);
    for (const fn of Object.values(storage)) expect(fn).not.toHaveBeenCalled();
  });
  it('a network failure is unreachable, not signed in', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
    expect(await fetchAuthStatus()).toEqual({ kind: 'unreachable', error: 'offline' });
    expect(await login('u', 'p')).toEqual({ ok: false, error: 'offline' });
    expect(await logout()).toBe(false);
  });
});
