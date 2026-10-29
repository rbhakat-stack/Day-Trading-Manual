/**
 * RB v1.1 hardening — the exact calculator cases from the specification (§45–§56).
 */
import { describe, expect, it } from 'vitest';
import { evaluateTrade, type TradeInputs } from '../tradeCalculator';
import { RB_V1_DEFAULTS } from '../settings';
import { SCENARIOS } from '../scenarios';

const S = { ...RB_V1_DEFAULTS };
const sc = (id: string): TradeInputs => ({ ...SCENARIOS.find((x) => x.id === id)!.inputs });
const run = (id: string, o: Partial<TradeInputs> = {}) => evaluateTrade({ ...sc(id), ...o }, S);

describe('§45 exact calculator cases', () => {
  it('IBM LONG: buffer 0.05, entry 255.65, SR 0.41, R 0.41, stop 255.24, target 256.47, 78 sh', () => {
    const r = run('ibm-long');
    const p = r.ticket!;
    expect(r.action).toBe('BUY_STOP');
    expect(r.eligible).toBe(true);
    expect([p.buffer, p.entry, p.riskPerShare, p.stop, p.target, p.shares]).toEqual([0.05, 255.65, 0.41, 255.24, 256.47, 78]);
    expect(p.structuralRisk).toBeCloseTo(0.41, 8);
    expect(p.maxLoss).toBeCloseTo(31.98, 8);
    expect(p.potentialProfit).toBeCloseTo(63.96, 8);
    expect(p.rewardRatio).toBe(2);
  });
  it('IBM LONG #2: H 255.75 L 255.22 ATR 0.388 → 255.80 / 255.22 / 256.96, 78 sh', () => {
    const p = run('ibm-long-2').ticket!;
    expect(p.bufferRaw).toBeCloseTo(0.05115, 8);
    expect([p.buffer, p.entry, p.riskPerShare, p.stop, p.target, p.shares]).toEqual([0.05, 255.8, 0.58, 255.22, 256.96, 78]);
    expect(p.structuralRisk).toBeCloseTo(0.58, 8);
    expect(p.riskMethod).toBe('STRUCTURAL');
    expect(p.positionValue).toBeCloseTo(19952.4, 8);
    expect(p.maxLoss).toBeCloseTo(45.24, 8);
  });
  it('NVDA SHORT: 0.04 / 212.53 / SR 0.44 / 212.97 / 211.65, 94 sh', () => {
    const p = run('nvda-short').ticket!;
    expect([p.buffer, p.entry, p.riskPerShare, p.stop, p.target, p.shares]).toEqual([0.04, 212.53, 0.44, 212.97, 211.65, 94]);
  });
  it('NEE SHORT: 0.02 / 81.90 / SR 0.12 / 82.02 / 81.66, 244 sh', () => {
    const p = run('nee-short').ticket!;
    expect([p.buffer, p.entry, p.riskPerShare, p.stop, p.target, p.shares]).toEqual([0.02, 81.9, 0.12, 82.02, 81.66, 244]);
  });
  it('$250 is a maximum, not a target: every example risks less', () => {
    for (const id of ['ibm-long', 'ibm-long-2', 'nvda-short', 'nee-short']) {
      const p = run(id).ticket!;
      expect(p.maxDollarRisk).toBe(250);
      expect(p.maxLoss).toBeLessThan(250);
      expect(p.limitedBy).toBe('INVESTMENT');
    }
  });
});

describe('§46 LONG with a red candle (C < O) — hard fail', () => {
  const r = run('long-red-candle');
  it('NOT ELIGIBLE — LONG SIGNAL CANDLE INVALID; no active Buy Stop ticket', () => {
    expect(r.headline).toBe('NOT ELIGIBLE — LONG SIGNAL CANDLE INVALID');
    expect(r.action).toBe('NOT_ELIGIBLE');
    expect(r.hardFails[0].code).toBe('INVALID_CANDLE_DIRECTION');
    expect(r.ready).toBe(false);
    expect(r.eligible).toBe(false);
    expect(r.ticket).toBeNull();
  });
  it('the math is still available for Show Calculation (calculable ≠ eligible)', () => {
    expect(r.plan).not.toBeNull();
    expect(r.plan!.entry).toBe(90.36);
  });
});

describe('§47 SHORT mirror on the same candle — valid', () => {
  it('0.02 / 90.11 / SR 0.23 / 90.34 / 89.65, 221 sh', () => {
    const r = run('short-mirror-90');
    const p = r.ticket!;
    expect(r.action).toBe('SELL_STOP');
    expect(r.hardFails).toEqual([]);
    expect([p.buffer, p.entry, p.riskPerShare, p.stop, p.target]).toEqual([0.02, 90.11, 0.23, 90.34, 89.65]);
    expect(p.structuralRisk).toBeCloseTo(0.23, 8);
    expect(p.investmentShares).toBe(221);
    expect(p.shares).toBe(221);
  });
});

