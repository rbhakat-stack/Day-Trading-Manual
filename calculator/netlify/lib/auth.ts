/**
 * Authentication helpers (server only). Secrets come from Netlify environment variables and are never logged,
 * stored, echoed or sent to the browser.
 *
 *  • Webhook: TRENDSPIDER_WEBHOOK_SECRET, supplied by TrendSpider as the "token" field of the JSON note
 *    (TrendSpider webhooks cannot set custom headers). An `x-rb-webhook-token` header is also accepted.
 *  • App (browser → functions): RB_APP_ACCESS_TOKEN as "Authorization: Bearer <token>", typed once by you into
 *    the app's Automation settings. It is a different value from the webhook secret.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time comparison (both sides hashed to equal length first). Empty or missing expected → always false. */
export function safeEqual(provided: unknown, expected: string | undefined): boolean {
  if (typeof provided !== 'string' || !provided || !expected) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function webhookTokenFrom(req: Request, body: unknown): unknown {
  const header = req.headers.get('x-rb-webhook-token');
  if (header) return header;
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    return b.token ?? b.secret;
  }
  return undefined;
}

export function bearerFrom(req: Request): string | undefined {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : undefined;
}

/** Best-effort per-instance rate limiter (serverless instances are short-lived; dedupe in storage is the real guard). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private limit: number, private windowMs: number) {}
  allow(key: string, now = Date.now()): boolean {
    const xs = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    xs.push(now);
    this.hits.set(key, xs);
    if (this.hits.size > 5000) this.hits.clear();
    return xs.length <= this.limit;
  }
}

export const clientIp = (req: Request) => req.headers.get('x-nf-client-connection-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
