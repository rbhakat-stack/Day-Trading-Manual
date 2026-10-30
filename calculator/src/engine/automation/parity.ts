/**
 * Data-parity validation: TrendSpider values you read off the chart vs the Automated Market Data Values.
 * Any field outside tolerance → DATA MISMATCH — MANUAL REVIEW REQUIRED for that alert (no ticket).
 */
import type { AlertTimeValues } from './alertSnapshot';
import type { ParityTolerance } from './alertDecision';

export const PARITY_FIELDS = ['open', 'high', 'low', 'close', 'atr', 'ema9', 'ema20', 'rsi', 'rvol', 'vwap', 'close15m', 'ema20_15m'] as const;
export type ParityField = (typeof PARITY_FIELDS)[number];

export const PARITY_LABELS: Record<ParityField, string> = {
  open: 'Open', high: 'High', low: 'Low', close: 'Close', atr: 'ATR(14)', ema9: 'EMA9', ema20: 'EMA20', rsi: 'RSI14', rvol: 'RVOL20', vwap: 'VWAP',
  close15m: '15m Close', ema20_15m: '15m EMA20',
};

export interface ParityEntry {
  recordId: string;
  symbol: string;
  alertEt: string;
  enteredIso: string;
  trendSpider: Partial<Record<ParityField, number>>;
}

export interface ParityRow {
  field: ParityField;
  trendSpider: number;
  automated: number;
  absDiff: number;
  pctDiff: number | null;
  tolerance: string;
  mismatch: boolean;
}

function rule(f: ParityField, t: ParityTolerance): { abs?: number; pct?: number; label: string } {
  switch (f) {
    case 'open': case 'high': case 'low': case 'close': case 'close15m':
      return { abs: t.priceAbs, label: `±$${t.priceAbs.toFixed(2)}` };
    case 'atr': return { pct: t.atrPct, label: `±${(t.atrPct * 100).toFixed(1)}%` };
    case 'ema9': case 'ema20': case 'ema20_15m': return { pct: t.emaPct, label: `±${(t.emaPct * 100).toFixed(2)}%` };
    case 'vwap': return { pct: t.vwapPct, label: `±${(t.vwapPct * 100).toFixed(2)}%` };
    case 'rvol': return { pct: t.rvolPct, label: `±${(t.rvolPct * 100).toFixed(0)}%` };
    case 'rsi': return { abs: t.rsiPts, label: `±${t.rsiPts} pts` };
  }
}

export function compareParity(auto: AlertTimeValues, ts: Partial<Record<ParityField, number>>, tol: ParityTolerance): ParityRow[] {
  const rows: ParityRow[] = [];
  for (const f of PARITY_FIELDS) {
    const t = ts[f];
    if (t === undefined || t === null || !Number.isFinite(t)) continue;
    const a = auto[f];
    const absDiff = Math.abs(t - a);
    const pctDiff = t !== 0 ? absDiff / Math.abs(t) : null;
    const r = rule(f, tol);
    const over = r.abs !== undefined ? absDiff > r.abs + 1e-9 : pctDiff === null ? absDiff > 0 : pctDiff > (r.pct as number) + 1e-12;
    rows.push({ field: f, trendSpider: t, automated: a, absDiff, pctDiff, tolerance: r.label, mismatch: over });
  }
  return rows;
}

export const mismatchMessages = (rows: ParityRow[]) =>
  rows.filter((r) => r.mismatch).map((r) => `${PARITY_LABELS[r.field]}: TrendSpider ${r.trendSpider} vs automated ${+r.automated.toFixed(4)} (Δ ${+r.absDiff.toFixed(4)}, tolerance ${r.tolerance})`);

/** Overall validation status: VALIDATED after `required` compared alerts with no mismatch at all. */
export function paritySummary(entries: ParityEntry[], rowsById: Record<string, ParityRow[]>, required: number) {
  const compared = entries.filter((e) => (rowsById[e.recordId] ?? []).length > 0);
  const withMismatch = compared.filter((e) => rowsById[e.recordId].some((r) => r.mismatch));
  const status = compared.length >= required && withMismatch.length === 0 ? 'VALIDATED' : withMismatch.length ? 'MISMATCHES FOUND' : 'IN PROGRESS';
  return { compared: compared.length, withMismatch: withMismatch.length, required, status };
}
