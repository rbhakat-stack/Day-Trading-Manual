/**
 * RB v1.1 — THE central hard-rule hierarchy.
 *
 * Every hard rule lives here and is reused by the Trade Calculator, the Opportunity
 * Ranker, the Journal and the Dashboard. A hard-rule failure overrides score, rank,
 * capital availability, diversification and arrival order. Nothing else may
 * re-implement these checks.
 *
 * Product principle: "mathematically calculable" ≠ "eligible to trade".
 * When in doubt, prefer DO NOT TRADE (false negatives over false positives).
 */
import type { Direction } from './tradeCalculator';

export const RULES_VERSION = 'RB v1.1';
export const SCORING_VERSION = 'RB v1.1';

/** Regular session (ET). Fixed by the exchange, not a setting. */
export const SESSION_OPEN = '09:30';
export const SESSION_CLOSE = '16:00';

export type HardFailCode =
  | 'INVALID_INPUT'
  | 'EXISTING_SAME_TICKER_POSITION'
  | 'INVALID_CANDLE_DIRECTION'
  | 'AFTER_HOURS'
  | 'OUTSIDE_ENTRY_WINDOW'
  | 'HTF_CONFIRMATION_FAILED'
  | 'INVALID_TRADE_STRUCTURE'
  | 'RISK_LIMIT'
  | 'SETUP_FAILED'
  | 'STALE_SETUP'
  | 'CHASED_SETUP'
  | 'NO_POSITION_SLOT'
  | 'CAPITAL_LIMIT'
  | 'PORTFOLIO_HEAT_LIMIT'
  | 'CORRELATION_LIMIT';

/** When several rules fail, the first one in this list is the headline; all are listed. */
export const HARD_FAIL_PRIORITY: HardFailCode[] = [
  'INVALID_INPUT',
  'EXISTING_SAME_TICKER_POSITION',
  'INVALID_CANDLE_DIRECTION',
  'AFTER_HOURS',
  'OUTSIDE_ENTRY_WINDOW',
  'HTF_CONFIRMATION_FAILED',
  'INVALID_TRADE_STRUCTURE',
  'RISK_LIMIT',
  'SETUP_FAILED',
  'STALE_SETUP',
  'CHASED_SETUP',
  'NO_POSITION_SLOT',
  'CAPITAL_LIMIT',
  'PORTFOLIO_HEAT_LIMIT',
  'CORRELATION_LIMIT',
];

/** Default UI label per code (some rules use a more specific label, e.g. LONG vs SHORT). */
export const HARD_FAIL_LABELS: Record<HardFailCode, string> = {
  INVALID_INPUT: 'INVALID INPUT',
  EXISTING_SAME_TICKER_POSITION: 'DO NOT ADD — POSITION/ORDER ALREADY EXISTS',
  INVALID_CANDLE_DIRECTION: 'NOT ELIGIBLE — SIGNAL CANDLE INVALID',
  AFTER_HOURS: 'NOT ELIGIBLE — AFTER REGULAR SESSION',
  OUTSIDE_ENTRY_WINDOW: 'NOT ELIGIBLE — OUTSIDE ENTRY WINDOW',
  HTF_CONFIRMATION_FAILED: 'NOT ELIGIBLE — 15M TREND CONFIRMATION FAILED',
  INVALID_TRADE_STRUCTURE: 'INVALID TRADE STRUCTURE',
  RISK_LIMIT: 'NOT ELIGIBLE — RISK ABOVE PER-TRADE MAXIMUM',
  SETUP_FAILED: 'NOT ELIGIBLE — SETUP FAILED',
  STALE_SETUP: 'NOT ELIGIBLE — STALE SETUP',
  CHASED_SETUP: 'NOT ELIGIBLE — DO NOT CHASE',
  NO_POSITION_SLOT: 'BLOCKED — NO POSITION SLOT',
  CAPITAL_LIMIT: 'BLOCKED — CAPITAL',
  PORTFOLIO_HEAT_LIMIT: 'BLOCKED — PORTFOLIO HEAT',
  CORRELATION_LIMIT: 'BLOCKED — CORRELATED EXPOSURE',
};

/** Portfolio rules depend on the current portfolio; strategy rules depend only on the setup itself. */
export const PORTFOLIO_CODES: HardFailCode[] = ['NO_POSITION_SLOT', 'CAPITAL_LIMIT', 'PORTFOLIO_HEAT_LIMIT', 'CORRELATION_LIMIT'];
export const isPortfolioCode = (c: HardFailCode) => PORTFOLIO_CODES.includes(c);

