import { describe, expect, it } from 'vitest';
import {
  addMinutes,
  check15mConfirmation,
  checkCandleDirection,
  checkChase,
  checkSetupFailed,
  checkStale,
  checkStructure,
  checkTimeWindow,
  fail,
  HARD_FAIL_PRIORITY,
  lastCompleted15mCandle,
  RULES_VERSION,
  SCORING_VERSION,
  sortFails,
} from '../rules';

const W = { entryWindowStart: '09:45', entryWindowEnd: '15:30' };

describe('version', () => {
  it('RB v1.1', () => {
    expect(RULES_VERSION).toBe('RB v1.1');
    expect(SCORING_VERSION).toBe('RB v1.1');
  });
});

describe('time window (ET) — hard rule', () => {
  it.each([
    ['09:29', 'AFTER_HOURS', 'NOT ELIGIBLE — BEFORE REGULAR SESSION'],
    ['09:30', 'OUTSIDE_ENTRY_WINDOW', 'NOT ELIGIBLE — TOO EARLY'],
    ['09:44', 'OUTSIDE_ENTRY_WINDOW', 'NOT ELIGIBLE — TOO EARLY'],
    ['15:30', 'OUTSIDE_ENTRY_WINDOW', 'NOT ELIGIBLE — NEW ENTRY WINDOW CLOSED'],
    ['15:31', 'OUTSIDE_ENTRY_WINDOW', 'NOT ELIGIBLE — NEW ENTRY WINDOW CLOSED'],
    ['15:59', 'OUTSIDE_ENTRY_WINDOW', 'NOT ELIGIBLE — NEW ENTRY WINDOW CLOSED'],
    ['16:00', 'AFTER_HOURS', 'NOT ELIGIBLE — AFTER REGULAR SESSION'],
    ['16:04', 'AFTER_HOURS', 'NOT ELIGIBLE — AFTER REGULAR SESSION'],
    ['19:30', 'AFTER_HOURS', 'NOT ELIGIBLE — AFTER REGULAR SESSION'],
  ])('%s → %s (%s)', (t, code, label) => {
    const f = checkTimeWindow(t, W)!;
    expect(f.code).toBe(code);
    expect(f.label).toBe(label);
  });
  it.each(['09:45', '10:00', '11:30', '14:00', '15:29'])('%s → eligible', (t) => expect(checkTimeWindow(t, W)).toBeNull());
  it('invalid time is an input error', () => expect(checkTimeWindow('9:45', W)!.code).toBe('INVALID_INPUT'));
  it('window is configurable', () => expect(checkTimeWindow('09:40', { entryWindowStart: '09:35', entryWindowEnd: '15:30' })).toBeNull());
});

describe('candle direction — hard rule', () => {
  it('LONG requires Close > Open', () => {
    expect(checkCandleDirection('LONG', 90.34, 90.17)!.label).toBe('NOT ELIGIBLE — LONG SIGNAL CANDLE INVALID');
    expect(checkCandleDirection('LONG', 100, 100)!.code).toBe('INVALID_CANDLE_DIRECTION'); // doji
    expect(checkCandleDirection('LONG', 100, 100.01)).toBeNull();
  });
  it('SHORT requires Close < Open', () => {
    expect(checkCandleDirection('SHORT', 90.17, 90.34)!.label).toBe('NOT ELIGIBLE — SHORT SIGNAL CANDLE INVALID');
    expect(checkCandleDirection('SHORT', 100, 100)!.code).toBe('INVALID_CANDLE_DIRECTION');
    expect(checkCandleDirection('SHORT', 90.34, 90.17)).toBeNull();
  });
});

