/**
 * CR-16 Logout UI — visibility (header button only when signed in), successful logout, failed / unconfirmed logout
 * (never claims a revocation the server did not confirm), and browser data preservation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performLogout, type AuthState } from '../authClient';
import { AuthSessionContext, LogoutButton, type AuthSession } from '../LogoutButton';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const session = (o: Partial<AuthSession> = {}): AuthSession => ({ user: 'rbtester', signingOut: false, error: null, logout: () => {}, ...o });
const render = (value: AuthSession | null) => renderToStaticMarkup(createElement(AuthSessionContext.Provider, { value }, createElement(LogoutButton)));

describe('Log out button visibility', () => {
  it('signed in → a visible "Log out" button and the user name', () => {
    const html = render(session());
    expect(html).toContain('>Log out</button>');
    expect(html).toContain('rbtester');
    expect(html).not.toContain('disabled=""');
  });
  it('auth disabled / not signed in (no session provided) → nothing rendered', () => {
    expect(render(null)).toBe('');
    expect(renderToStaticMarkup(createElement(LogoutButton))).toBe('');
  });
  it('while signing out the button is disabled; a failure message is shown next to it', () => {
    expect(render(session({ signingOut: true }))).toMatch(/<button[^>]*disabled=""[^>]*>Signing out…<\/button>/);
    expect(render(session({ error: 'Log out failed (offline). You are still signed in — try again.' }))).toContain('role="alert"');
  });
  it('is placed in the application header next to the PAPER TRADING MODE / AUTOMATED ALERTS badges (every tab)', () => {
    const app = readFileSync(resolve(SRC, 'App.tsx'), 'utf8');
    const header = app.slice(app.indexOf('<header'), app.indexOf('</header>'));
    expect(header).toMatch(/Paper trading mode[\s\S]*Automated alerts[\s\S]*<LogoutButton \/>/);
    expect(app.match(/<LogoutButton \/>/g)).toHaveLength(1);
    const gate = readFileSync(resolve(SRC, 'auth/AuthGate.tsx'), 'utf8');
    expect(gate).not.toMatch(/fixed bottom-/); // the hard-to-find floating pill is gone
  });
});

describe('performLogout', () => {
  afterEach(() => vi.unstubAllGlobals());
  const login: AuthState = { kind: 'login' };
  const authed: AuthState = { kind: 'authenticated', user: 'rbtester', expiresAt: null };
  const stub = (respond: () => Response | Promise<Response>) => {
    const calls: [string, RequestInit | undefined][] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => { calls.push([url, init]); return respond(); });
    return calls;
  };

  it('success: server confirmed + status no longer signed in → signed-out (back to the login screen)', async () => {
    const calls = stub(() => new Response('{"ok":true}', { status: 200 }));
    expect(await performLogout(async () => login)).toEqual({ kind: 'signed-out', state: login });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/.netlify/functions/rb-auth');
    expect(calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{"action":"logout"}' });
  });
  it('network failure and still signed in → failed, stays in the app, says so', async () => {
    stub(() => { throw new Error('offline'); });
    const r = await performLogout(async () => authed);
    expect(r.kind).toBe('failed');
    expect(r.kind === 'failed' && r.message).toMatch(/offline.*still signed in/);
  });
  it('server error but the cookie was cleared → unconfirmed: signed out locally, revocation NOT claimed', async () => {
    stub(() => new Response('{"ok":false,"error":"Session store unavailable"}', { status: 503 }));
    const r = await performLogout(async () => login);
    expect(r.kind).toBe('unconfirmed');
    expect(r.kind === 'unconfirmed' && r.message).toMatch(/could not confirm the session was revoked \(Session store unavailable\)/);
  });
  it('server says ok but the session is still active → failed (never reports success)', async () => {
    stub(() => new Response('{"ok":true}', { status: 200 }));
    expect((await performLogout(async () => authed)).kind).toBe('failed');
  });
  it('status unreachable after logout → failed (unknown is not reported as signed out)', async () => {
    stub(() => new Response('{"ok":true}', { status: 200 }));
    expect((await performLogout(async () => ({ kind: 'unreachable', error: 'HTTP 502' }))).kind).toBe('failed');
  });
  it('a non-JSON 200 (not the auth function) is not a confirmed logout', async () => {
    stub(() => new Response('<html></html>', { status: 200 }));
    expect((await performLogout(async () => login)).kind).toBe('unconfirmed');
  });
});

describe('logging out preserves browser data', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('every outcome leaves storage untouched (no read, write, remove or clear)', async () => {
    const data: Record<string, string> = {
      'rbv1.journal.v1': '[{"ticker":"FIS","notes":"keep"}]',
      'rbv1.journal.backup.pre-cr15.v1': '{"journalJson":"[]"}',
      'rbv1.settings.v1': '{"x":1}',
      'rbv1.ranker.candidates.v1': '[{"id":"c1","status":"FILLED"}]',
      'rbv1.v12.alertSnapshots.v1': '{"a":{"frozen":true}}',
    };
    const before = JSON.stringify(data);
    const storage = { getItem: vi.fn((k: string) => data[k] ?? null), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(), key: vi.fn(), length: 5 };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    for (const [respond, status] of [
      [() => new Response('{"ok":true}', { status: 200 }), { kind: 'login' } as AuthState],
      [() => { throw new Error('offline'); }, { kind: 'authenticated', user: 'u', expiresAt: null } as AuthState],
      [() => new Response('{"ok":false}', { status: 503 }), { kind: 'login' } as AuthState],
    ] as const) {
      vi.stubGlobal('fetch', async () => respond());
      await performLogout(async () => status);
    }
    for (const fn of [storage.getItem, storage.setItem, storage.removeItem, storage.clear, storage.key]) expect(fn).not.toHaveBeenCalled();
    expect(JSON.stringify(data)).toBe(before);
  });
  it('no auth source file references browser storage APIs', () => {
    for (const f of ['auth/authClient.ts', 'auth/AuthGate.tsx', 'auth/LoginScreen.tsx', 'auth/LogoutButton.tsx']) {
      expect(readFileSync(resolve(SRC, f), 'utf8'), f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    }
  });
});
