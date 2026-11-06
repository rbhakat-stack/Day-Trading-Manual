/**
 * Browser side of Automated Alert Mode. It talks ONLY to this app's own Netlify functions (never to a broker,
 * never to Alpaca directly) using the app access token you type into Automation settings. The webhook secret and
 * the Alpaca keys exist only on the server.
 */
import { useEffect, useRef, useState } from 'react';
import { CANDLE_MAX_ATTEMPTS, DEFAULT_AUTOMATION, type AutoAlertRecord, type AutomationConfig, type LiveQuote, type QuoteSnapshot } from '../engine/automation/alertDecision';
import type { Classification } from '../engine/automation/autoCandidate';
import { KNOWN_CLASSIFICATIONS } from '../engine/ranker/correlationRules';
import type { ParityEntry } from '../engine/automation/parity';
import type { HistoricalResult } from '../engine/automation/historicalParity';
import { load, save } from './storage';

export const AUTO_KEYS = {
  config: 'rbv1.automation.config.v1',
  token: 'rbv1.automation.token.v1',
  classifications: 'rbv1.automation.classifications.v1',
  /** Tickers the user deleted (so a built-in default classification does not reappear on reload). */
  classificationsDeleted: 'rbv1.automation.classifications.deleted.v1',
  parity: 'rbv1.automation.parity.v1',
  /** RB v1.2 SHADOW comparison log (frozen first v1.2 score per alert; calibration data only). */
  v12ShadowLog: 'rbv1.v12.shadowLog.v1',
  /** RB v1.2 immutable alert-time snapshots (CR-03; write-once per alert, retained 90 days). */
  alertSnapshots: 'rbv1.v12.alertSnapshots.v1',
  /** Terminal SETUP FAILED events (write-once per alert, retained 90 days). */
  terminalEvents: 'rbv1.v12.terminalEvents.v1',
  /** Broker-confirmed released portfolio reservations (write-once per candidate id). */
  releasedExposure: 'rbv1.v12.releasedExposure.v1',
  /** Last VERIFIED broker-only exposure (positions + working entries; replaced only by a verified response). */
  brokerSnapshot: 'rbv1.v12.brokerExposureSnapshot.v1',
  /** CR-15 client mode: OFF (default) · PREVIEW (dry run, no writes) · AUTO (reconcile automatically after a verified backup). */
  cr15Mode: 'rbv1.cr15.mode.v1',
  /** CR-12 — Alpaca order JSON pasted by the user for read-only reconciliation (no broker connection). */
  brokerOrders: 'rbv1.v12.brokerOrders.v1',
} as const;

export function loadAutomationConfig(): AutomationConfig {
  const s = load<Partial<AutomationConfig>>(AUTO_KEYS.config, {});
  return { ...DEFAULT_AUTOMATION, ...s, parity: { ...DEFAULT_AUTOMATION.parity, ...(s.parity ?? {}) } };
}

/** The persisted value (kept in sync); writes happen in the caller's effect. */
export function usePersistent<T>(key: string, initial: () => T): [T, (v: T | ((x: T) => T)) => void] {
  const [v, setV] = useState<T>(initial);
  useEffect(() => void save(key, v), [key, v]);
  return [v, setV];
}

/* ───────────────────────── sector / industry / theme memory ───────────────────────── */

export type ClassMap = Record<string, Classification>;

export function initialClassifications(): ClassMap {
  const deleted = new Set(load<string[]>(AUTO_KEYS.classificationsDeleted, []));
  const known = Object.fromEntries(Object.entries(KNOWN_CLASSIFICATIONS).filter(([t]) => !deleted.has(t)));
  // The tombstones only hide built-in defaults; anything in the saved map (e.g. re-imported later) is kept.
  return { ...known, ...load<ClassMap>(AUTO_KEYS.classifications, {}) };
}

/* CR-02 — classification management (view / count / export / edit one / delete one). Import is unchanged above. */

const TICKER_RE = /^[A-Z]{1,5}([.-][A-Z]{1,2})?$/;

