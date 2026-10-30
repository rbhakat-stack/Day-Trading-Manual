/** Server-side configuration from Netlify environment variables (never bundled into the React app). */
import { createAlpacaData, type MarketDataClient } from './alpaca';

export const env = (k: string) => (typeof process !== 'undefined' ? process.env[k] : undefined) || undefined;

export function dataClient(): MarketDataClient | null {
  const keyId = env('ALPACA_API_KEY');
  const secretKey = env('ALPACA_SECRET_KEY');
  if (!keyId || !secretKey) return null;
  return createAlpacaData({ keyId, secretKey, baseUrl: env('ALPACA_DATA_BASE_URL'), feed: env('ALPACA_DATA_FEED'), attempts: 2, timeoutMs: 2500 });
}

export const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });

/** Configuration status without any secret values (booleans and non-secret settings only). */
export function configStatus() {
  return {
    webhookSecretSet: !!env('TRENDSPIDER_WEBHOOK_SECRET'),
    appAccessTokenSet: !!env('RB_APP_ACCESS_TOKEN'),
    alpacaKeySet: !!env('ALPACA_API_KEY'),
    alpacaSecretSet: !!env('ALPACA_SECRET_KEY'),
    alpacaDataHost: (() => {
      try {
        return new URL(env('ALPACA_DATA_BASE_URL') || 'https://data.alpaca.markets').hostname;
      } catch {
        return 'invalid';
      }
    })(),
    alpacaFeed: (env('ALPACA_DATA_FEED') || 'sip').toLowerCase(),
  };
}
