/**
 * TrendSpider webhook payload validation. Never trust incoming data: every field is checked and anything
 * malformed is rejected with a reason. The authentication token is removed before anything is stored or logged.
 *
 * Accepted JSON (TrendSpider "Your Note"):
 *   { "strategy": "RB_V1", "symbol": "NVDA", "direction": "SHORT", "alert_name": "RB v1 SHORT Setup",
 *     "last_price": "212.44", "alert_time": "2026-10-30T14:30:00-04:00", "token": "<secret>" }
 * Optional: "test": true → validated and echoed, never stored or enriched.
 */
import type { Direction } from '../tradeCalculator';
import { parseIsoWithZone } from './etTime';

export const MAX_PAYLOAD_BYTES = 4096;
export const ACCEPTED_STRATEGIES = ['RB_V1', 'RB_V1.1', 'RB V1', 'RB_V1_1'];

export interface ParsedAlert {
  strategy: 'RB_V1';
  symbol: string;
  direction: Direction;
  alertName: string;
  alertTimeMs: number;
  alertTimeIso: string;
  /** PAYLOAD = alert_time from TrendSpider; RECEIVED = not supplied, server receipt time used (shown in provenance). */
  timeSource: 'PAYLOAD' | 'RECEIVED';
  /** TrendSpider last price when supplied (informational; never used as market data). */
  lastPrice: number | null;
  test: boolean;
}

export type ParseResult = { ok: true; alert: ParsedAlert } | { ok: false; errors: string[] };

const SYMBOL = /^[A-Z]{1,5}([.-][A-Z]{1,2})?$/;

function directionOf(raw: unknown, alertName: string): Direction | null {
  const d = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (d === 'LONG' || d === 'BUY') return 'LONG';
  if (d === 'SHORT' || d === 'SELL') return 'SHORT';
  if (d) return null; // present but not understood → reject, never guess
  const n = alertName.toUpperCase();
  const long = /\bLONG\b/.test(n);
  const short = /\bSHORT\b/.test(n);
  return long !== short ? (long ? 'LONG' : 'SHORT') : null;
}

/** Validate a decoded JSON body. `now` bounds the timestamp (no future alerts, no ancient replays). */
export function parseAlertPayload(body: unknown, now: number, maxAgeHours = 12): ParseResult {
  const errors: string[] = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, errors: ['Body must be a JSON object.'] };
  const b = body as Record<string, unknown>;

  const strategy = typeof b.strategy === 'string' ? b.strategy.trim().toUpperCase() : '';
  if (!ACCEPTED_STRATEGIES.includes(strategy)) errors.push(`strategy must be "RB_V1" (got ${JSON.stringify(b.strategy ?? null)}).`);

  const symbol = typeof b.symbol === 'string' ? b.symbol.trim().toUpperCase() : '';
  if (!SYMBOL.test(symbol)) errors.push('symbol must be a US stock ticker (1–5 letters, optional .X class suffix).');

  const alertName = typeof b.alert_name === 'string' ? b.alert_name.trim().slice(0, 120) : '';
  const direction = directionOf(b.direction, alertName);
  if (!direction) errors.push('direction must be LONG or SHORT (or derivable from alert_name).');
  if (alertName && direction && /\bLONG\b/i.test(alertName) !== (direction === 'LONG') && /\b(LONG|SHORT)\b/i.test(alertName)) {
    errors.push(`direction ${direction} contradicts alert_name "${alertName}".`);
  }

  let alertTimeMs: number | null = null;
  const timeSource: ParsedAlert['timeSource'] = b.alert_time === undefined || b.alert_time === null || b.alert_time === '' ? 'RECEIVED' : 'PAYLOAD';
  if (timeSource === 'RECEIVED') {
    // TrendSpider may not be able to insert a timestamp into the note. Receipt time is used and labelled; the snapshot's
    // signal-candle lag check still flags a late delivery as ambiguous. A malformed timestamp is never accepted.
    alertTimeMs = now;
  } else if (typeof b.alert_time === 'number' && Number.isFinite(b.alert_time)) {
    alertTimeMs = b.alert_time > 1e12 ? b.alert_time : b.alert_time * 1000; // epoch ms or s
  } else if (typeof b.alert_time === 'string') {
    alertTimeMs = parseIsoWithZone(b.alert_time);
  }
  if (alertTimeMs === null) {
    errors.push('alert_time must be ISO-8601 with an explicit offset (e.g. 2026-10-30T14:30:00-04:00) or epoch seconds/ms.');
  } else {
    if (alertTimeMs > now + 60_000) errors.push('alert_time is in the future.');
    if (alertTimeMs < now - maxAgeHours * 3600_000) errors.push(`alert_time is more than ${maxAgeHours} h old.`);
  }

  let lastPrice: number | null = null;
  if (b.last_price !== undefined && b.last_price !== null && b.last_price !== '') {
    const p = typeof b.last_price === 'number' ? b.last_price : typeof b.last_price === 'string' ? Number(b.last_price.trim()) : NaN;
    if (!(Number.isFinite(p) && p > 0 && p < 1_000_000)) errors.push('last_price, when supplied, must be a positive number.');
    else lastPrice = p;
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    alert: {
      strategy: 'RB_V1',
      symbol,
      direction: direction as Direction,
      alertName: alertName || `RB v1 ${direction} Setup`,
      alertTimeMs: alertTimeMs as number,
      alertTimeIso: new Date(alertTimeMs as number).toISOString(),
      timeSource,
      lastPrice,
      test: b.test === true,
    },
  };
}

/** Deduplication key: Ticker + Direction + Alert timestamp (to the second) + Alert type. */
export function dedupeKey(a: Pick<ParsedAlert, 'symbol' | 'direction' | 'alertTimeMs' | 'alertName'>): string {
  const type = a.alertName.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return `${a.symbol}|${a.direction}|${Math.floor(a.alertTimeMs / 1000)}|${type}`;
}

/** Copy of the body without any credential-like field (for storage and logs). */
export function withoutSecrets(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  return Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([k]) => !/token|secret|key|password|auth/i.test(k)));
}
