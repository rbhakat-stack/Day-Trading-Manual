/**
 * Alert-time snapshot builder (pure). Turns raw 5-minute bars + an alert into the FROZEN RB v1 inputs:
 * signal candle O/H/L/C, ATR(14), EMA9, EMA20, RSI14, RVOL20, VWAP and the last completed 15m Close/EMA20.
 *
 * Accuracy rules (fail closed — values are never guessed, defaulted or taken from a later candle):
 *  • Only regular-session bars (09:30–16:00 ET) are used, matching TrendSpider with Extended Hours OFF.
 *  • SIGNAL CANDLE = the 5m candle that COMPLETED most recently at the alert time (TrendSpider evaluates alerts
 *    when the 5m candle closes). Alert 10:07:30 → 10:00–10:05; alert 10:10:02 → 10:05–10:10. If that exact bar is
 *    missing, the data is INCOMPLETE (no fallback to an older bar). If the alert arrives more than
 *    `maxSignalLagSec` after that candle closed, the candle choice is AMBIGUOUS → manual review.
 *  • Indicators use bars up to and including the signal candle only (no future data).
 *  • 15m CONFIRMATION = the last fully completed regular-session 15m candle at the alert time (same function as
 *    the manual calculator: rules.lastCompleted15mCandle). 15m bars are aggregated from the 5m bars.
 */
import { lastCompleted15mCandle, toMinutes } from '../rules';
import type { Direction } from '../tradeCalculator';
import { etParts, etToEpoch } from './etTime';
import { atr, ema, rsi, rvol, vwapRolling, vwapSession, type Bar } from './indicators';
import { sessionFor, type SessionKind } from './marketCalendar';

export type VwapMode = 'SESSION' | 'ROLLING_14';

/** Indicators that may be declared optional (RB v1.2 only — SIP RVOL is diagnostic there). Nothing else can be. */
export type OptionalIndicator = 'RVOL20';

export type IssueKind =
  | 'INCOMPLETE' // required data missing → DATA INCOMPLETE — DO NOT TRADE
  | 'REVIEW'; // data present but not trustworthy enough → DATA REVIEW REQUIRED

export interface DataIssue {
  kind: IssueKind;
  code: string;
  message: string;
}

export interface SnapshotConfig {
  vwapMode: VwapMode;
  /** Max seconds between the signal candle's close and the alert time before the candle choice is ambiguous. */
  maxSignalLagSec: number;
  /** Max share of missing regular-session 5m bars (today up to the signal) before data is flagged. */
  maxMissingBarRatio: number;
  /** Minimum regular-session bars before the signal candle (indicator warm-up). */
  minWarmupBars: number;
  /**
   * RB v1.2 reconstruction only: indicators whose absence does NOT make the snapshot incomplete. A missing optional
   * indicator is returned as NaN (null after JSON storage) and its alert-condition re-check is omitted.
   * Omitted / empty = RB v1.1 behaviour: every indicator is required.
   */
  optionalIndicators?: readonly OptionalIndicator[];
}

export const DEFAULT_SNAPSHOT_CONFIG: SnapshotConfig = { vwapMode: 'SESSION', maxSignalLagSec: 120, maxMissingBarRatio: 0.05, minWarmupBars: 100 };

export interface CandleRef {
  startIso: string;
  endIso: string;
  /** HH:MM–HH:MM ET */
  label: string;
}

export interface AlertTimeValues {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  atr: number;
  ema9: number;
  ema20: number;
  rsi: number;
  rvol: number;
  vwap: number;
  /** The VWAP not selected by vwapMode (shown for parity checks). */
  vwapAlternative: number | null;
  close15m: number;
  ema20_15m: number;
}

export interface SnapshotResult {
  /** Values are null whenever any INCOMPLETE issue exists. */
  values: AlertTimeValues | null;
  signal: CandleRef | null;
  confirm15m: (CandleRef & { bars5: number }) | null;
  alertEt: string; // HH:MM:SS
  alertDate: string;
  session: SessionKind;
  sessionNote: string;
  issues: DataIssue[];
  /** Alert conditions re-checked on the automated values (consistency check against the TrendSpider alert). */
  alertConditions: { label: string; pass: boolean }[];
  barsUsed: number;
  config: SnapshotConfig;
}

const FIVE = 5 * 60_000;
const FIFTEEN = 15 * 60_000;

const label = (startMs: number, endMs: number) => `${etParts(startMs).hhmm}–${etParts(endMs).hhmm}`;
const ref = (startMs: number, endMs: number): CandleRef => ({ startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString(), label: label(startMs, endMs) });

