/** Deterministic synthetic regular-session 5-minute bars for automation tests. */
import { etToEpoch } from '../etTime';
import type { Bar } from '../indicators';
import { previousTradingDates } from '../marketCalendar';
import type { AutoAlertRecord } from '../alertDecision';
import type { AlertTimeValues, SnapshotResult } from '../alertSnapshot';
import { DEFAULT_SNAPSHOT_CONFIG } from '../alertSnapshot';

export const FIVE = 5 * 60_000;

/** Uptrend with alternating +0.06 / −0.03 closes (RSI ≈ 66.7), 78 bars per session. */
export const upPrice = (i: number) => 100 + 0.015 * i + (i % 2 ? 0.045 : 0);

export function sessionBars(dates: string[], opts: { untilEt?: string; price?: (i: number) => number; vol?: (i: number) => number } = {}): Bar[] {
  const price = opts.price ?? upPrice;
  const vol = opts.vol ?? ((i: number) => 10_000 + (i % 7) * 1_000);
  const out: Bar[] = [];
  let i = 0;
  dates.forEach((d, di) => {
    const open = etToEpoch(d, '09:30');
    const until = di === dates.length - 1 && opts.untilEt ? etToEpoch(d, opts.untilEt) : etToEpoch(d, '16:00');
    for (let t = open; t < until; t += FIVE) {
      const o = price(i - 1 < 0 ? 0 : i - 1);
      const c = price(i);
      out.push({ t, o, h: Math.max(o, c) + 0.03, l: Math.min(o, c) - 0.03, c, v: vol(i) });
      i++;
    }
  });
  return out;
}

/** The alert day plus N previous trading days, oldest first. */
export const daysUpTo = (date: string, n = 5) => [...previousTradingDates(date, n).reverse(), date];

/** A minimal OK record with given alert-time values (for decision / calculator tests that do not need bars). */
export function recordWith(o: { symbol: string; direction: 'LONG' | 'SHORT'; alertIso: string; values: Partial<AlertTimeValues>; lastPrice?: number | null; price?: number; receivedMs?: number; issues?: SnapshotResult['issues'] }): AutoAlertRecord {
  const alertMs = Date.parse(o.alertIso);
  const values: AlertTimeValues = {
    open: 100, high: 101, low: 100, close: 101, volume: 50000, atr: 1, ema9: 100.7, ema20: 100.1, rsi: 67, rvol: 4, vwap: 100.3, vwapAlternative: null, close15m: 101, ema20_15m: 100,
    ...o.values,
  };
  return {
    id: `${o.symbol}-${o.direction[0]}-${alertMs}`,
    dedupeKey: `${o.symbol}|${o.direction}|${Math.floor(alertMs / 1000)}|RB`,
    receivedIso: new Date(o.receivedMs ?? alertMs + 2000).toISOString(),
    receivedMs: o.receivedMs ?? alertMs + 2000,
    status: 'OK',
    alert: { strategy: 'RB_V1', symbol: o.symbol, direction: o.direction, alertName: `RB v1 ${o.direction} Setup`, alertTimeMs: alertMs, alertTimeIso: new Date(alertMs).toISOString(), timeSource: 'PAYLOAD', lastPrice: o.lastPrice ?? null },
    payload: {},
    snapshot: {
      values, signal: { startIso: '', endIso: '', label: '' }, confirm15m: { startIso: '', endIso: '', label: '', bars5: 3 }, alertEt: '', alertDate: '', session: 'FULL', sessionNote: '',
      issues: o.issues ?? [], alertConditions: [], barsUsed: 400, config: DEFAULT_SNAPSHOT_CONFIG,
    },
    provider: { name: 'Alpaca', feed: 'sip', host: 'data.alpaca.markets' },
    marketDataThroughIso: null,
    initialQuote: { price: o.price ?? values.close, tradeIso: new Date(alertMs).toISOString(), fetchedIso: new Date(alertMs + 1000).toISOString() },
    calcAtAlert: null,
    sameTickerEarlier: [],
    errors: [],
    attempts: 1,
    versions: { rules: 'RB v1.1', scoring: 'RB v1.1', strategy: 'RB v1.1' },
    processedIso: null,
  };
}
