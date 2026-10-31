/**
 * RB v1.2 — SIP parity diagnostics for TrendSpider-qualified conditions (RB_V1_2_ARCHITECTURE.md §6).
 *
 * TrendSpider qualifies; SIP reconstructs; SIP does NOT re-qualify. Each RB condition re-evaluated on SIP data is
 * classified, with the existing Automation-settings parity tolerances (unchanged):
 *   AGREE      SIP reaches the same verdict as TrendSpider (the alert fired, so TrendSpider's verdict is "passed")
 *   KNIFE_EDGE SIP disagrees but is within tolerance of the threshold → neutral note
 *   DISAGREE   SIP disagrees beyond that margin → PARITY WARNING (non-blocking)
 * RVOL is always DIAGNOSTIC_ONLY (Phase 2: ~17–20% expected disagreement). Missing SIP inputs are UNAVAILABLE (note).
 * Nothing here can block, hold or de-qualify an alert: the output is diagnostics and warning codes only.
 */
import type { ParityTolerance } from '../alertDecision';
import { aggregate15m, regularSessionBars } from '../alertSnapshot';
import { etParts } from '../etTime';
import { ema, type Bar } from '../indicators';
import type { Direction } from '../../tradeCalculator';

export type ConditionKey = 'CLOSE_VS_VWAP' | 'EMA9_VS_EMA20' | 'RSI' | 'CANDLE_DIRECTION' | 'RVOL' | 'CONFIRM_15M' | 'CONFIRM_15M_FORMING';
export type ParityClass = 'AGREE' | 'KNIFE_EDGE' | 'DISAGREE' | 'DIAGNOSTIC_ONLY' | 'UNAVAILABLE';

export interface ConditionDiagnostic {
  rule: ConditionKey;
  label: string;
  /** The SIP quantity compared (e.g. Close − VWAP, RSI, RVOL); null when unavailable. */
  sipValue: number | null;
  threshold: number | null;
  sipPass: boolean | null;
  /** Distance of the SIP quantity from the threshold, in the quantity's units. */
  margin: number | null;
  /** Knife-edge tolerance applied (same units as margin). */
  tolerance: number | null;
  class: ParityClass;
}

export interface SipConditionInputs {
  open: number | null;
  close: number | null;
  vwap: number | null;
  ema9: number | null;
  ema20: number | null;
  rsi: number | null;
  rvol: number | null;
  close15m: number | null;
  ema20_15m: number | null;
}

export interface Forming15m {
  label: string;
  close: number;
  ema20: number | null;
  /** 5m bars in the 15m bucket at the signal close; 3 = the bucket just completed. */
  bars5: number;
}

export interface ParityResult {
  diagnostics: ConditionDiagnostic[];
  /** Warning / note codes: PARITY_WARNING:<rule> · PARITY_NOTE_KNIFE_EDGE:<rule> · SIP_UNAVAILABLE:<rule> · SIP_RVOL_DIAGNOSTIC_ONLY */
  warnings: string[];
}

const num = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

function classify(rule: ConditionKey, label: string, sipValue: number | null, threshold: number | null, sipPass: boolean | null, margin: number | null, tolerance: number | null): ConditionDiagnostic {
  if (sipPass === null || margin === null) return { rule, label, sipValue, threshold, sipPass: null, margin: null, tolerance, class: 'UNAVAILABLE' };
  const cls: ParityClass = sipPass ? 'AGREE' : margin <= (tolerance ?? 0) + 1e-12 ? 'KNIFE_EDGE' : 'DISAGREE';
  return { rule, label, sipValue, threshold, sipPass, margin, tolerance, class: cls };
}

/**
 * Classify every TrendSpider-qualified condition against SIP values for an alert that FIRED in `direction`.
 * `forming` (optional) adds the forming-15m comparison used to learn TrendSpider's larger-timeframe semantics.
 */