/** Keep only regular-session 5m bars (start 09:30 ≤ t < session close) on open market days; sorted, de-duplicated. */
export function regularSessionBars(bars: Bar[]): Bar[] {
  const seen = new Set<number>();
  return bars
    .filter((b) => {
      if (seen.has(b.t) || ![b.o, b.h, b.l, b.c, b.v].every(Number.isFinite)) return false;
      seen.add(b.t);
      const p = etParts(b.t);
      const s = sessionFor(p.date);
      if (!s.open || !s.close) return s.kind === 'UNKNOWN' && p.minuteOfDay >= 570 && p.minuteOfDay < 960;
      return p.minuteOfDay >= toMinutes(s.open) && p.minuteOfDay < toMinutes(s.close);
    })
    .sort((a, b) => a.t - b.t);
}

/** Aggregate regular-session 5m bars into clock-aligned 15m bars (09:30, 09:45, …). */
export function aggregate15m(bars5: Bar[]): (Bar & { count: number; date: string })[] {
  const out: (Bar & { count: number; date: string })[] = [];
  for (const b of bars5) {
    const p = etParts(b.t);
    const open = etToEpoch(p.date, '09:30');
    const start = open + Math.floor((b.t - open) / FIFTEEN) * FIFTEEN;
    const last = out[out.length - 1];
    if (last && last.t === start) {
      last.h = Math.max(last.h, b.h);
      last.l = Math.min(last.l, b.l);
      last.c = b.c;
      last.v += b.v;
      last.count += 1;
    } else {
      out.push({ t: start, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, count: 1, date: p.date });
    }
  }
  return out;
}