describe('§48–§49 time hard fails', () => {
  it('16:04 ET → NOT ELIGIBLE — AFTER REGULAR SESSION (math is perfect, still blocked)', () => {
    const r = run('nvda-after-hours');
    expect(r.headline).toBe('NOT ELIGIBLE — AFTER REGULAR SESSION');
    expect(r.hardFails.map((f) => f.code)).toEqual(['AFTER_HOURS']);
    expect(r.ticket).toBeNull();
    expect(r.plan!.entry).toBe(212.53); // calculable
  });
  it('15:31 ET → NOT ELIGIBLE — NEW ENTRY WINDOW CLOSED', () => {
    const r = run('nvda-window-closed');
    expect(r.headline).toBe('NOT ELIGIBLE — NEW ENTRY WINDOW CLOSED');
    expect(r.ready).toBe(false);
  });
  it('09:40 ET → NOT ELIGIBLE — TOO EARLY', () => expect(run('nvda-too-early').headline).toBe('NOT ELIGIBLE — TOO EARLY'));
  it('alert 15:25 + 6 minutes waiting → the entry would happen at 15:31 → window closed', () => {
    const r = run('nvda-short', { alertTime: '15:25', minutesSinceAlert: 6 });
    expect(r.evaluationTime).toBe('15:31');
    expect(r.headline).toBe('NOT ELIGIBLE — NEW ENTRY WINDOW CLOSED');
  });
  it('the last-completed 15m candle is reported for the alert time', () => {
    expect(run('nvda-short', { alertTime: '10:07' }).last15mCandle).toEqual({ start: '09:45', end: '10:00' });
  });
});

describe('§54 15m trend confirmation — hard fail', () => {
  it('LONG 15m Close 100 < EMA20 101 → NOT ELIGIBLE', () => {
    const r = run('ibm-long', { close15m: 100, ema20_15m: 101 });
    expect(r.headline).toBe('NOT ELIGIBLE — 15M TREND CONFIRMATION FAILED');
    expect(r.ticket).toBeNull();
  });
  it('SHORT mirror: 15m Close > EMA20 → NOT ELIGIBLE', () => {
    expect(run('nvda-short', { close15m: 214, ema20_15m: 213 }).hardFails[0].code).toBe('HTF_CONFIRMATION_FAILED');
  });
  it('scenario ibm-htf-fail', () => expect(run('ibm-htf-fail').headline).toBe('NOT ELIGIBLE — 15M TREND CONFIRMATION FAILED'));
});

describe('§55–§56 chase', () => {
  it('entry 100.00, price 100.15, ATR 0.40 → 0.375 ATR → NOT ELIGIBLE — DO NOT CHASE', () => {
    const r = run('chase-0375');
    expect(r.plan!.entry).toBe(100);
    expect(r.chase!.distance).toBeCloseTo(0.15, 8);
    expect(r.chase!.distanceAtr).toBeCloseTo(0.375, 8);
    expect(r.headline).toBe('NOT ELIGIBLE — DO NOT CHASE');
    expect(r.ticket).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/BUY LIMIT/i);
  });
  it('entry 100.00, price 99.80, ATR 0.20 → still BUY STOP (not crossed, 1 ATR away)', () => {
    const r = run('no-chase-before-trigger');
    expect(r.action).toBe('BUY_STOP');
    expect(r.chase!.crossed).toBe(false);
    expect(Math.abs(r.chase!.distanceAtr)).toBeCloseTo(1, 8);
    expect(r.hardFails).toEqual([]);
    expect(r.ticket!.entry).toBe(100);
  });
});

describe('hierarchy', () => {
  it('all failing rules are listed; the headline follows the central priority', () => {
    const r = run('long-red-candle', { alertTime: '16:04', close15m: 90.1, ema20_15m: 90.2 });
    expect(r.hardFails.map((f) => f.code)).toEqual(['INVALID_CANDLE_DIRECTION', 'AFTER_HOURS', 'HTF_CONFIRMATION_FAILED']);
    expect(r.headline).toBe('NOT ELIGIBLE — LONG SIGNAL CANDLE INVALID');
  });
  it('a doji fails BOTH directions', () => {
    const doji = { open: 100, high: 100.2, low: 99.8, close: 100, atr: 0.2, currentPrice: 100.05 };
    expect(run('ibm-long', { ...doji, close15m: 100.1, ema20_15m: 99.9 }).hardFails[0].code).toBe('INVALID_CANDLE_DIRECTION');
    expect(run('nvda-short', { ...doji, close15m: 99.9, ema20_15m: 100.1 }).hardFails[0].code).toBe('INVALID_CANDLE_DIRECTION');
  });
  it('no result with a hard failure is ever ready or has a ticket (all scenarios, both market choices)', () => {
    for (const s of SCENARIOS) {
      for (const useMarketEntry of [false, true]) {
        const r = evaluateTrade({ ...s.inputs, useMarketEntry }, S);
        if (r.hardFails.length) {
          expect(r.ready).toBe(false);
          expect(r.eligible).toBe(false);
          expect(r.ticket).toBeNull();
          expect(['BUY_STOP', 'SELL_STOP', 'MARKET_LATE_ENTRY']).not.toContain(r.action);
        }
      }
    }
  });
  it('late entry is eligible-but-not-ready until the user opts in, and recalculates everything', () => {
    const r = run('ibm-late');
    expect(r.eligible).toBe(true);
    expect(r.ready).toBe(false);
    const m = run('ibm-late', { useMarketEntry: true }).ticket!;
    expect([m.entry, m.stop, m.target, m.shares]).toEqual([255.7, 255.24, 256.62, 78]);
    expect(m.riskPerShare).toBe(0.46);
  });
  it('every result reports the rules version', () => expect(run('ibm-long').rulesVersion).toBe('RB v1.1'));
});