export interface HardFail {
  code: HardFailCode;
  label: string;
  reason: string;
}

export const fail = (code: HardFailCode, reason: string, label = HARD_FAIL_LABELS[code]): HardFail => ({ code, label, reason });

/** Sort by priority; the first element is the headline failure. */
export function sortFails(fails: HardFail[]): HardFail[] {
  return [...fails].sort((a, b) => HARD_FAIL_PRIORITY.indexOf(a.code) - HARD_FAIL_PRIORITY.indexOf(b.code));
}

/* ───────────────────────── time helpers ───────────────────────── */

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function toMinutes(hhmm: string): number {
  return HHMM.test(hhmm ?? '') ? Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) : NaN;
}

export function fromMinutes(m: number): string {
  const x = Math.max(0, Math.min(24 * 60 - 1, Math.floor(m)));
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
}

export function addMinutes(hhmm: string, minutes: number): string {
  return fromMinutes(toMinutes(hhmm) + minutes);
}

/* ───────────────────────── hard rules ───────────────────────── */

export interface EntryWindow {
  entryWindowStart: string; // RB v1: 09:45 — earlier = TOO EARLY
  entryWindowEnd: string; // RB v1: 15:30 — at/after = NEW ENTRY WINDOW CLOSED
}

/**
 * Time window (ET, HH:MM minute resolution):
 *   < 09:30 or ≥ 16:00         → AFTER_HOURS         (outside the regular session)
 *   09:30 ≤ t < 09:45          → OUTSIDE_ENTRY_WINDOW (TOO EARLY)
 *   09:45 ≤ t < 15:30          → eligible
 *   15:30 ≤ t < 16:00          → OUTSIDE_ENTRY_WINDOW (NEW ENTRY WINDOW CLOSED)
 * 15:30 itself is treated as closed: an "HH:MM" of 15:30 can be up to 15:30:59, i.e. after 3:30 PM.
 */
export function checkTimeWindow(time: string, w: EntryWindow, what = 'Alert'): HardFail | null {
  const t = toMinutes(time);
  if (!Number.isFinite(t)) return fail('INVALID_INPUT', `${what} time must be HH:MM (24h, ET).`);
  if (t >= toMinutes(SESSION_CLOSE)) {
    return fail('AFTER_HOURS', `${what} time ${time} ET is at or after the 16:00 ET close. RB v1 trades only the regular session.`, 'NOT ELIGIBLE — AFTER REGULAR SESSION');
  }
  if (t < toMinutes(SESSION_OPEN)) {
    return fail('AFTER_HOURS', `${what} time ${time} ET is before the 09:30 ET open. RB v1 trades only the regular session.`, 'NOT ELIGIBLE — BEFORE REGULAR SESSION');
  }
  if (t < toMinutes(w.entryWindowStart)) {
    return fail('OUTSIDE_ENTRY_WINDOW', `${what} time ${time} ET is before ${w.entryWindowStart} ET. Initial market volatility is intentionally excluded from RB v1.`, 'NOT ELIGIBLE — TOO EARLY');
  }
  if (t >= toMinutes(w.entryWindowEnd)) {
    return fail('OUTSIDE_ENTRY_WINDOW', `${what} time ${time} ET is at or after ${w.entryWindowEnd} ET. No new RB v1 positions are initiated after ${w.entryWindowEnd}.`, 'NOT ELIGIBLE — NEW ENTRY WINDOW CLOSED');
  }
  return null;
}

/** RB v1 alert logic: LONG requires Close > Open; SHORT requires Close < Open. A doji fails both. */
export function checkCandleDirection(direction: Direction, open: number, close: number): HardFail | null {
  if (direction === 'LONG' && !(close > open)) {
    return fail('INVALID_CANDLE_DIRECTION', `RB v1 LONG requires Close > Open (Close ${close} ≤ Open ${open}).`, 'NOT ELIGIBLE — LONG SIGNAL CANDLE INVALID');
  }
  if (direction === 'SHORT' && !(close < open)) {
    return fail('INVALID_CANDLE_DIRECTION', `RB v1 SHORT requires Close < Open (Close ${close} ≥ Open ${open}).`, 'NOT ELIGIBLE — SHORT SIGNAL CANDLE INVALID');
  }
  return null;
}

