/**
 * Indicator definitions for the automated alert path (pure functions, arrays aligned with the input bars;
 * `null` until enough history exists — never 0).
 *
 * These are the standard definitions RB v1 uses. They are "Automated Market Data Values": TrendSpider's exact
 * implementation (seeding, smoothing, data feed) is not published, so parity must be checked in Data Validation.
 *
 *   EMA(n)   α = 2 / (n + 1), seeded with the SMA of the first n closes, then EMA_t = α·C_t + (1 − α)·EMA_{t−1}
 *   RSI(14)  Wilder: first average gain/loss = SMA of the first 14 changes, then RMA (α = 1/14)
 *   ATR(14)  Wilder: TR = MAX(H − L, |H − C_prev|, |L − C_prev|); first ATR = SMA of the first 14 TR, then RMA
 *   RVOL(20) Volume_t ÷ SMA(Volume, 20) including the current bar (TrendSpider "Relative Volume", Length 20, SMA, Base 1)
 *   VWAP     HLC3 = (H + L + C) ÷ 3.
 *            SESSION: Σ(HLC3·V) ÷ ΣV from the first regular-session bar of the day (standard session VWAP).
 *            ROLLING_14: the same over the last 14 bars (one possible reading of TrendSpider's "VWAP(14, 0, HLC3)").
 *            Which one TrendSpider displays is an open VERIFY item (manual Ch. 3): the parity screen decides.
 */

export interface Bar {
  /** Bar START, epoch ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Series = (number | null)[];

export function sma(xs: number[], n: number): Series {
  const out: Series = new Array(xs.length).fill(null);
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i];
    if (i >= n) sum -= xs[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(xs: number[], n: number): Series {
  const out: Series = new Array(xs.length).fill(null);
  if (xs.length < n) return out;
  const a = 2 / (n + 1);
  let prev = xs.slice(0, n).reduce((s, x) => s + x, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < xs.length; i++) {
    prev = a * xs[i] + (1 - a) * prev;
    out[i] = prev;
  }
  return out;
}

/** Wilder's RMA seeded with an SMA of the first n values. */
function rma(xs: number[], n: number, startIndex = 0): Series {
  const out: Series = new Array(xs.length).fill(null);
  if (xs.length - startIndex < n) return out;
  let prev = xs.slice(startIndex, startIndex + n).reduce((s, x) => s + x, 0) / n;
  out[startIndex + n - 1] = prev;
  for (let i = startIndex + n; i < xs.length; i++) {
    prev = (prev * (n - 1) + xs[i]) / n;
    out[i] = prev;
  }
  return out;
}

export function rsi(closes: number[], n = 14): Series {
  const out: Series = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  const gains: number[] = [0];
  const losses: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(0, d));
    losses.push(Math.max(0, -d));
  }
  const ag = rma(gains, n, 1);
  const al = rma(losses, n, 1);
  for (let i = 0; i < closes.length; i++) {
    const g = ag[i];
    const l = al[i];
    if (g === null || l === null) continue;
    out[i] = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
  }
  return out;
}

export function trueRange(bars: Bar[]): number[] {
  return bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c))));
}

export function atr(bars: Bar[], n = 14): Series {
  return rma(trueRange(bars), n);
}

export function rvol(volumes: number[], n = 20): Series {
  const avg = sma(volumes, n);
  return volumes.map((v, i) => (avg[i] !== null && (avg[i] as number) > 0 ? v / (avg[i] as number) : null));
}

const hlc3 = (b: Bar) => (b.h + b.l + b.c) / 3;

/** Session VWAP. `sessionKey(bar)` returns the trading date; the sum restarts at each new date. */
export function vwapSession(bars: Bar[], sessionKey: (b: Bar) => string): Series {
  const out: Series = new Array(bars.length).fill(null);
  let key = '';
  let pv = 0;
  let vol = 0;
  bars.forEach((b, i) => {
    const k = sessionKey(b);
    if (k !== key) {
      key = k;
      pv = 0;
      vol = 0;
    }
    pv += hlc3(b) * b.v;
    vol += b.v;
    out[i] = vol > 0 ? pv / vol : null;
  });
  return out;
}

export function vwapRolling(bars: Bar[], n = 14): Series {
  const out: Series = new Array(bars.length).fill(null);
  for (let i = n - 1; i < bars.length; i++) {
    let pv = 0;
    let vol = 0;
    for (let j = i - n + 1; j <= i; j++) {
      pv += hlc3(bars[j]) * bars[j].v;
      vol += bars[j].v;
    }
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}
