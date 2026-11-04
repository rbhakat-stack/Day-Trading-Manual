/**
 * CR-16 — username/password authentication with server-verified sessions (server only; isolated feature).
 *
 * Configuration (Netlify environment variables, never bundled into the React app):
 *   RB_AUTH_ENABLED        "true" → authentication is mandatory for the app and its protected endpoints.
 *                          Unset / "false" / "0" / "off" → inactive (legacy behaviour). Any other value counts as ON
 *                          (a mistyped security flag fails closed).
 *   RB_AUTH_USERNAME       the single user name.
 *   RB_AUTH_PASSWORD_HASH  scrypt hash produced by `node scripts/hash-password.mjs` — the password itself is never stored.
 *
 * When enabled but the username or hash is missing / malformed, every login and every protected request is refused
 * (503 / 401): authentication is never silently bypassed.
 *
 * Sessions: a random 256-bit id in an HttpOnly, Secure, SameSite=Strict, __Host- cookie. The server keeps only
 * sha256(id) → { user, created, expires, credential fingerprint } in Netlify Blobs (strong consistency). Logout deletes
 * the record (and clears the cookie); expiry is absolute (12 h); rotating the password hash or user name invalidates
 * every session. Nothing is written to the browser's localStorage.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { safeEqual } from './auth';

export const SESSION_COOKIE = '__Host-rb_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const LOGIN_FAIL_LIMIT = 5;
export const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;

const env = (k: string) => (typeof process !== 'undefined' ? process.env[k] : undefined) || undefined;

export function authEnabled(): boolean {
  const v = (env('RB_AUTH_ENABLED') ?? '').trim().toLowerCase();
  return !(v === '' || v === 'false' || v === '0' || v === 'off');
}

// ---------- password hashing (scrypt, node:crypto only — no new dependency) ----------

export interface ScryptParams { N: number; r: number; p: number }
const DEFAULT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };
const KEYLEN = 32;

function scrypt(password: string, salt: Buffer, keylen: number, { N, r, p }: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, { N, r, p, maxmem: 128 * N * r * 2 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Format: scrypt$N$r$p$<salt base64>$<hash base64>. */
export async function hashPassword(password: string, params: ScryptParams = DEFAULT_PARAMS): Promise<string> {
  if (!password) throw new Error('empty password');
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

interface ParsedHash { params: ScryptParams; salt: Buffer; key: Buffer }
export function parsePasswordHash(stored: string | undefined): ParsedHash | null {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec((stored ?? '').trim());
  if (!m) return null;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Bounded parameters: N a power of two 2^14..2^20, r 1..32, p 1..16.
  if (!(N >= 16384 && N <= 1048576 && (N & (N - 1)) === 0 && r >= 1 && r <= 32 && p >= 1 && p <= 16)) return null;
  const salt = Buffer.from(m[4], 'base64');
  const key = Buffer.from(m[5], 'base64');
  if (salt.length < 16 || key.length < 16) return null;
  return { params: { N, r, p }, salt, key };
}

export async function verifyPassword(password: unknown, stored: string | undefined): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (typeof password !== 'string' || !password || password.length > 1024 || !parsed) return false;
  const key = await scrypt(password, parsed.salt, parsed.key.length, parsed.params);
  return timingSafeEqual(key, parsed.key);
}

// ---------- configuration ----------

export interface AuthConfig { username: string; passwordHash: string; fingerprint: string }

/** null = enabled-but-misconfigured (the caller must refuse). */
export function authConfig(): AuthConfig | null {
  const username = env('RB_AUTH_USERNAME')?.trim();
  const passwordHash = env('RB_AUTH_PASSWORD_HASH')?.trim();
  if (!username || !passwordHash || !parsePasswordHash(passwordHash)) return null;
  const fingerprint = createHash('sha256').update(`${username}\n${passwordHash}`).digest('hex').slice(0, 32);
  return { username, passwordHash, fingerprint };
}

// ---------- session store ----------

export interface SessionRecord { user: string; createdMs: number; expiresMs: number; fp: string }
export interface SessionStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  data = new Map<string, string>();
  async get(k: string) { return this.data.get(k) ?? null; }
  async set(k: string, v: string) { this.data.set(k, v); }
  async delete(k: string) { this.data.delete(k); }
}

let override: SessionStore | null = null;
/** Tests only: inject an in-memory store (production uses Netlify Blobs). */
export function setSessionStoreForTests(s: SessionStore | null) { override = s; }

