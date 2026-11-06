/** Server-side configuration from Netlify environment variables (never bundled into the React app). */
import { createAlpacaBrokerRead, createAlpacaData, type BrokerReadClient, type MarketDataClient } from './alpaca';

export const env = (k: string) => (typeof process !== 'undefined' ? process.env[k] : undefined) || undefined;

export function dataClient(): MarketDataClient | null {
  const keyId = env('ALPACA_API_KEY');
  const secretKey = env('ALPACA_SECRET_KEY');
  if (!keyId || !secretKey) return null;
  return createAlpacaData({ keyId, secretKey, baseUrl: env('ALPACA_DATA_BASE_URL'), feed: env('ALPACA_DATA_FEED'), attempts: 2, timeoutMs: 2500 });
}

/**
 * CR-12 read-only broker facts. OFF unless RB_BROKER_SYNC_ENABLED=true; uses the same (paper) key pair; the client
 * only issues GETs to the paper trading host's two list endpoints.
 */
export function brokerReadClient(): BrokerReadClient | null {
  const keyId = env('ALPACA_API_KEY');
  const secretKey = env('ALPACA_SECRET_KEY');
  if (env('RB_BROKER_SYNC_ENABLED') !== 'true' || !keyId || !secretKey) return null;
  return createAlpacaBrokerRead({ keyId, secretKey, baseUrl: env('ALPACA_BROKER_BASE_URL') });
}

export const json =(status: number, body: unknown, extra: Record<string, string> = {}) =>
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
    brokerSyncEnabled: env('RB_BROKER_SYNC_ENABLED') === 'true',
    /** CR-15 cross-day Journal reconciliation — server kill switch (default OFF; the client also needs its own opt-in). */
    cr15Enabled: env('RB_CR15_CROSSDAY_RECONCILIATION_ENABLED') === 'true',
    /** RVOL policy V1 OBSERVATION panel — display only, never affects decisions (default OFF; absent = OFF). */
    rvolV1ObservationEnabled: env('RB_RVOL_V1_OBSERVATION_ENABLED') === 'true',
    /** Phase C reference-only scores and indicator mismatch diagnostics — display only (default OFF; absent = OFF). */
    referenceScoresEnabled: env('RB_REFERENCE_SCORES_ENABLED') === 'true',
    /** RVOL eligibility Policy A — RVOL-only TrendSpider/SIP discrepancy becomes a warning (default OFF; absent = OFF). */
    rvolPolicyAEnabled: env('RB_RVOL_POLICY_A_ENABLED') === 'true',
  };
}
