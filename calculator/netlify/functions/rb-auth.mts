/**
 * CR-16 — /.netlify/functions/rb-auth (isolated authentication endpoint).
 *
 *   GET                                      → { enabled, configured?, authenticated?, user?, expiresAt? }
 *   POST {"action":"login","username","password"} → 200 + session cookie | 401 invalid | 429 throttled | 503 misconfigured
 *   POST {"action":"logout"}                 → 200, server session deleted, cookie cleared (no browser data touched)
 *
 * No secret, hash or session id is ever logged or returned in a body. POSTs must be same-origin JSON.
 */
import { clientIp, RateLimiter, safeEqual } from '../lib/auth';
import {
  authConfig, authEnabled, clearedSessionCookie, clearLoginFailures, createSession, destroySession, loginBlocked,
  readSession, recordLoginFailure, sessionCookie, SESSION_TTL_MS, verifyPassword,
} from '../lib/session';

const limiter = new RateLimiter(20, 60_000);
const MAX_BODY = 4096;

const reply = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true; // same-origin fetches from some browsers omit it; SameSite=Strict + JSON-only still apply
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

export default async (req: Request): Promise<Response> => {
  if (req.method === 'GET') {
    if (!authEnabled()) return reply(200, { enabled: false });
    const cfg = authConfig();
    if (!cfg) return reply(200, { enabled: true, configured: false, authenticated: false });
    try {
      const s = await readSession(req, cfg);
      return s
        ? reply(200, { enabled: true, configured: true, authenticated: true, user: s.user, expiresAt: new Date(s.expiresMs).toISOString() })
        : reply(200, { enabled: true, configured: true, authenticated: false });
    } catch {
      return reply(503, { enabled: true, configured: true, authenticated: false, error: 'Session store unavailable' });
    }
  }
  if (req.method !== 'POST') return reply(405, { error: 'GET or POST only' }, { allow: 'GET, POST' });
  if (!sameOrigin(req)) return reply(403, { error: 'Cross-origin request refused' });
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return reply(415, { error: 'JSON required' });
  const ip = clientIp(req);
  if (!limiter.allow(ip)) return reply(429, { error: 'Too many requests' });

  const text = await req.text();
  if (text.length > MAX_BODY) return reply(413, { error: 'Request too large' });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return reply(400, { error: 'Invalid JSON' });
  }

  if (body?.action === 'logout') {
    try {
      await destroySession(req);
    } catch {
      // The cookie is still cleared below; the server record then expires on its own (absolute 12 h).
      return reply(503, { ok: false, error: 'Session store unavailable — cookie cleared, server session expires on its own' }, { 'set-cookie': clearedSessionCookie() });
    }
    return reply(200, { ok: true }, { 'set-cookie': clearedSessionCookie() });
  }

  if (body?.action !== 'login') return reply(400, { error: 'Unknown action' });
  if (!authEnabled()) return reply(409, { error: 'Authentication is not enabled', enabled: false });
  const cfg = authConfig();
  if (!cfg) return reply(503, { error: 'Authentication is enabled but not configured — sign-in refused' });

  try {
    if (await loginBlocked(ip)) return reply(429, { error: 'Too many failed sign-in attempts — try again later' });
    const userOk = safeEqual(body.username, cfg.username);
    const passOk = await verifyPassword(body.password, cfg.passwordHash); // always evaluated (no user-name timing oracle)
    if (!userOk || !passOk) {
      await recordLoginFailure(ip);
      console.warn(JSON.stringify({ event: 'auth.login.failed', ip }));
      return reply(401, { error: 'Invalid username or password' });
    }
    await clearLoginFailures(ip);
    const { sid, record } = await createSession(cfg.username, cfg);
    console.info(JSON.stringify({ event: 'auth.login.ok', ip }));
    return reply(200, { ok: true, user: record.user, expiresAt: new Date(record.expiresMs).toISOString() }, { 'set-cookie': sessionCookie(sid, Math.floor(SESSION_TTL_MS / 1000)) });
  } catch {
    return reply(503, { error: 'Session store unavailable — sign-in refused' });
  }
};