describe('last completed 15m candle confirmation — hard rule', () => {
  it('LONG: 15m Close 100 ≤ EMA20 101 → fail; equality also fails', () => {
    expect(check15mConfirmation('LONG', 100, 101)!.label).toBe('NOT ELIGIBLE — 15M TREND CONFIRMATION FAILED');
    expect(check15mConfirmation('LONG', 101, 101)).not.toBeNull();
    expect(check15mConfirmation('LONG', 101.01, 101)).toBeNull();
  });
  it('SHORT mirror: 15m Close > EMA20 → fail', () => {
    expect(check15mConfirmation('SHORT', 101, 100)!.code).toBe('HTF_CONFIRMATION_FAILED');
    expect(check15mConfirmation('SHORT', 100, 100)).not.toBeNull();
    expect(check15mConfirmation('SHORT', 99.99, 100)).toBeNull();
  });
  it.each([
    ['10:07', '09:45', '10:00'],
    ['10:18', '10:00', '10:15'],
    ['14:52', '14:30', '14:45'],
    ['15:29', '15:00', '15:15'],
    ['10:00', '09:45', '10:00'],
    ['09:45', '09:30', '09:45'],
  ])('alert %s → use the %s–%s candle', (t, start, end) => {
    expect(lastCompleted15mCandle(t)).toEqual({ start, end });
  });
  it('no completed regular-session 15m candle before 09:45', () => {
    expect(lastCompleted15mCandle('09:44')).toBeNull();
    expect(lastCompleted15mCandle('08:00')).toBeNull();
  });
  it('never refers to a post-market candle', () => expect(lastCompleted15mCandle('17:20')).toEqual({ start: '15:45', end: '16:00' }));
});

describe('chase / stale / setup failed / structure', () => {
  it('§55 chase: 0.15 ÷ 0.40 = 0.375 ATR > 0.25 → CHASED', () => {
    expect(checkChase(true, 0.15 / 0.4, 0.25)!.label).toBe('NOT ELIGIBLE — DO NOT CHASE');
    expect(checkChase(true, 0.25, 0.25)).toBeNull();
  });
  it('§56 no chase logic before the trigger is crossed', () => expect(checkChase(false, 5, 0.25)).toBeNull());
  it('stale only when NOT crossed and older than the window', () => {
    expect(checkStale(false, 11, 10)!.code).toBe('STALE_SETUP');
    expect(checkStale(false, 10, 10)).toBeNull();
    expect(checkStale(true, 30, 10)).toBeNull();
    expect(checkStale(false, null, 10)).toBeNull();
  });
  it('setup failed when price is at/through the stop', () => {
    expect(checkSetupFailed('LONG', 255.11, 255.24)!.code).toBe('SETUP_FAILED');
    expect(checkSetupFailed('SHORT', 213.0, 212.97)!.code).toBe('SETUP_FAILED');
    expect(checkSetupFailed('LONG', 255.3, 255.24)).toBeNull();
  });
  it('structure: LONG Stop < Entry < Target; SHORT Target < Entry < Stop; shares ≥ 1', () => {
    expect(checkStructure('LONG', 99, 100, 102, 10)).toBeNull();
    expect(checkStructure('LONG', 101, 100, 102, 10)!.code).toBe('INVALID_TRADE_STRUCTURE');
    expect(checkStructure('SHORT', 101, 100, 98, 10)).toBeNull();
    expect(checkStructure('SHORT', 99, 100, 98, 10)!.code).toBe('INVALID_TRADE_STRUCTURE');
    expect(checkStructure('LONG', 99, 100, 102, 0)!.label).toMatch(/0 SHARES/);
  });
});

describe('priority', () => {
  it('sortFails orders by the central hierarchy', () => {
    const f = sortFails([fail('CHASED_SETUP', 'x'), fail('AFTER_HOURS', 'y'), fail('INVALID_CANDLE_DIRECTION', 'z')]);
    expect(f.map((x) => x.code)).toEqual(['INVALID_CANDLE_DIRECTION', 'AFTER_HOURS', 'CHASED_SETUP']);
    expect(HARD_FAIL_PRIORITY.indexOf('INVALID_INPUT')).toBe(0);
  });
  it('addMinutes', () => expect(addMinutes('15:25', 6)).toBe('15:31'));
});
