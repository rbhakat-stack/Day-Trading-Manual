/**
 * CR-16 — browser side of the isolated authentication feature. The browser never sees a password hash or a session id
 * (the session cookie is HttpOnly); it only asks the server whether this browser is signed in. Nothing here reads or
 * writes browser storage, so trading data is never touched by sign-in or sign-out.
 */
export type AuthState =
  | { kind: 'checking' }
  | { kind: 'disabled' } // RB_AUTH_ENABLED off on the server → legacy behaviour
  | { kind: 'authenticated'; user: string; expiresAt: string | null }
  | { kind: 'login' }
  | { kind: 'misconfigured' } // enabled on the server but no valid credentials configured → access refused
  | { kind: 'unreachable'; error: string }; // cannot verify → access refused (never assumed open)

const AUTH_URL = '/.netlify/functions/rb-auth';

/** Pure interpretation of GET rb-auth. Anything that is not a well-formed answer fails closed. */
export function interpretStatus(status: number, body: unknown): AuthState {
  if (status !== 200 || !body || typeof body !== 'object') return { kind: 'unreachable', error: `Sign-in status unavailable (HTTP ${status})` };
  const b = body as Record<string, unknown>;
  if (b.enabled === false) return { kind: 'disabled' };
  if (b.enabled !== true) return { kind: 'unreachable', error: 'Unrecognised sign-in status' };
  if (b.configured === false) return { kind: 'misconfigured' };
  if (b.authenticated === true && typeof b.user === 'string') return { kind: 'authenticated', user: b.user, expiresAt: typeof b.expiresAt === 'string' ? b.expiresAt : null };
  return { kind: 'login' };
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchAuthStatus(): Promise<AuthState> {
  try {
    const res = await fetch(AUTH_URL, { method: 'GET', cache: 'no-store', credentials: 'same-origin' });
    return interpretStatus(res.status, await readJson(res));
  } catch (e) {
    return { kind: 'unreachable', error: (e as Error).message || 'Network error' };
  }
}

export async function login(username: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(AUTH_URL, {
      method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'login', username, password }),
    });
    if (res.ok) return { ok: true };
    const b = (await readJson(res)) as { error?: unknown } | null;
    return { ok: false, error: typeof b?.error === 'string' ? b.error : `Sign-in failed (HTTP ${res.status})` };
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'Network error' };
  }
}

/** Ends the server session and clears the cookie. Never touches browser storage. */
export async function logout(): Promise<boolean> {
  try {
    const res = await fetch(AUTH_URL, {
      method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'logout' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Re-check result handling: only a definitive server answer changes an already-decided state (a network blip does not). */
export function nextState(current: AuthState, fresh: AuthState): AuthState {
  if (fresh.kind === 'unreachable' && current.kind !== 'checking' && current.kind !== 'unreachable') return current;
  return fresh;
}