export function buildAlertSnapshot(rawBars5: Bar[], alertMs: number, direction: Direction, config: SnapshotConfig = DEFAULT_SNAPSHOT_CONFIG): SnapshotResult {
  const issues: DataIssue[] = [];
  const inc = (code: string, message: string) => issues.push({ kind: 'INCOMPLETE', code, message });
  const rev = (code: string, message: string) => issues.push({ kind: 'REVIEW', code, message });
  const ap = etParts(alertMs);
  const session = sessionFor(ap.date);
  const base = { alertEt: ap.hhmmss, alertDate: ap.date, session: session.kind, sessionNote: session.note, config };
  const empty = (): SnapshotResult => ({ ...base, values: null, signal: null, confirm15m: null, issues, alertConditions: [], barsUsed: 0 });

  if (session.kind === 'UNKNOWN') rev('CALENDAR_UNAVAILABLE', session.note);
  if (session.kind === 'HOLIDAY' || session.kind === 'WEEKEND') rev('MARKET_CLOSED_DAY', session.note);
  if (session.kind === 'EARLY_CLOSE') rev('EARLY_CLOSE_SESSION', session.note);

  // ── signal candle: the 5m candle that completed most recently at the alert time ──
  const open = etToEpoch(ap.date, '09:30');
  const slotsDone = Math.floor((alertMs - open) / FIVE); // completed 5m candles since the open
  if (slotsDone < 1) {
    inc('NO_COMPLETED_SIGNAL_CANDLE', `No regular-session 5m candle had completed at ${ap.hhmmss} ET.`);
    return empty();
  }
  const sigStart = open + (slotsDone - 1) * FIVE;
  const sigEnd = sigStart + FIVE;
  const signal = ref(sigStart, sigEnd);
  const lagSec = (alertMs - sigEnd) / 1000;
  if (lagSec > config.maxSignalLagSec) {
    rev('SIGNAL_CANDLE_AMBIGUOUS', `Alert ${ap.hhmmss} ET arrived ${Math.round(lagSec)} s after the ${signal.label} candle closed (limit ${config.maxSignalLagSec} s). The signal candle cannot be identified with certainty.`);
  }

  const bars = regularSessionBars(rawBars5).filter((b) => b.t + FIVE <= alertMs); // completed bars only — never a later or forming candle
  const sigIndex = bars.findIndex((b) => b.t === sigStart);
  if (sigIndex < 0) {
    inc('SIGNAL_CANDLE_MISSING', `The ${signal.label} ET 5-minute candle is missing from the market-data response.`);
    return { ...empty(), signal };
  }
  const upto = bars.slice(0, sigIndex + 1);
  const s = upto[sigIndex];

  // gaps today (regular session, up to the signal candle)
  const today = upto.filter((b) => etParts(b.t).date === ap.date).length;
  const missing = slotsDone - today;
  if (missing / slotsDone > config.maxMissingBarRatio) {
    rev('MISSING_BARS', `${missing} of ${slotsDone} regular-session 5m bars today are missing (limit ${(config.maxMissingBarRatio * 100).toFixed(0)}%). Indicators may differ from TrendSpider.`);
  }
  if (sigIndex + 1 < config.minWarmupBars) {
    inc('INSUFFICIENT_HISTORY', `Only ${sigIndex + 1} regular-session 5m bars available (need ≥ ${config.minWarmupBars} for indicator warm-up).`);
  }

  const closes = upto.map((b) => b.c);
  const e9 = ema(closes, 9)[sigIndex];
  const e20 = ema(closes, 20)[sigIndex];
  const r = rsi(closes, 14)[sigIndex];
  const a = atr(upto, 14)[sigIndex];
  const rv = rvol(upto.map((b) => b.v), 20)[sigIndex];
  const vs = vwapSession(upto, (b) => etParts(b.t).date)[sigIndex];
  const vr = vwapRolling(upto, 14)[sigIndex];
  const vw = config.vwapMode === 'SESSION' ? vs : vr;
  const need: [number | null, string][] = [[e9, 'EMA9'], [e20, 'EMA20'], [r, 'RSI14'], [a, 'ATR14'], [rv, 'RVOL20'], [vw, 'VWAP']];
  const optional: readonly string[] = config.optionalIndicators ?? [];
  const unavailable = (v: number | null, name: string) => v === null || !Number.isFinite(v) || (name !== 'RSI14' && v <= 0);
  for (const [v, name] of need) if (unavailable(v, name) && !optional.includes(name)) inc(`${name}_UNAVAILABLE`, `${name} could not be calculated from the available bars.`);
  const rvolOk = !unavailable(rv, 'RVOL20');
  if (!(s.h >= s.l && s.h >= Math.max(s.o, s.c) && s.l <= Math.min(s.o, s.c) && s.l > 0)) inc('SIGNAL_CANDLE_INVALID', 'Signal candle OHLC is internally inconsistent.');

  // ── 15m confirmation: last fully completed regular-session 15m candle at the alert time ──
  let confirm15m: SnapshotResult['confirm15m'] = null;
  let close15m: number | null = null;
  let ema20_15m: number | null = null;
  const c15 = lastCompleted15mCandle(ap.hhmm);
  if (!c15) {
    inc('NO_COMPLETED_15M', `No regular-session 15m candle had completed at ${ap.hhmmss} ET.`);
  } else {
    const st = etToEpoch(ap.date, c15.start);
    const en = st + FIFTEEN;
    const agg = aggregate15m(bars).filter((x) => x.t + FIFTEEN <= alertMs);
    const i15 = agg.findIndex((x) => x.t === st);
    if (i15 < 0) {
      inc('CONFIRM_15M_MISSING', `The ${c15.start}–${c15.end} ET 15-minute candle is missing.`);
    } else {
      confirm15m = { ...ref(st, en), bars5: agg[i15].count };
      if (agg[i15].count < 3) rev('CONFIRM_15M_PARTIAL', `The ${confirm15m.label} 15m candle was built from ${agg[i15].count} of 3 five-minute bars.`);
      close15m = agg[i15].c;
      ema20_15m = ema(agg.slice(0, i15 + 1).map((x) => x.c), 20)[i15];
      if (ema20_15m === null) inc('EMA20_15M_UNAVAILABLE', '15m EMA20 could not be calculated (not enough 15m history).');
    }
  }

  const complete = !issues.some((i) => i.kind === 'INCOMPLETE');
  const values: AlertTimeValues | null = complete
    ? {
        open: s.o, high: s.h, low: s.l, close: s.c, volume: s.v,
        atr: a as number, ema9: e9 as number, ema20: e20 as number, rsi: r as number, rvol: rvolOk ? (rv as number) : Number.NaN, vwap: vw as number,
        vwapAlternative: config.vwapMode === 'SESSION' ? vr : vs,
        close15m: close15m as number, ema20_15m: ema20_15m as number,
      }
    : null;

  // The TrendSpider alert said these were true. If the automated values disagree, the feeds differ → review.
  const L = direction === 'LONG';
  const alertConditions = values
    ? [
        { label: `5m Close ${L ? '>' : '<'} VWAP`, pass: L ? values.close > values.vwap : values.close < values.vwap },
        { label: `EMA9 ${L ? '>' : '<'} EMA20`, pass: L ? values.ema9 > values.ema20 : values.ema9 < values.ema20 },
        { label: `RSI14 ${L ? '> 55' : '< 45'}`, pass: L ? values.rsi > 55 : values.rsi < 45 },
        ...(rvolOk ? [{ label: 'RVOL20 > 1.5', pass: values.rvol > 1.5 }] : []),
        { label: `Close ${L ? '>' : '<'} Open`, pass: L ? values.close > values.open : values.close < values.open },
        { label: `15m Close ${L ? '>' : '<'} 15m EMA20`, pass: L ? values.close15m > values.ema20_15m : values.close15m < values.ema20_15m },
      ]
    : [];
  const failed = alertConditions.filter((c) => !c.pass).map((c) => c.label);
  if (failed.length) {
    rev('ALERT_NOT_REPRODUCED', `TrendSpider fired the ${direction} alert, but the automated values do not satisfy: ${failed.join('; ')}. Data feeds or indicator settings may differ.`);
  }

  return { ...base, values, signal, confirm15m, issues, alertConditions, barsUsed: upto.length };
}
