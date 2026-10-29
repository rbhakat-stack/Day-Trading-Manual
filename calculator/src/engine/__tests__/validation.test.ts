import { describe, expect, it } from 'vitest';
import { inputWarnings, validateInputs } from '../validation';
import { evaluateTrade, type TradeInputs } from '../tradeCalculator';
import { RB_V1_DEFAULTS } from '../settings';

const good: TradeInputs = {
  ticker: 'IBM', direction: 'LONG', open: 255.3, high: 255.6, low: 255.24, close: 255.55, atr: 0.37,
  currentPrice: 255.5, investmentAmount: 20000, accountEquity: 100000, riskPct: 0.0025, alertTime: '10:15',
  close15m: 255.48, ema20_15m: 255.0, minutesSinceAlert: 2, hasOpenPosition: false, openPositionDirection: null,
};
const msgs = (i: Partial<TradeInputs>) => validateInputs({ ...good, ...i }).map((e) => e.message);

describe('validation rules', () => {
  it('accepts valid input', () => expect(validateInputs(good)).toEqual([]));
  it('High >= Low', () => expect(msgs({ high: 255.0, low: 255.24, open: 255.1, close: 255.1 })).toContain('High must be greater than or equal to Low.'));
  it('High >= Open', () => expect(msgs({ open: 255.7 })).toContain('High must be greater than or equal to Open.'));
  it('High >= Close', () => expect(msgs({ close: 255.7 })).toContain('High must be greater than or equal to Close.'));
  it('Low <= Open', () => expect(msgs({ open: 255.2 })).toContain('Low must be less than or equal to Open.'));
  it('Low <= Close', () => expect(msgs({ close: 255.2 })).toContain('Low must be less than or equal to Close.'));
  it('ATR > 0', () => {
    expect(msgs({ atr: 0 })).toContain('ATR(14) must be greater than 0.');
    expect(msgs({ atr: -0.1 })).toContain('ATR(14) must be greater than 0.');
  });
  it('Current price > 0', () => expect(msgs({ currentPrice: 0 })).toContain('Current market price must be greater than 0.'));
  it('Investment > 0', () => expect(msgs({ investmentAmount: 0 })).toContain('Maximum investment per trade must be greater than 0.'));
  it('Equity > 0', () => expect(msgs({ accountEquity: -5 })).toContain('Account equity must be greater than 0.'));
  it('Risk % > 0 and <= 5%', () => {
    expect(msgs({ riskPct: 0 })).toContain('Maximum risk % must be greater than 0.');
    expect(msgs({ riskPct: 0.06 })).toContain('Maximum risk % above 5% is not allowed.');
  });
  it('missing numbers are required (never defaulted to 0)', () => {
    expect(msgs({ high: NaN })).toContain('High (H) is required.');
    expect(msgs({ close15m: NaN })).toContain('Last completed 15m Close is required.');
    expect(msgs({ ema20_15m: NaN })).toContain('Last completed 15m EMA20 is required.');
  });
  it('alert time is required as HH:MM', () => {
    expect(msgs({ alertTime: '' })[0]).toMatch(/Alert time is required/);
    expect(msgs({ alertTime: '9:45' })[0]).toMatch(/Alert time is required/);
    expect(msgs({ alertTime: '25:00' })[0]).toMatch(/Alert time is required/);
  });
  it('negative minutes rejected; blank minutes allowed', () => {
    expect(msgs({ minutesSinceAlert: -1 })).toContain('Minutes since alert cannot be negative.');
    expect(validateInputs({ ...good, minutesSinceAlert: null })).toEqual([]);
  });
  it('direction must be chosen', () => {
    expect(msgs({ direction: '' as unknown as 'LONG' })[0]).toMatch(/Select LONG or SHORT/);
  });
  it('a flat candle (H = L) is a valid INPUT (the candle-direction hard rule rejects it later)', () => {
    expect(validateInputs({ ...good, open: 100, high: 100, low: 100, close: 100, currentPrice: 99.9, close15m: 100, ema20_15m: 99 })).toEqual([]);
  });
  it('invalid input produces INVALID INPUT, no plan and an INVALID_INPUT hard fail', () => {
    const r = evaluateTrade({ ...good, high: 250 }, RB_V1_DEFAULTS);
    expect(r.action).toBe('INVALID_INPUT');
    expect(r.plan).toBeNull();
    expect(r.ready).toBe(false);
    expect(r.eligible).toBe(false);
    expect(r.hardFails[0].code).toBe('INVALID_INPUT');
  });
});

describe('non-blocking warnings (typos only — candle direction is a HARD rule now)', () => {
  it('no colour warnings any more', () => expect(inputWarnings({ ...good, open: 255.55, close: 255.3 })).toEqual([]));
  it('far-away current price', () => expect(inputWarnings({ ...good, currentPrice: 300 }).join(' ')).toMatch(/5% away/));
  it('far-away 15m close', () => expect(inputWarnings({ ...good, close15m: 300 }).join(' ')).toMatch(/15m Close/));
});