/** Validation for a single edited row (same rules as the CSV import). Null = valid. */
export function classificationError(ticker: string, c: Classification): string | null {
  if (!TICKER_RE.test(ticker.trim().toUpperCase())) return 'Ticker must be 1–5 letters (optionally .X / -X).';
  if (!c.sector.trim()) return 'Sector is required.';
  return null;
}

export function upsertClassification(map: ClassMap, ticker: string, c: Classification): ClassMap {
  const t = ticker.trim().toUpperCase();
  save(AUTO_KEYS.classificationsDeleted, load<string[]>(AUTO_KEYS.classificationsDeleted, []).filter((x) => x !== t));
  return { ...map, [t]: { sector: c.sector.trim(), industry: c.industry.trim(), theme: c.theme.trim() } };
}

export function removeClassification(map: ClassMap, ticker: string): ClassMap {
  const t = ticker.trim().toUpperCase();
  const deleted = load<string[]>(AUTO_KEYS.classificationsDeleted, []);
  if (!deleted.includes(t)) save(AUTO_KEYS.classificationsDeleted, [...deleted, t]);
  const next = { ...map };
  delete next[t];
  return next;
}

/** CSV export in the same format the import accepts (Ticker,Sector,Industry,Theme), sorted by ticker. */
export function classificationsCsv(map: ClassMap): string {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = Object.keys(map).sort().map((t) => [t, map[t].sector, map[t].industry, map[t].theme].map(cell).join(','));
  return ['Ticker,Sector,Industry,Theme', ...rows].join('\n') + '\n';
}

/** CSV import: "Ticker,Sector,Industry,Theme" (header optional). Returns the parsed rows and any bad lines. */
export function parseClassificationCsv(text: string): { rows: ClassMap; errors: string[] } {
  const rows: ClassMap = {};
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    if (!line.trim() || (i === 0 && /^ticker$/i.test(cells[0]))) return;
    const [t, sector, industry = '', theme = ''] = cells;
    if (!TICKER_RE.test((t ?? '').toUpperCase()) || !sector) errors.push(`Line ${i + 1}: needs Ticker,Sector[,Industry,Theme]`);
    else rows[t.toUpperCase()] = { sector, industry, theme };
  });
  return { rows, errors };
}

/* ───────────────────────── polling ───────────────────────── */

