/**
 * Historical SIP Parity Test — server side (DIAGNOSTIC ONLY, isolated from the live webhook path).
 *
 *  • Forces feed=sip for this request only. The ALPACA_DATA_FEED environment variable is read by nobody here and is
 *    never modified; live alerts keep using their own client (env.ts dataClient()).
 *  • Bars only. Every request passes `assertHistoricalBarsRequest` (on top of the read-only market-data guard):
 *    GET /v2/stocks/{SYMBOL}/bars with feed=sip and an end that is ≥ 16 minutes old. Latest trade / latest quote /
 *    snapshot / quotes / trades endpoints are rejected before any network call, so no real-time SIP entitlement is
 *    ever needed and no current price is ever fetched.
 *  • No storage: this module does not import the alert store, so it cannot create, modify or de-duplicate alerts.
 *  • Fails closed: SIP errors are reported (sanitised) and never replaced with IEX data.
 */
import { checkHistoricalRequest, requestWindows, runIntrabarReconstruction, SIP_HISTORICAL_MIN_AGE_MS, type HistoricalResult } from '../../src/engine/automation/historicalParity';
import { assertReadOnlyDataRequest, createAlpacaData, DataFetchError } from './alpaca';
import { redact, type Logger } from './log';

export const HISTORICAL_FEED = 'sip' as const;

/** Allow ONLY historical SIP bar requests. Throws (no network call) for anything else. */
export function assertHistoricalBarsRequest(url: string, method: string, now: number): void {
  assertReadOnlyDataRequest(url, method);
  const u = new URL(url);
  if (!/^\/v2\/stocks\/[A-Z.-]{1,8}\/bars$/.test(decodeURIComponent(u.pathname))) throw new Error(`Blocked: historical test allows only /v2/stocks/{symbol}/bars (got ${u.pathname}).`);
  if (/latest|snapshot|quotes|trades/i.test(u.pathname)) throw new Error('Blocked: current/latest endpoints are not allowed in the historical test.');
  if (u.searchParams.get('feed') !== HISTORICAL_FEED) throw new Error('Blocked: historical test must request feed=sip.');
  if (!['1Min', '5Min'].includes(u.searchParams.get('timeframe') ?? '')) throw new Error('Blocked: historical test allows only 1Min / 5Min bars.');
  const end = Date.parse(u.searchParams.get('end') ?? '');
  if (!Number.isFinite(end)) throw new Error('Blocked: historical test requires an explicit end time.');
  if (end > now - SIP_HISTORICAL_MIN_AGE_MS) throw new Error('Blocked: requested end is too recent for historical SIP.');
}

export type FailureKind = 'AUTHORIZATION' | 'ENTITLEMENT' | 'HISTORICAL_WINDOW' | 'RATE_LIMIT' | 'PROVIDER' | 'NETWORK' | 'BLOCKED';

export type HistoricalOutcome =
  | { ok: true; result: HistoricalResult }
  | { ok: false; status: number; kind: FailureKind | 'INVALID_REQUEST' | 'NOT_CONFIGURED'; errors: string[] };

/** Provider text reduced to plain characters, secrets masked, length-limited. */
export function sanitizeProviderText(s: string, secrets?: string[]): string {
  const t = String(redact(s, secrets)).replace(/[^\w .,:;'"()/%+=\-[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.slice(0, 200);
}

export function classifyFailure(e: unknown, secrets?: string[]): { status: number; kind: FailureKind; message: string } {
  const msg = sanitizeProviderText(e instanceof Error ? e.message : String(e), secrets);
  if (/Blocked:/.test(msg)) return { status: 400, kind: 'BLOCKED', message: msg.slice(msg.indexOf('Blocked:')) };
  const status = e instanceof DataFetchError ? e.status : null;
  if (status === 401) return { status: 502, kind: 'AUTHORIZATION', message: `SIP authorization failure (HTTP 401): Alpaca rejected the API key/secret. Provider said: ${msg}` };
  if (status === 403 && /subscription|permit|sip|entitle/i.test(msg)) return { status: 502, kind: 'ENTITLEMENT', message: `SIP entitlement failure (HTTP 403): this Alpaca plan does not permit the requested SIP data. Provider said: ${msg}` };
  if (status === 403) return { status: 502, kind: 'AUTHORIZATION', message: `SIP authorization failure (HTTP 403). Provider said: ${msg}` };
  if (status === 400 || status === 404 || status === 422) return { status: 502, kind: 'HISTORICAL_WINDOW', message: `Historical window unavailable or request rejected (HTTP ${status}). Provider said: ${msg}` };
  if (status === 429) return { status: 502, kind: 'RATE_LIMIT', message: `Alpaca rate limit (HTTP 429). Try again in a minute.` };
  if (status !== null) return { status: 502, kind: 'PROVIDER', message: `Alpaca error (HTTP ${status}). Provider said: ${msg}` };
  return { status: 502, kind: 'NETWORK', message: msg || 'Alpaca request failed.' };
}

export interface HistoricalDeps {
  keyId: string | undefined;
  secretKey: string | undefined;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now: () => number;
  log: Logger;
}

export async function runHistoricalSipTest(body: unknown, deps: HistoricalDeps): Promise<HistoricalOutcome> {
  const now = deps.now();
  const req = checkHistoricalRequest(body, now);
  if (!req.ok) return { ok: false, status: 400, kind: 'INVALID_REQUEST', errors: req.errors };
  if (!deps.keyId || !deps.secretKey) return { ok: false, status: 503, kind: 'NOT_CONFIGURED', errors: ['Market data not configured (ALPACA_API_KEY / ALPACA_SECRET_KEY).'] };

  const base = deps.fetchImpl ?? fetch;
  const guarded: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    assertHistoricalBarsRequest(url, init?.method ?? 'GET', deps.now()); // throws before any network call
    return base(input, init);
  };
  const windows = requestWindows(req);
  const secrets = [deps.keyId, deps.secretKey].filter((s): s is string => !!s && s.length >= 4);
  try {
    // feed is forced here, never read from ALPACA_DATA_FEED. Only getBars5 (completed history before the active
    // bucket) and getBars1 (the active bucket up to the latest cutoff) are called — both historical bars.
    const client = createAlpacaData({ keyId: deps.keyId, secretKey: deps.secretKey, baseUrl: deps.baseUrl, feed: HISTORICAL_FEED, fetchImpl: guarded, attempts: 2, timeoutMs: 4000 });
    deps.log('historical_test_started', { symbol: req.symbol, direction: req.direction, alertEt: req.alertEt, precision: req.precision, ...windows, feed: HISTORICAL_FEED });
    const [hist5, min1] = await Promise.all([
      client.getBars5(req.symbol, windows.history5m.startIso, windows.history5m.endIso),
      client.getBars1!(req.symbol, windows.intrabar1m.startIso, windows.intrabar1m.endIso),
    ]);
    const result = runIntrabarReconstruction(hist5, min1, req, { host: client.host, windows });
    deps.log('historical_test_completed', { symbol: req.symbol, bars5: hist5.length, bars1: min1.length, active: result.timing.activeLabel, confirm15m: result.timing.confirm15mLabel, cutoffs: result.bounds.map((b) => b.snapshot.cutoffEt), issues: result.bounds.flatMap((b) => b.snapshot.issues.map((i) => i.code)) });
    return { ok: true, result };
  } catch (e) {
    const f = classifyFailure(e, secrets);
    deps.log('historical_test_failed', { symbol: req.symbol, kind: f.kind, error: f.message });
    return { ok: false, status: f.status, kind: f.kind, errors: [f.message] };
  }
}
