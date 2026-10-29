import { describe, expect, it } from 'vitest';
import { floorShares, roundPrice, roundToTick, tickSize } from '../rounding';
import { computeMetrics, journalToCsv, timeBucket, tradePnl, tradeR, type JournalEntry } from '../journal';

describe('rounding', () => {
  it('tick size is $0.01 at/above $1 and $0.0001 below', () => {
    expect(tickSize(1)).toBe(0.01);
    expect(tickSize(0.99)).toBe(0.0001);
  });
  it('nearest / up / down without float noise', () => {
    expect(roundToTick(0.0511, 'nearest', 0.01)).toBe(0.05); // buffer for a $255 stock uses the stock's $0.01 tick
    expect(roundToTick(0.0511)).toBe(0.0511); // a bare value < $1 defaults to the $0.0001 sub-penny tick
    expect(roundToTick(0.1, 'up', 0.01)).toBe(0.1); // 0.1/0.01 = 10.000000000000002
    expect(roundToTick(0.157, 'up', 0.01)).toBe(0.16);
    expect(roundToTick(0.159, 'down', 0.01)).toBe(0.15);
    expect(roundPrice(255.6 + 0.05)).toBe(255.65);
    expect(roundPrice(0.12345)).toBe(0.1235);
  });
  it('shares always round down and never go negative', () => {
    expect(floorShares(306.74)).toBe(306);
    expect(floorShares(999.99999999999)).toBe(1000); // float noise of an exact 1000
    expect(floorShares(999.9)).toBe(999);
    expect(floorShares(-3)).toBe(0);
    expect(floorShares(NaN)).toBe(0);
  });
});

const mk = (p: Partial<JournalEntry>): JournalEntry => ({
  id: Math.random().toString(36), ticker: 'IBM', date: '2026-10-29', time: '10:15', direction: 'LONG',
  open: 255.3, high: 255.6, low: 255.24, close: 255.55, atr: 0.37, alertPrice: 255.5, decision: 'BUY_STOP',
  orderType: 'BUY STOP', plannedEntry: 255.65, actualFill: null, stop: 255.24, target: 256.47, quantity: 78,
  positionValue: 19940.7, expectedRisk: 31.98, expectedReward: 63.96, outcome: 'OPEN', exitPrice: null, notes: '',
  ...p,
});

describe('journal P/L and R', () => {
  it('LONG target hit = +2R', () => {
    const e = mk({ outcome: 'TARGET_HIT', exitPrice: 256.47 });
    expect(tradePnl(e)).toBeCloseTo(63.96, 8);
    expect(tradeR(e)).toBeCloseTo(2, 8);
  });
  it('LONG stop hit with slippage uses the actual fill', () => {
    const e = mk({ outcome: 'STOP_HIT', actualFill: 255.68, exitPrice: 255.2 });
    expect(tradePnl(e)).toBeCloseTo(-0.48 * 78, 8);
    expect(tradeR(e)).toBeCloseTo((-0.48 * 78) / 31.98, 8);
  });
  it('SHORT P/L sign', () => {
    const e = mk({ direction: 'SHORT', plannedEntry: 212.53, stop: 212.97, target: 211.65, quantity: 94, expectedRisk: 41.36, outcome: 'TARGET_HIT', exitPrice: 211.65 });
    expect(tradePnl(e)).toBeCloseTo(82.72, 8);
    expect(tradeR(e)).toBeCloseTo(2, 8);
  });
  it('skipped / never triggered / open have no P/L', () => {
    for (const outcome of ['SKIPPED', 'NEVER_TRIGGERED', 'CANCELED', 'OPEN'] as const) {
      expect(tradePnl(mk({ outcome, exitPrice: 256 }))).toBeNull();
    }
  });
});

describe('dashboard metrics', () => {
  const entries = [
    mk({ date: '2026-10-29', time: '09:45', outcome: 'TARGET_HIT', exitPrice: 256.47 }), // +63.96 (+2R)
    mk({ date: '2026-10-29', time: '10:20', outcome: 'STOP_HIT', exitPrice: 255.24 }), // −31.98 (−1R)
    mk({ date: '2026-10-29', time: '11:05', outcome: 'STOP_HIT', exitPrice: 255.24 }), // −31.98 (−1R)
    mk({ date: '2026-10-30', time: '13:10', ticker: 'NVDA', direction: 'SHORT', plannedEntry: 212.53, stop: 212.97, target: 211.65, quantity: 94, expectedRisk: 41.36, outcome: 'TARGET_HIT', exitPrice: 211.65 }), // +82.72 (+2R)
    mk({ outcome: 'SKIPPED' }),
    mk({ outcome: 'NEVER_TRIGGERED' }),
  ];
  const m = computeMetrics(entries);
  it('counts', () => {
    expect(m.totalEntries).toBe(6);
    expect(m.closedTrades).toBe(4);
    expect(m.wins).toBe(2);
    expect(m.losses).toBe(2);
    expect(m.skipped).toBe(1);
    expect(m.neverTriggered).toBe(1);
    expect(m.winRate).toBe(0.5);
  });
  it('averages, totals and profit factor', () => {
    expect(m.totalR).toBeCloseTo(2, 8);
    expect(m.averageR).toBeCloseTo(0.5, 8);
    expect(m.totalPnl).toBeCloseTo(63.96 - 63.96 + 82.72, 8);
    expect(m.averageWinner).toBeCloseTo((63.96 + 82.72) / 2, 8);
    expect(m.averageLoser).toBeCloseTo(-31.98, 8);
    expect(m.profitFactor).toBeCloseTo((63.96 + 82.72) / 63.96, 8);
    expect(m.averageActualLoss).toBeCloseTo(31.98, 8);
  });
  it('max drawdown (chronological): +63.96 peak → two losses = 63.96', () => {
    expect(m.maxDrawdown).toBeCloseTo(63.96, 8);
    expect(m.maxDrawdownR).toBeCloseTo(2, 8);
  });
  it('groups by direction, ticker and time of day', () => {
    expect(m.byDirection.find((g) => g.key === 'SHORT')!.totalR).toBeCloseTo(2, 8);
    expect(m.byTicker.find((g) => g.key === 'IBM')!.trades).toBe(3);
    expect(m.byTimeOfDay.find((g) => g.key === '09:30–10:00')!.trades).toBe(1);
    expect(timeBucket('13:10')).toBe('13:00–14:00');
    expect(timeBucket('08:00')).toBe('Pre-market');
  });
  it('no losses → profit factor null (not Infinity)', () => {
    expect(computeMetrics([entries[0]]).profitFactor).toBeNull();
  });
  it('CSV export includes derived P/L and R', () => {
    const csv = journalToCsv([entries[0]]);
    expect(csv.split('\n')[0]).toMatch(/pnl,rMultiple$/);
    expect(csv.split('\n')[1]).toMatch(/63\.96,2$/);
  });
});
