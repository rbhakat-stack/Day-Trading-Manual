import type { TradeInputs } from './tradeCalculator';
import { HHMM } from './rules';

export interface ValidationIssue {
  field: keyof TradeInputs | 'general';
  message: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Hierarchy step 1 — validate inputs. Missing or nonsensical inputs are NEVER defaulted:
 * any issue here produces INVALID INPUT and no tradeable ticket.
 */
export function validateInputs(i: TradeInputs): ValidationIssue[] {
  const errs: ValidationIssue[] = [];
  const req = (field: keyof TradeInputs, label: string) => {
    const v = i[field];
    if (!isNum(v)) errs.push({ field, message: `${label} is required.` });
    else if (v <= 0) errs.push({ field, message: `${label} must be greater than 0.` });
  };

  if (i.direction !== 'LONG' && i.direction !== 'SHORT') {
    errs.push({ field: 'direction', message: 'Select LONG or SHORT (the direction of the TrendSpider alert).' });
  }
  req('open', 'Open (O)');
  req('high', 'High (H)');
  req('low', 'Low (L)');
  req('close', 'Close (C)');
  req('atr', 'ATR(14)');
  req('currentPrice', 'Current market price');
  req('close15m', 'Last completed 15m Close');
  req('ema20_15m', 'Last completed 15m EMA20');
  req('investmentAmount', 'Maximum investment per trade');
  req('accountEquity', 'Account equity');
  if (!isNum(i.riskPct) || i.riskPct <= 0) errs.push({ field: 'riskPct', message: 'Maximum risk % must be greater than 0.' });
  else if (i.riskPct > 0.05) errs.push({ field: 'riskPct', message: 'Maximum risk % above 5% is not allowed.' });

  if (!HHMM.test(i.alertTime ?? '')) errs.push({ field: 'alertTime', message: 'Alert time is required as HH:MM (24h, Eastern Time).' });

  if (i.minutesSinceAlert !== null && i.minutesSinceAlert !== undefined) {
    if (!isNum(i.minutesSinceAlert) || i.minutesSinceAlert < 0) {
      errs.push({ field: 'minutesSinceAlert', message: 'Minutes since alert cannot be negative.' });
    }
  }

  const { open: o, high: h, low: l, close: c } = i;
  if (isNum(o) && isNum(h) && isNum(l) && isNum(c)) {
    if (h < l) errs.push({ field: 'high', message: 'High must be greater than or equal to Low.' });
    if (h < o) errs.push({ field: 'high', message: 'High must be greater than or equal to Open.' });
    if (h < c) errs.push({ field: 'high', message: 'High must be greater than or equal to Close.' });
    if (l > o) errs.push({ field: 'low', message: 'Low must be less than or equal to Open.' });
    if (l > c) errs.push({ field: 'low', message: 'Low must be less than or equal to Close.' });
  }
  return errs;
}

/**
 * Non-blocking warnings about inputs that are valid but suspicious (typos).
 * Candle direction is NOT a warning any more — it is a hard rule (rules.ts).
 */
export function inputWarnings(i: TradeInputs): string[] {
  const w: string[] = [];
  const { close: c, atr, currentPrice: p, close15m } = i;
  if (![c, atr, p].every(isNum)) return w;
  if (Math.abs(p - c) / c > 0.05) {
    w.push('Current price is more than 5% away from the signal close. Check the ticker and the numbers.');
  }
  if (atr / c > 0.05) {
    w.push('ATR is more than 5% of price — unusually large for a 5-minute ATR. Check you copied ATR from the 5-minute chart.');
  }
  if (isNum(close15m) && Math.abs(close15m - c) / c > 0.05) {
    w.push('Last completed 15m Close is more than 5% from the signal close. Check you copied it from the right chart.');
  }
  return w;
}