async function call<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/.netlify/functions/${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, 'content-type': 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}${res.status === 401 ? ' — check the app access token' : ''}`);
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
    throw new Error('Netlify Functions not reachable — use the deployed site or run `npx netlify dev` locally (plain `npm run dev` has no functions).');
  }
  return (await res.json()) as T;
}

export interface FeedState {
  records: AutoAlertRecord[];
  lastOkMs: number | null;
  error: string | null;
  /** ET date whose alert records were last loaded successfully (null = not loaded yet). Journal sync waits for it. */
  loadedDate: string | null;
}

/** Polls the day's alert records. Each record is an immutable snapshot; the client never edits them. */
export function useAlertRecords(cfg: AutomationConfig, token: string, date: string): FeedState & { reprocess: (id: string) => Promise<void> } {
  const [state, setState] = useState<FeedState>({ records: [], lastOkMs: null, error: null, loadedDate: null });
  const retried = useRef(new Map<string, number>());
  useEffect(() => {
    if (!cfg.enabled || !token) {
      setState({ records: [], lastOkMs: null, error: null, loadedDate: null });
      return;
    }
    let stop = false;
    const tick = async () => {
      try {
        const j = await call<{ records: AutoAlertRecord[] }>(`rb-alerts?date=${date}`, token);
        if (!stop) setState({ records: j.records, lastOkMs: Date.now(), error: null, loadedDate: date });
        // Bounded automatic retry of records stuck in RECEIVED (function timed out) or DATA_ERROR.
        for (const r of j.records) {
          const stuck = (r.status === 'RECEIVED' || r.status === 'ENRICHING') && Date.now() - r.receivedMs > 20_000;
          const n = retried.current.get(r.id) ?? 0;
          // Step 3 · A — an incomplete signal candle is retried on the server's schedule (~30 / 60 / 120 s), bounded;
          // the server re-checks the schedule and the limit, so another tab or a reload cannot add attempts.
          const candle = r.status === 'DATA_ERROR' && r.errorCode === 'SIGNAL_CANDLE_INCOMPLETE';
          const due = candle ? !!r.nextAttemptMs && Date.now() >= r.nextAttemptMs + 5_000 && r.attempts < CANDLE_MAX_ATTEMPTS && n < CANDLE_MAX_ATTEMPTS : false; // 5 s margin for clock skew
          if (due || (!candle && r.errorCode !== 'SIGNAL_CANDLE_INCOMPLETE_FINAL' && (stuck || r.status === 'DATA_ERROR') && r.attempts < 3 && n < 2)) {
            retried.current.set(r.id, n + 1);
            void call('rb-alerts', token, { method: 'POST', body: JSON.stringify({ action: 'reprocess', id: r.id, date }) }).catch(() => undefined);
          }
        }
      } catch (e) {
        if (!stop) setState((s) => ({ ...s, error: (e as Error).message }));
      }
    };
    void tick();
    const h = setInterval(tick, Math.max(1000, cfg.pollMs));
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [cfg.enabled, cfg.pollMs, token, date]);
  const reprocess = async (id: string) => {
    await call('rb-alerts', token, { method: 'POST', body: JSON.stringify({ action: 'reprocess', id, date }) });
  };
  return { ...state, reprocess };
}

/** Live current prices (never cached). Quotes carry the client receive time for the data-age check. */
export function useLiveQuotes(cfg: AutomationConfig, token: string, symbols: string[]): { quotes: Record<string, LiveQuote>; error: string | null } {
  const [quotes, setQuotes] = useState<Record<string, LiveQuote>>({});
  const [error, setError] = useState<string | null>(null);
  const key = [...new Set(symbols)].sort().join(',');
  useEffect(() => {
    if (!cfg.enabled || !token || !key) return;
    let stop = false;
    const tick = async () => {
      try {
        const j = await call<{ quotes: Record<string, QuoteSnapshot> }>(`rb-quotes?symbols=${encodeURIComponent(key)}`, token);
        const receivedMs = Date.now();
        if (!stop) {
          setQuotes((q) => {
            const next = { ...q };
            for (const [s, x] of Object.entries(j.quotes)) next[s] = { ...x, receivedMs };
            return next;
          });
          setError(null);
        }
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    void tick();
    const h = setInterval(tick, Math.max(1000, cfg.quotePollMs));
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [cfg.enabled, cfg.quotePollMs, token, key]);
  return { quotes, error };
}

export interface BrokerPosition { symbol: string; side?: string; qty?: string; avg_entry_price?: string; current_price?: string; market_value?: string; unrealized_pl?: string }
export interface BrokerFeed {
  /** 'OFF' = the server has broker sync disabled (RB_BROKER_SYNC_ENABLED); 'ERROR' = last read failed. */
  status: 'LOADING' | 'LIVE' | 'OFF' | 'ERROR';
  orders: unknown[];
  positions: BrokerPosition[];
  lastOkMs: number | null;
  error: string | null;
  /** ET date whose orders/positions were last loaded successfully (null = not loaded yet). */
  loadedDate?: string | null;
  /** Orders open now, whatever day they were submitted; null = not returned by the server (unknown). */
  openOrders?: unknown[] | null;
}

/** CR-12 — polls the READ-ONLY rb-broker endpoint (paper account orders + positions). It never sends an order. */
export function useBrokerFeed(enabled: boolean, token: string, date: string, pollMs = 30_000): BrokerFeed {
  const [s, setS] = useState<BrokerFeed>({ status: 'LOADING', orders: [], positions: [], lastOkMs: null, error: null });
  useEffect(() => {
    if (!enabled || !token) return;
    let stop = false;
    const tick = async () => {
      try {
        const j = await call<{ orders: unknown[]; positions: BrokerPosition[]; openOrders?: unknown[] | null }>(`rb-broker?date=${date}`, token);
        if (!stop) setS({ status: 'LIVE', orders: j.orders, positions: j.positions, lastOkMs: Date.now(), error: null, loadedDate: date, openOrders: Array.isArray(j.openOrders) ? j.openOrders : null });
      } catch (e) {
        const msg = (e as Error).message;
        if (!stop) setS((x) => ({ ...x, status: /HTTP 503/.test(msg) ? 'OFF' : 'ERROR', error: msg }));
      }
    };
    void tick();
    const h = setInterval(tick, Math.max(10_000, pollMs));
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [enabled, token, date, pollMs]);
  return s;
}

/**
 * Cross-day exposure — the READ-ONLY rb-broker order lists for the entry days of earlier-dated active candidates.
 * `dates` is already bounded (historyDatesFor). One request per date per poll, sequential; a failed date is marked
 * ERROR (its last orders are no longer evidence) and is retried on the next poll. It never sends an order.
 */
export function useBrokerHistory(enabled: boolean, token: string, dates: string[], pollMs = 60_000): Record<string, BrokerFeed> {
  const [s, setS] = useState<Record<string, BrokerFeed>>({});
  const key = dates.join(',');
  useEffect(() => {
    if (!enabled || !token || !key) return;
    let stop = false;
    const tick = async () => {
      for (const date of key.split(',')) {
        if (stop) return;
        try {
          const j = await call<{ orders: unknown[] }>(`rb-broker?date=${date}`, token);
          if (!stop) setS((x) => ({ ...x, [date]: { status: 'LIVE', orders: j.orders, positions: [], lastOkMs: Date.now(), error: null, loadedDate: date } }));
        } catch (e) {
          const msg = (e as Error).message;
          if (!stop) setS((x) => ({ ...x, [date]: { ...(x[date] ?? { orders: [], positions: [], lastOkMs: null, loadedDate: null }), status: /HTTP 503/.test(msg) ? 'OFF' : 'ERROR', error: msg } }));
        }
      }
    };
    void tick();
    const h = setInterval(tick, Math.max(30_000, pollMs));
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [enabled, token, key, pollMs]);
  return s;
}

/** Server feature flags from rb-health (read-only). null = unknown (not loaded / failed) — treated as OFF. */
export function useServerFlags(enabled: boolean, token: string, pollMs = 300_000): { cr15: boolean | null; rvolV1Observation: boolean | null; referenceScores: boolean | null; rvolPolicyA: boolean | null; rvolPolicyB: boolean | null } {
  const [s, setS] = useState<{ cr15: boolean | null; rvolV1Observation: boolean | null; referenceScores: boolean | null; rvolPolicyA: boolean | null; rvolPolicyB: boolean | null }>({ cr15: null, rvolV1Observation: null, referenceScores: null, rvolPolicyA: null, rvolPolicyB: null });
  useEffect(() => {
    if (!enabled || !token) { setS({ cr15: null, rvolV1Observation: null, referenceScores: null, rvolPolicyA: null, rvolPolicyB: null }); return; }
    let stop = false;
    const tick = async () => {
      try {
        const h = await checkHealth(token);
        if (!stop) setS({ cr15: h.config?.cr15Enabled === true, rvolV1Observation: h.config?.rvolV1ObservationEnabled === true, referenceScores: h.config?.referenceScoresEnabled === true, rvolPolicyA: h.config?.rvolPolicyAEnabled === true, rvolPolicyB: h.config?.rvolPolicyBEnabled === true });
      } catch {
        if (!stop) setS({ cr15: null, rvolV1Observation: null, referenceScores: null, rvolPolicyA: null, rvolPolicyB: null });
      }
    };
    void tick();
    const h = setInterval(tick, Math.max(60_000, pollMs));
    return () => { stop = true; clearInterval(h); };
  }, [enabled, token, pollMs]);
  return s;
}

export interface BrokerHistoryFeed { status: 'IDLE' | 'LOADING' | 'LIVE' | 'ERROR'; orders: unknown[]; positions: BrokerPosition[]; complete: boolean; from: string | null; symbols: string[]; lastOkMs: number | null; error: string | null }

/** CR-15 — bounded read-only order history for the open Journal trades' tickers since `from` (one request per poll). */
export function useBrokerSymbolHistory(enabled: boolean, token: string, symbols: string[], from: string | null, pollMs = 60_000): BrokerHistoryFeed {
  const idle: BrokerHistoryFeed = { status: 'IDLE', orders: [], positions: [], complete: false, from: null, symbols: [], lastOkMs: null, error: null };
  const [s, setS] = useState<BrokerHistoryFeed>(idle);
  const key = `${symbols.join(',')}|${from ?? ''}`;
  useEffect(() => {
    if (!enabled || !token || !from || !symbols.length) { setS(idle); return; }
    let stop = false;
    const [syms, f] = key.split('|');
    const tick = async () => {
      try {
        const j = await call<{ orders: unknown[]; positions: BrokerPosition[]; complete?: boolean; from?: string; symbols?: string[] }>(`rb-broker?symbols=${encodeURIComponent(syms)}&from=${f}`, token);
        if (!stop) setS({ status: 'LIVE', orders: j.orders, positions: j.positions, complete: j.complete === true, from: j.from ?? null, symbols: j.symbols ?? [], lastOkMs: Date.now(), error: null });
      } catch (e) {
        if (!stop) setS((x) => ({ ...x, status: 'ERROR', error: (e as Error).message }));
      }
    };
    setS((x) => ({ ...x, status: x.status === 'LIVE' ? x.status : 'LOADING' }));
    void tick();
    const h = setInterval(tick, Math.max(30_000, pollMs));
    return () => { stop = true; clearInterval(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, token, key, pollMs]);
  return s;
}

export async function checkHealth(token: string) {
  return call<{ ok: boolean; config: Record<string, unknown>; versions: Record<string, string>; execution: string }>('rb-health', token);
}

export const loadParity = () => load<Record<string, ParityEntry>>(AUTO_KEYS.parity, {});

/* ───────────────────────── Historical SIP Parity Test (diagnostic only) ───────────────────────── */

export type HistoricalResponse = { ok: true; result: HistoricalResult } | { ok: false; kind: string; error: string };

/**
 * One request to rb-historical-parity. Unlike `call`, the server's sanitised reason is kept (SIP authorization /
 * entitlement / window / missing bars) so it can be shown verbatim. Nothing is stored and no live state is touched.
 */
export interface HistoricalRequestBody {
  symbol: string;
  direction: string;
  alertEt: string;
  label: string;
  /** EXACT = seconds known · MINUTE = only the minute is known (approximate intrabar reconstruction). */
  precision: 'EXACT' | 'MINUTE';
}

/** The exact JSON the server expects (rb-historical-parity contract). Trims; upper-cases ticker and direction only. */
export function historicalRequestBody(raw: Partial<Record<keyof HistoricalRequestBody, unknown>>): HistoricalRequestBody {
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return { symbol: s(raw.symbol).toUpperCase(), direction: s(raw.direction).toUpperCase(), alertEt: s(raw.alertEt), label: s(raw.label), precision: s(raw.precision).toUpperCase() === 'MINUTE' ? 'MINUTE' : 'EXACT' };
}

export async function runHistoricalSip(token: string, body: HistoricalRequestBody): Promise<HistoricalResponse> {
  let res: Response;
  try {
    res = await fetch('/.netlify/functions/rb-historical-parity', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(historicalRequestBody(body)), cache: 'no-store' });
  } catch (e) {
    return { ok: false, kind: 'NETWORK', error: (e as Error).message };
  }
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
    return { ok: false, kind: 'NOT_REACHABLE', error: 'Netlify Functions not reachable — use the deployed site or run `npx netlify dev` locally (plain `npm run dev` has no functions).' };
  }
  const j = (await res.json()) as { ok?: boolean; result?: HistoricalResult; kind?: string; error?: string };
  if (res.ok && j.ok && j.result) return { ok: true, result: j.result };
  return { ok: false, kind: j.kind ?? `HTTP_${res.status}`, error: res.status === 401 ? 'HTTP 401 — check the app access token (Automation settings).' : (j.error ?? `HTTP ${res.status}`) };
}
