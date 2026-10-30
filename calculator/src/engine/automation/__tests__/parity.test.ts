import { describe, expect, it } from 'vitest';
import { compareParity, mismatchMessages, paritySummary } from '../parity';
import { DEFAULT_AUTOMATION } from '../alertDecision';
import type { AlertTimeValues } from '../alertSnapshot';

const auto: AlertTimeValues = { open: 212.73, high: 212.75, low: 212.25, close: 212.4, volume: 1, atr: 0.34, ema9: 212.5, ema20: 212.65, rsi: 33, rvol: 3.8, vwap: 212.6, vwapAlternative: null, close15m: 212.4, ema20_15m: 212.8 };
const tol = DEFAULT_AUTOMATION.parity;

describe('data parity (TrendSpider vs automated)', () => {
  it('NVDA High 212.76 vs 212.75 → Δ $0.01 within ±$0.02', () => {
    const [r] = compareParity(auto, { high: 212.76 }, tol);
    expect(r).toMatchObject({ field: 'high', absDiff: expect.closeTo(0.01, 10), mismatch: false, tolerance: '±$0.02' });
  });
  it('outside tolerance → mismatch messages', () => {
    const rows = compareParity(auto, { high: 212.8, atr: 0.37, rsi: 36, rvol: 3.0, vwap: 212.6, ema9: 212.5 }, tol);
    expect(rows.filter((r) => r.mismatch).map((r) => r.field)).toEqual(['high', 'atr', 'rsi', 'rvol']);
    expect(mismatchMessages(rows)[0]).toMatch(/^High: TrendSpider 212.8 vs automated 212.75/);
  });
  it('absolute and percentage differences', () => {
    const [r] = compareParity(auto, { atr: 0.35 }, tol);
    expect(r.absDiff).toBeCloseTo(0.01, 10);
    expect(r.pctDiff).toBeCloseTo(0.01 / 0.35, 10);
  });
  it('fields not entered are not compared', () => expect(compareParity(auto, {}, tol)).toEqual([]));
  it('summary: validated only after the required number of clean comparisons', () => {
    const e = (id: string) => ({ recordId: id, symbol: 'X', alertEt: '', enteredIso: '', trendSpider: {} });
    const ok = compareParity(auto, { high: 212.75 }, tol);
    const bad = compareParity(auto, { high: 213 }, tol);
    expect(paritySummary([e('a'), e('b')], { a: ok, b: ok }, 2).status).toBe('VALIDATED');
    expect(paritySummary([e('a')], { a: ok }, 2).status).toBe('IN PROGRESS');
    expect(paritySummary([e('a'), e('b')], { a: ok, b: bad }, 2)).toMatchObject({ status: 'MISMATCHES FOUND', withMismatch: 1 });
  });
});
