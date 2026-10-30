/**
 * Browser side of Automated Alert Mode. It talks ONLY to this app's own Netlify functions (never to a broker,
 * never to Alpaca directly) using the app access token you type into Automation settings. The webhook secret and
 * the Alpaca keys exist only on the server.
 */
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type AutomationConfig, type LiveQuote, type QuoteSnapshot } from '../engine/automation/alertDecision';
import type { Classification } from '../engine/automation/autoCandidate';
import { KNOWN_CLASSIFICATIONS } from '../engine/ranker/correlationRules';
import type { ParityEntry } from '../engine/automation/parity';
import { load, save } from './storage';

export const AUTO_KEYS = {
  config: 'rbv1.automation.config.v1',
  token: 'rbv1.automation.token.v1',
  classifications: 'rbv1.automation.classifications.v1',
  parity: 'rbv1.automation.parity.v1',
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
  return { ...KNOWN_CLASSIFICATIONS, ...load<ClassMap>(AUTO_KEYS.classifications, {}) };
}

/** CSV import: "Ticker,Sector,Industry,Theme" (header optional). Returns the parsed rows and any bad lines. */
export function parseClassificationCsv(text: string): { rows: ClassMap; errors: string[] } {
  const rows: ClassMap = {};
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    if (!line.trim() || (i === 0 && /^ticker$/i.test(cells[0]))) return;
    const [t, sector, industry = '', theme = ''] = cells;
    if (!/^[A-Z]{1,5}([.-][A-Z]{1,2})?$/.test((t ?? '').toUpperCase()) || !sector) errors.push(`Line ${i + 1}: needs Ticker,Sector[,Industry,Theme]`);
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
}

/** Polls the day's alert records. Each record is an immutable snapshot; the client never edits them. */
export function useAlertRecords(cfg: AutomationConfig, token: string, date: string): FeedState & { reprocess: (id: string) => Promise<void> } {
  const [state, setState] = useState<FeedState>({ records: [], lastOkMs: null, error: null });
  const retried = useRef(new Map<string, number>());
  useEffect(() => {
    if (!cfg.enabled || !token) {
      setState({ records: [], lastOkMs: null, error: null });
      return;
    }
    let stop = false;
    const tick = async () => {
      try {
        const j = await call<{ records: AutoAlertRecord[] }>(`rb-alerts?date=${date}`, token);
        if (!stop) setState({ records: j.records, lastOkMs: Date.now(), error: null });
        // Bounded automatic retry of records stuck in RECEIVED (function timed out) or DATA_ERROR.
        for (const r of j.records) {
          const stuck = (r.status === 'RECEIVED' || r.status === 'ENRICHING') && Date.now() - r.receivedMs > 20_000;
          const n = retried.current.get(r.id) ?? 0;
          if ((stuck || r.status === 'DATA_ERROR') && r.attempts < 3 && n < 2) {
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

export async function checkHealth(token: string) {
  return call<{ ok: boolean; config: Record<string, unknown>; versions: Record<string, string>; execution: string }>('rb-health', token);
}

export const loadParity = () => load<Record<string, ParityEntry>>(AUTO_KEYS.parity, {});
