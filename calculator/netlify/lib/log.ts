/**
 * Structured JSON logs (one line per event, visible in Netlify → Functions → Logs).
 * Any field whose name looks like a credential is dropped, and known secret values are masked, so tokens and API
 * keys can never reach the logs.
 */
export type LogEvent =
  | 'webhook_received'
  | 'webhook_rejected'
  | 'webhook_duplicate'
  | 'webhook_test'
  | 'market_data_fetch_started'
  | 'market_data_fetch_failed'
  | 'market_data_fetched'
  | 'candidate_enriched'
  | 'calculator_result'
  | 'hard_rule_result'
  | 'data_mismatch'
  | 'record_stored'
  | 'read_rejected'
  | 'quotes_served'
  | 'historical_test_started'
  | 'historical_test_completed'
  | 'historical_test_failed';

const SECRET_KEY = /token|secret|key|password|authorization|auth/i;

function secretValues(): string[] {
  const env = typeof process !== 'undefined' ? process.env : {};
  return ['TRENDSPIDER_WEBHOOK_SECRET', 'RB_APP_ACCESS_TOKEN', 'ALPACA_API_KEY', 'ALPACA_SECRET_KEY'].map((k) => env[k]).filter((v): v is string => !!v && v.length >= 4);
}

export function redact(value: unknown, secrets = secretValues()): unknown {
  if (typeof value === 'string') return secrets.reduce((s, x) => s.split(x).join('[REDACTED]'), value);
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !SECRET_KEY.test(k)).map(([k, v]) => [k, redact(v, secrets)]));
  }
  return value;
}

export type Logger = (event: LogEvent, fields?: Record<string, unknown>) => void;

export const log: Logger = (event, fields = {}) => {
  console.log(JSON.stringify(redact({ ts: new Date().toISOString(), event, ...fields })));
};