async function sessionStore(): Promise<SessionStore> {
  if (override) return override;
  const { getStore } = await import('@netlify/blobs');
  const s = getStore({ name: 'rb-auth-sessions', consistency: 'strong' });
  return {
    async get(k) { return ((await s.get(k, { type: 'text' })) as string | null) ?? null; },
    async set(k, v) { await s.set(k, v); },
    async delete(k) { await s.delete(k); },
  };
}

const sidKey = (sid: string) => `session/${createHash('sha256').update(sid).digest('hex')}`;
const failKey = (ip: string) => `loginfail/${createHash('sha256').update(ip).digest('hex')}`;

export function cookieFrom(req: Request, name = SESSION_COOKIE): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export const sessionCookie = (sid: string, maxAgeSec: number) =>
  `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
export const clearedSessionCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export async function createSession(user: string, cfg: AuthConfig, now = Date.now()): Promise<{ sid: string; record: SessionRecord }> {
  const sid = randomBytes(32).toString('base64url');
  const record: SessionRecord = { user, createdMs: now, expiresMs: now + SESSION_TTL_MS, fp: cfg.fingerprint };
  await (await sessionStore()).set(sidKey(sid), JSON.stringify(record));
  return { sid, record };
}

/** The valid session for this request, or null. Expired / revoked / credential-rotated sessions are refused. */
export async function readSession(req: Request, cfg: AuthConfig, now = Date.now()): Promise<SessionRecord | null> {
  const sid = cookieFrom(req);
  if (!sid || !/^[A-Za-z0-9_-]{43}$/.test(sid)) return null;
  const store = await sessionStore();
  const raw = await store.get(sidKey(sid));
  if (!raw) return null;
  let rec: SessionRecord;
  try {
    rec = JSON.parse(raw) as SessionRecord;
  } catch {
    return null;
  }
  if (!rec || typeof rec.expiresMs !== 'number' || now >= rec.expiresMs) {
    await store.delete(sidKey(sid)).catch(() => undefined);
    return null;
  }
  if (rec.fp !== cfg.fingerprint || !safeEqual(rec.user, cfg.username)) return null;
  return rec;
}

export async function destroySession(req: Request): Promise<void> {
  const sid = cookieFrom(req);
  if (sid && /^[A-Za-z0-9_-]{43}$/.test(sid)) await (await sessionStore()).delete(sidKey(sid));
}

// ---------- persistent login throttle (per client IP, across serverless instances) ----------

interface FailRecord { count: number; firstMs: number }
export async function loginBlocked(ip: string, now = Date.now()): Promise<boolean> {
  const raw = await (await sessionStore()).get(failKey(ip));
  if (!raw) return false;
  try {
    const r = JSON.parse(raw) as FailRecord;
    return now - r.firstMs < LOGIN_FAIL_WINDOW_MS && r.count >= LOGIN_FAIL_LIMIT;
  } catch {
    return false;
  }
}
export async function recordLoginFailure(ip: string, now = Date.now()): Promise<void> {
  const store = await sessionStore();
  let r: FailRecord = { count: 0, firstMs: now };
  try {
    const raw = await store.get(failKey(ip));
    if (raw) r = JSON.parse(raw) as FailRecord;
  } catch { /* start a new window */ }
  if (now - r.firstMs >= LOGIN_FAIL_WINDOW_MS) r = { count: 0, firstMs: now };
  r.count += 1;
  await store.set(failKey(ip), JSON.stringify(r));
}
export async function clearLoginFailures(ip: string): Promise<void> {
  await (await sessionStore()).delete(failKey(ip));
}

// ---------- guard for protected endpoints ----------

const deny = (status: number, error: string) =>
  new Response(JSON.stringify({ error, auth: 'session' }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/**
 * Protected endpoints call this first. Returns null to continue (auth disabled, or a valid session), otherwise the
 * refusal. With RB_AUTH_ENABLED off it does nothing at all (no store access) — legacy behaviour is preserved.
 * The endpoint's own RB_APP_ACCESS_TOKEN check still runs afterwards (both are required when auth is on).
 */
export async function requireSession(req: Request): Promise<Response | null> {
  if (!authEnabled()) return null;
  const cfg = authConfig();
  if (!cfg) return deny(401, 'Authentication is enabled but not configured — access refused');
  try {
    return (await readSession(req, cfg)) ? null : deny(401, 'Authentication required');
  } catch {
    return deny(401, 'Session could not be verified — access refused');
  }
}
