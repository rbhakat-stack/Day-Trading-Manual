import type { Direction, TradeInputs } from '../engine/tradeCalculator';
import type { RbSettings } from '../engine/settings';
import { parseNum } from './format';

/** Raw text the user typed. Kept as strings so partial input ("65.") never jumps. */
export interface FormState {
  ticker: string;
  direction: Direction;
  open: string;
  high: string;
  low: string;
  close: string;
  atr: string;
  currentPrice: string;
  alertTime: string;
  close15m: string;
  ema20_15m: string;
  investmentAmount: string;
  accountEquity: string;
  riskPctDisplay: string; // percent, e.g. "0.25"
  minutesSinceAlert: string;
  hasOpenPosition: boolean;
  openPositionDirection: Direction;
}

export function emptyForm(s: RbSettings, direction: Direction = 'LONG'): FormState {
  return {
    ticker: '',
    direction,
    open: '',
    high: '',
    low: '',
    close: '',
    atr: '',
    currentPrice: '',
    alertTime: '',
    close15m: '',
    ema20_15m: '',
    investmentAmount: String(s.investmentCap),
    accountEquity: String(s.accountEquity),
    riskPctDisplay: String(+(s.riskPct * 100).toFixed(4)),
    minutesSinceAlert: '',
    hasOpenPosition: false,
    openPositionDirection: direction,
  };
}

export function formFromInputs(i: TradeInputs): FormState {
  return {
    ticker: i.ticker,
    direction: i.direction,
    open: String(i.open),
    high: String(i.high),
    low: String(i.low),
    close: String(i.close),
    atr: String(i.atr),
    currentPrice: String(i.currentPrice),
    alertTime: i.alertTime,
    close15m: String(i.close15m),
    ema20_15m: String(i.ema20_15m),
    investmentAmount: String(i.investmentAmount),
    accountEquity: String(i.accountEquity),
    riskPctDisplay: String(+(i.riskPct * 100).toFixed(4)),
    minutesSinceAlert: i.minutesSinceAlert == null ? '' : String(i.minutesSinceAlert),
    hasOpenPosition: i.hasOpenPosition,
    openPositionDirection: i.openPositionDirection ?? i.direction,
  };
}

export function toInputs(f: FormState, useMarketEntry: boolean): TradeInputs {
  const minutes = f.minutesSinceAlert.trim() === '' ? null : parseNum(f.minutesSinceAlert);
  return {
    ticker: f.ticker.trim().toUpperCase(),
    direction: f.direction,
    open: parseNum(f.open),
    high: parseNum(f.high),
    low: parseNum(f.low),
    close: parseNum(f.close),
    atr: parseNum(f.atr),
    currentPrice: parseNum(f.currentPrice),
    alertTime: f.alertTime.trim(),
    close15m: parseNum(f.close15m),
    ema20_15m: parseNum(f.ema20_15m),
    investmentAmount: parseNum(f.investmentAmount),
    accountEquity: parseNum(f.accountEquity),
    riskPct: parseNum(f.riskPctDisplay) / 100,
    minutesSinceAlert: minutes,
    hasOpenPosition: f.hasOpenPosition,
    openPositionDirection: f.hasOpenPosition ? f.openPositionDirection : null,
    useMarketEntry,
  };
}