export function classifyConditions(v: SipConditionInputs, direction: Direction, tol: ParityTolerance, forming?: Forming15m | null): ParityResult {
  const L = direction === 'LONG';
  const out: ConditionDiagnostic[] = [];
  const { open, close, vwap, ema9, ema20, rsi, rvol, close15m, ema20_15m } = v;

  out.push(num(close) && num(vwap)
    ? classify('CLOSE_VS_VWAP', `5m Close ${L ? '>' : '<'} VWAP`, close - vwap, 0, L ? close > vwap : close < vwap, Math.abs(close - vwap), tol.vwapPct * close)
    : classify('CLOSE_VS_VWAP', `5m Close ${L ? '>' : '<'} VWAP`, null, 0, null, null, null));
  out.push(num(ema9) && num(ema20) && num(close)
    ? classify('EMA9_VS_EMA20', `EMA9 ${L ? '>' : '<'} EMA20`, ema9 - ema20, 0, L ? ema9 > ema20 : ema9 < ema20, Math.abs(ema9 - ema20), tol.emaPct * close)
    : classify('EMA9_VS_EMA20', `EMA9 ${L ? '>' : '<'} EMA20`, null, 0, null, null, null));
  const thr = L ? 55 : 45;
  out.push(num(rsi)
    ? classify('RSI', `RSI14 ${L ? '>' : '<'} ${thr}`, rsi, thr, L ? rsi > thr : rsi < thr, Math.abs(rsi - thr), tol.rsiPts)
    : classify('RSI', `RSI14 ${L ? '>' : '<'} ${thr}`, null, thr, null, null, null));
  out.push(num(open) && num(close)
    ? classify('CANDLE_DIRECTION', `Close ${L ? '>' : '<'} Open`, close - open, 0, L ? close > open : close < open, Math.abs(close - open), tol.priceAbs)
    : classify('CANDLE_DIRECTION', `Close ${L ? '>' : '<'} Open`, null, 0, null, null, null));
  out.push(num(rvol)
    ? { rule: 'RVOL', label: 'RVOL20 > 1.5 (SIP, diagnostic only)', sipValue: rvol, threshold: 1.5, sipPass: rvol > 1.5, margin: Math.abs(rvol - 1.5), tolerance: null, class: 'DIAGNOSTIC_ONLY' }
    : { rule: 'RVOL', label: 'RVOL20 > 1.5 (SIP, diagnostic only)', sipValue: null, threshold: 1.5, sipPass: null, margin: null, tolerance: null, class: 'UNAVAILABLE' });
  out.push(num(close15m) && num(ema20_15m)
    ? classify('CONFIRM_15M', `Completed 15m Close ${L ? '>' : '<'} 15m EMA20`, close15m - ema20_15m, 0, L ? close15m > ema20_15m : close15m < ema20_15m, Math.abs(close15m - ema20_15m), tol.emaPct * close15m)
    : classify('CONFIRM_15M', `Completed 15m Close ${L ? '>' : '<'} 15m EMA20`, null, 0, null, null, null));
  if (forming !== undefined) {
    const f = forming;
    out.push(f && num(f.ema20)
      ? classify('CONFIRM_15M_FORMING', `Forming 15m (${f.label}) Close ${L ? '>' : '<'} 15m EMA20`, f.close - f.ema20, 0, L ? f.close > f.ema20 : f.close < f.ema20, Math.abs(f.close - f.ema20), tol.emaPct * f.close)
      : classify('CONFIRM_15M_FORMING', 'Forming 15m Close vs 15m EMA20', null, 0, null, null, null));
  }

  const warnings: string[] = [];
  for (const d of out) {
    if (d.class === 'DISAGREE') warnings.push(`PARITY_WARNING:${d.rule}`);
    else if (d.class === 'KNIFE_EDGE') warnings.push(`PARITY_NOTE_KNIFE_EDGE:${d.rule}`);
    else if (d.class === 'UNAVAILABLE') warnings.push(`SIP_UNAVAILABLE:${d.rule}`);
  }
  warnings.push('SIP_RVOL_DIAGNOSTIC_ONLY');
  return { diagnostics: out, warnings };
}

/**
 * The 15m bucket containing the signal close, built only from regular-session 5m bars that ended at or before
 * `signalEndMs` (no later data), with EMA20 over 15m closes including that bucket. When the signal close is on a 15m
 * boundary the bucket is the one that just completed (bars5 = 3); otherwise it is still forming.
 */
export function forming15m(bars5: Bar[], signalEndMs: number): Forming15m | null {
  const done = regularSessionBars(bars5).filter((b) => b.t + 5 * 60_000 <= signalEndMs);
  const agg = aggregate15m(done);
  if (!agg.length) return null;
  const i = agg.length - 1;
  const last = agg[i];
  const e = ema(agg.map((x) => x.c), 20)[i];
  return { label: `${etParts(last.t).hhmm}–${etParts(last.t + 15 * 60_000).hhmm}`, close: last.c, ema20: e, bars5: last.count };
}