/** Higher-timeframe confirmation on the LAST COMPLETED 15m candle: LONG close > EMA20; SHORT close < EMA20. */
export function check15mConfirmation(direction: Direction, close15: number, ema20_15: number): HardFail | null {
  if (direction === 'LONG' && !(close15 > ema20_15)) {
    return fail('HTF_CONFIRMATION_FAILED', `LONG requires last completed 15m Close > 15m EMA20 (${close15} ≤ ${ema20_15}).`);
  }
  if (direction === 'SHORT' && !(close15 < ema20_15)) {
    return fail('HTF_CONFIRMATION_FAILED', `SHORT requires last completed 15m Close < 15m EMA20 (${close15} ≥ ${ema20_15}).`);
  }
  return null;
}

/** LONG: Stop < Entry < Target; SHORT: Target < Entry < Stop. */
export function checkStructure(direction: Direction, stop: number, entry: number, target: number, shares: number): HardFail | null {
  const ok = direction === 'LONG' ? stop < entry && entry < target : target < entry && entry < stop;
  if (!ok || !(target > 0)) {
    return fail('INVALID_TRADE_STRUCTURE', direction === 'LONG' ? 'Required: Stop < Entry < Take Profit.' : 'Required: Take Profit < Entry < Stop.');
  }
  if (!(shares >= 1)) return fail('INVALID_INPUT', 'Position size rounds down to 0 shares. Increase the investment cap or risk %, or skip this trade.', 'NOT ELIGIBLE — POSITION SIZE IS 0 SHARES');
  return null;
}

/** Chase: only measured after the trigger is crossed. More than the threshold (ATR) past entry = CHASED. */
export function checkChase(crossed: boolean, distanceAtr: number, thresholdAtr: number): HardFail | null {
  if (crossed && distanceAtr > thresholdAtr) {
    return fail('CHASED_SETUP', `Price is ${distanceAtr.toFixed(2)} ATR beyond the planned entry (limit ${thresholdAtr} ATR). Do not convert to Market, Limit or Pullback.`);
  }
  return null;
}

/** Stale: the trigger has NOT been crossed and more than the waiting period has elapsed since the alert. */
export function checkStale(crossed: boolean, minutesSinceAlert: number | null | undefined, maxMinutes: number): HardFail | null {
  if (!crossed && minutesSinceAlert !== null && minutesSinceAlert !== undefined && minutesSinceAlert > maxMinutes) {
    return fail('STALE_SETUP', `${minutesSinceAlert} minutes without a trigger (limit ${maxMinutes} min ≈ ${Math.round(maxMinutes / 5)} five-minute candles).`);
  }
  return null;
}

/** Setup failed: price has already traded through the planned stop before entry. */
export function checkSetupFailed(direction: Direction, currentPrice: number, stop: number): HardFail | null {
  const failed = direction === 'LONG' ? currentPrice <= stop : currentPrice >= stop;
  return failed
    ? fail('SETUP_FAILED', `Price ${currentPrice} is already ${direction === 'LONG' ? 'at or below' : 'at or above'} the planned stop ${stop}. The original ${direction} setup has failed. Do not enter.`)
    : null;
}

/* ───────────────────────── 15-minute candle reference ───────────────────────── */

/**
 * The last fully COMPLETED regular-session 15-minute candle at a given alert time.
 * 15m candles start at 09:30, 09:45, 10:00 … 15:45; a candle is complete at its end time.
 *   10:07 → 09:45–10:00 · 10:18 → 10:00–10:15 · 14:52 → 14:30–14:45 · 15:29 → 15:00–15:15
 * Returns null before 09:45 (no completed regular-session 15m candle yet) or for invalid times.
 */
export function lastCompleted15mCandle(alertTime: string): { start: string; end: string } | null {
  const t = toMinutes(alertTime);
  const open = toMinutes(SESSION_OPEN);
  const close = toMinutes(SESSION_CLOSE);
  if (!Number.isFinite(t) || t < open + 15) return null;
  const end = Math.min(close, open + Math.floor((t - open) / 15) * 15);
  return { start: fromMinutes(end - 15), end: fromMinutes(end) };
}

export const LAST_15M_HELP =
  'Use the last completed regular-session 15-minute candle at the alert time — not the still-forming candle, not a post-market candle, and not a later candle.';
