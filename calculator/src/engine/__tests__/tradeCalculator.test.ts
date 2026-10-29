import { describe, expect, it } from 'vitest';
import {
  analyzeFill,
  buildPlan,
  calcBuffer,
  calcChase,
  calcEntryTrigger,
  calculationSteps,
  evaluateTrade,
  formatTicket,
  planTrigger,
  type TradeInputs,
} from '../tradeCalculator';
import { RB_V1_DEFAULTS, validateSettings, type RbSettings } from '../settings';
import { SCENARIOS } from '../scenarios';

const S: RbSettings = { ...RB_V1_DEFAULTS };
const scenario = (id: string): TradeInputs => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return { ...s.inputs };
};

/* ─────────────────────────── formulas ─────────────────────────── */

describe('buffer = MAX($0.01, 0.0002 × price), rounded to nearest cent', () => {
  it('IBM high 255.60 → raw 0.05112 → 0.05', () => {
    const b = calcBuffer(255.6);
    expect(b.raw).toBeCloseTo(0.05112, 8);
    expect(b.rounded).toBe(0.05);
  });
  it('NVDA low 212.57 → 0.042514 → 0.04', () => expect(calcBuffer(212.57).rounded).toBe(0.04));
  it('AEP low 128.78 → 0.025756 → 0.03', () => expect(calcBuffer(128.78).rounded).toBe(0.03));
  it('NEE low 81.92 → 0.016384 → 0.02', () => expect(calcBuffer(81.92).rounded).toBe(0.02));
  it('TRMB high 65.19 → 0.013038 → 0.01', () => expect(calcBuffer(65.19).rounded).toBe(0.01));
  it('HCA high 477.45 → 0.09549 → 0.10', () => expect(calcBuffer(477.45).rounded).toBe(0.1));
  it('never below the $0.01 minimum (price $20 → 0.004 → 0.01)', () => {
    const b = calcBuffer(20);
    expect(b.raw).toBe(0.01);
    expect(b.rounded).toBe(0.01);
  });
  it('is NOT always $0.01', () => expect(calcBuffer(255.6).rounded).not.toBe(0.01));
  it('respects edited settings (0.05%, min $0.02)', () => {
    expect(calcBuffer(100, { minBuffer: 0.02, bufferPct: 0.0005 }).rounded).toBe(0.05);
    expect(calcBuffer(10, { minBuffer: 0.02, bufferPct: 0.0005 }).rounded).toBe(0.02);
  });
});

describe('entry trigger', () => {
  it('LONG = High + buffer', () => expect(calcEntryTrigger('LONG', 255.6, 255.24).entry).toBe(255.65));
  it('SHORT = Low − buffer', () => expect(calcEntryTrigger('SHORT', 212.97, 212.57).entry).toBe(212.53));
  it('SHORT uses the LOW for the buffer, LONG uses the HIGH', () => {
    expect(calcEntryTrigger('SHORT', 477.45, 128.78).buffer).toBe(0.03);
    expect(calcEntryTrigger('LONG', 477.45, 128.78).buffer).toBe(0.1);
  });
});

describe('risk: R = MAX(structural, ATR); stop and target from R', () => {
  const sizing = { accountEquity: 100000, riskPct: 0.0025, investmentAmount: 20000 };
  it('does NOT blindly use 1 ATR when structural risk is larger (NVDA)', () => {
    const p = buildPlan('SHORT', 212.53, 212.97, 212.57, 0.333, sizing, S);
    expect(p.structuralRisk).toBeCloseTo(0.44, 8);
    expect(p.riskMethod).toBe('STRUCTURAL');
    expect(p.riskPerShare).toBe(0.44);
    expect(p.stop).toBe(212.97);
    expect(p.target).toBe(211.65);
  });
  it('uses ATR when the candle is smaller than 1 ATR (TRMB)', () => {
    const p = buildPlan('LONG', 65.2, 65.19, 65.14, 0.1, sizing, S);
    expect(p.structuralRisk).toBeCloseTo(0.06, 8);
    expect(p.riskMethod).toBe('ATR');
    expect(p.riskPerShare).toBe(0.1);
    expect(p.stop).toBe(65.1);
    expect(p.target).toBe(65.4);
  });
  it('target uses actual R, not 2 × ATR, when structural is larger', () => {
    const p = buildPlan('LONG', 255.65, 255.6, 255.24, 0.37, sizing, S);
    expect(p.target).toBe(256.47); // 255.65 + 2 × 0.41
    expect(p.target).not.toBeCloseTo(255.65 + 2 * 0.37, 2);
  });
  it('rounds a fractional-cent ATR risk UP so the stop is never too close', () => {
    // E = 50.01, structural 0.06, ATR 0.157 → R 0.157 → 0.16
    const p = buildPlan('LONG', 50.01, 50.0, 49.95, 0.157, sizing, S);
    expect(p.rRaw).toBeCloseTo(0.157, 8);
    expect(p.riskPerShare).toBe(0.16);
    expect(p.stop).toBe(49.85);
    expect(p.target).toBe(50.33);
    expect(p.rewardRatio).toBe(2);
  });
  it('SHORT stop is ABOVE entry and target BELOW', () => {
    const p = buildPlan('SHORT', 81.9, 82.02, 81.92, 0.081, sizing, S);
    expect(p.stop).toBeGreaterThan(p.entry);
    expect(p.target).toBeLessThan(p.entry);
  });
  it('ATR multiplier setting is applied', () => {
    const p = buildPlan('LONG', 65.2, 65.19, 65.14, 0.1, sizing, { ...S, atrStopMultiple: 1.5 });
    expect(p.riskPerShare).toBe(0.15);
    expect(p.stop).toBe(65.05);
  });
  it('reward multiple setting is applied', () => {
    const p = buildPlan('LONG', 255.65, 255.6, 255.24, 0.37, sizing, { ...S, rewardMultiple: 3 });
    expect(p.target).toBe(256.88);
    expect(p.rewardRatio).toBe(3);
  });
});

describe('position sizing', () => {
  it('risk-based shares = FLOOR(250 ÷ R); investment shares = FLOOR(20000 ÷ E); final = MIN', () => {
    const p = planTrigger(scenario('nvda-short'), S);
    expect(p.maxDollarRisk).toBe(250);
    expect(p.riskShares).toBe(568); // 250 / 0.44 = 568.18
    expect(p.investmentShares).toBe(94); // 20000 / 212.53 = 94.10
    expect(p.shares).toBe(94);
    expect(p.limitedBy).toBe('INVESTMENT');
  });
  it('limited by risk when the risk cap is smaller', () => {
    const p = planTrigger({ ...scenario('hca-chased'), investmentAmount: 100000 }, S);
    expect(p.riskShares).toBe(97); // 250 / 2.56 = 97.66
    expect(p.investmentShares).toBe(209);
    expect(p.shares).toBe(97);
    expect(p.limitedBy).toBe('RISK');
  });
  it('never rounds shares up (exact division stays exact)', () => {
    const p = buildPlan('LONG', 50.25, 50.0, 50.0, 0.25, { accountEquity: 100000, riskPct: 0.0025, investmentAmount: 1e9 }, S);
    expect(p.riskPerShare).toBe(0.25);
    expect(p.riskShares).toBe(1000); // not 999 from float error
    const q = buildPlan('LONG', 50.75, 50.0, 50.0, 0.75, { accountEquity: 100000, riskPct: 0.0025, investmentAmount: 1e9 }, S);
    expect(q.riskShares).toBe(333); // 333.33 → 333
  });
  it('max loss and potential profit use final shares × R', () => {
    const p = planTrigger(scenario('nvda-short'), S);
    expect(p.maxLoss).toBeCloseTo(41.36, 8);
    expect(p.potentialProfit).toBeCloseTo(82.72, 8);
    expect(p.positionValue).toBeCloseTo(19977.82, 8);
    expect(p.pctOfAccount).toBeCloseTo(0.1997782, 6);
  });
});

describe('chase calculation', () => {
  it('LONG distance = current − entry; ATR multiple', () => {
    const c = calcChase('LONG', 131.56, 131.79, 0.228, 0.25);
    expect(c.crossed).toBe(true);
    expect(c.distance).toBeCloseTo(0.23, 8);
    expect(c.distanceAtr).toBeCloseTo(1.0088, 3);
    expect(c.thresholdDollars).toBeCloseTo(0.057, 8);
  });
  it('SHORT distance = entry − current', () => {
    const c = calcChase('SHORT', 128.75, 128.7, 0.157, 0.25);
    expect(c.crossed).toBe(true);
    expect(c.distance).toBeCloseTo(0.05, 8);
  });
  it('not crossed before the trigger', () => {
    expect(calcChase('LONG', 65.2, 65.15, 0.1, 0.25).crossed).toBe(false);
    expect(calcChase('SHORT', 128.75, 128.85, 0.157, 0.25).crossed).toBe(false);
  });
});

/* ─────────────────────────── specification scenarios ─────────────────────────── */

describe('Scenario 29 — TRMB LONG (ATR controls)', () => {
  const r = evaluateTrade(scenario('trmb-long'), S);
  it('BUY STOP, waiting for breakout', () => {
    expect(r.action).toBe('BUY_STOP');
    expect(r.status).toBe('WAITING FOR BREAKOUT');
    expect(r.ready).toBe(true);
  });
  it('entry 65.20, stop 65.10, target 65.40, ~306 shares', () => {
    const p = r.ticket!;
    expect(p.buffer).toBe(0.01);
    expect(p.entry).toBe(65.2);
    expect(p.riskMethod).toBe('ATR');
    expect(p.stop).toBe(65.1);
    expect(p.target).toBe(65.4);
    expect(p.shares).toBe(306); // 20000 / 65.20 = 306.7
    expect(p.limitedBy).toBe('INVESTMENT');
  });
});

describe('Scenario 30 — AEP SHORT (structural slightly dominates)', () => {
  const r = evaluateTrade(scenario('aep-short'), S);
  it('SELL STOP @ 128.75', () => {
    expect(r.action).toBe('SELL_STOP');
    expect(r.status).toBe('WAITING FOR BREAKDOWN');
    expect(r.ticket!.entry).toBe(128.75);
  });
  it('structural 0.16 > ATR 0.157 → stop 128.91, target 128.43, 155 shares', () => {
    const p = r.ticket!;
    expect(p.structuralRisk).toBeCloseTo(0.16, 8);
    expect(p.riskMethod).toBe('STRUCTURAL');
    expect(p.stop).toBe(128.91);
    expect(p.target).toBe(128.43);
    expect(p.shares).toBe(155);
  });
});

describe('Scenario 31 — NVDA SHORT (structural > ATR)', () => {
  const r = evaluateTrade(scenario('nvda-short'), S);
  it('matches the specification ticket', () => {
    const p = r.ticket!;
    expect(r.action).toBe('SELL_STOP');
    expect(p.buffer).toBe(0.04);
    expect(p.entry).toBe(212.53);
    expect(p.riskPerShare).toBe(0.44);
    expect(p.stop).toBe(212.97);
    expect(p.target).toBe(211.65);
    expect(p.shares).toBe(94);
    expect(p.maxLoss).toBeCloseTo(41.36, 8);
    expect(p.potentialProfit).toBeCloseTo(82.72, 8);
    expect(p.rewardRatio).toBe(2);
  });
});

describe('Scenario 32 — NEE SHORT (structural controls)', () => {
  it('entry 81.90, stop 82.02, target 81.66, 244 shares', () => {
    const p = evaluateTrade(scenario('nee-short'), S).ticket!;
    expect(p.buffer).toBe(0.02);
    expect(p.entry).toBe(81.9);
    expect(p.structuralRisk).toBeCloseTo(0.12, 8);
    expect(p.riskMethod).toBe('STRUCTURAL');
    expect(p.stop).toBe(82.02);
    expect(p.target).toBe(81.66);
    expect(p.shares).toBe(244);
  });
});

describe('Scenario 33 — IBM LONG (structural wins)', () => {
  it('entry 255.65, stop 255.24, target 256.47, 78 shares', () => {
    const r = evaluateTrade(scenario('ibm-long'), S);
    const p = r.ticket!;
    expect(r.action).toBe('BUY_STOP');
    expect(p.entry).toBe(255.65);
    expect(p.structuralRisk).toBeCloseTo(0.41, 8);
    expect(p.riskMethod).toBe('STRUCTURAL');
    expect(p.stop).toBe(255.24);
    expect(p.target).toBe(256.47);
    expect(p.shares).toBe(78);
    expect(p.positionValue).toBeCloseTo(19940.7, 8);
    expect(p.maxLoss).toBeCloseTo(31.98, 8);
    expect(p.potentialProfit).toBeCloseTo(63.96, 8);
  });
});

describe('Scenario 34 — HCA LONG (structural dominates, then chased)', () => {
  const r = evaluateTrade(scenario('hca-chased'), S);
  it('plan: entry 477.55, structural 2.56, stop 474.99, target 482.67, 41 shares', () => {
    const p = r.plan!;
    expect(p.buffer).toBe(0.1);
    expect(p.entry).toBe(477.55);
    expect(p.structuralRisk).toBeCloseTo(2.56, 8);
    expect(p.stop).toBe(474.99);
    expect(p.target).toBe(482.67);
    expect(p.shares).toBe(41);
  });
  it('current 478.66 is 1.11 (>1 ATR) past entry → NOT ELIGIBLE — DO NOT CHASE, no ticket', () => {
    expect(r.action).toBe('SKIP_CHASED');
    expect(r.headline).toBe('NOT ELIGIBLE — DO NOT CHASE');
    expect(r.hardFails.map((f) => f.code)).toEqual(['CHASED_SETUP']);
    expect(r.chase!.distance).toBeCloseTo(1.11, 8);
    expect(r.chase!.distanceAtr).toBeGreaterThan(1);
    expect(r.ticket).toBeNull();
    expect(r.ready).toBe(false);
  });
});

describe('Scenario 35 — DLTR missed breakout', () => {
  const r = evaluateTrade(scenario('dltr-missed'), S);
  it('trigger 131.56; 0.23 past = ~1.0 ATR vs 0.057 allowed → SKIP', () => {
    expect(r.plan!.entry).toBe(131.56);
    expect(r.chase!.thresholdDollars).toBeCloseTo(0.057, 8);
    expect(r.action).toBe('SKIP_CHASED');
  });
  it('never recommends a Buy Limit', () => {
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/BUY LIMIT/i);
    expect(r.ticket).toBeNull();
  });
});

describe('Scenario 36 — failed breakout', () => {
  it('IBM current 255.11 below stop 255.24 → NOT ELIGIBLE — SETUP FAILED / DO NOT ENTER', () => {
    const r = evaluateTrade(scenario('ibm-failed'), S);
    expect(r.action).toBe('SKIP_SETUP_FAILED');
    expect(r.subhead).toBe('DO NOT ENTER');
    expect(r.headline).toBe('NOT ELIGIBLE — SETUP FAILED');
    expect(r.messages[0].text).toMatch(/below the planned stop/);
    expect(r.ticket).toBeNull();
  });
  it('SHORT failed when price rises to/above the stop', () => {
    const r = evaluateTrade({ ...scenario('nvda-short'), currentPrice: 213.0 }, S);
    expect(r.action).toBe('SKIP_SETUP_FAILED');
  });
});

/* ─────────────────────────── decision engine ─────────────────────────── */

describe('late entry (crossed, within 0.25 ATR)', () => {
  it('shows LATE ENTRY REVIEW without a ready ticket until the user opts in', () => {
    const r = evaluateTrade(scenario('ibm-late'), S);
    expect(r.action).toBe('MARKET_LATE_ENTRY');
    expect(r.status).toBe('LATE ENTRY — REVIEW');
    expect(r.ready).toBe(false);
    expect(r.ticket).toBeNull();
    expect(r.chase!.distance).toBeCloseTo(0.05, 8);
    expect(r.chase!.distanceAtr).toBeCloseTo(0.1351, 3);
    expect(r.marketPlan).not.toBeNull();
  });
  it('market entry completely recalculates from the current price', () => {
    const r = evaluateTrade({ ...scenario('ibm-late'), useMarketEntry: true }, S);
    const m = r.ticket!;
    expect(r.ready).toBe(true);
    expect(m.entryMethod).toBe('MARKET');
    expect(m.orderType).toBe('MARKET');
    expect(m.entry).toBe(255.7);
    expect(m.buffer).toBe(0);
    expect(m.structuralRisk).toBeCloseTo(0.46, 8);
    expect(m.riskPerShare).toBe(0.46);
    expect(m.stop).toBe(255.24);
    expect(m.target).toBe(256.62);
    expect(m.shares).toBe(78); // 20000 / 255.70 = 78.2
    expect(m.maxLoss).toBeCloseTo(35.88, 8);
    expect(m.potentialProfit).toBeCloseTo(71.76, 8);
    // the old trigger plan is untouched
    expect(r.plan!.entry).toBe(255.65);
  });
  it('exactly at the trigger counts as crossed (0 ATR) → late review, not a stop order', () => {
    const r = evaluateTrade({ ...scenario('ibm-long'), currentPrice: 255.65 }, S);
    expect(r.action).toBe('MARKET_LATE_ENTRY');
  });
  it('exactly 0.25 ATR is allowed; above it is chased', () => {
    // IBM: entry 255.65, ATR 0.40 → 0.25 ATR = 0.10
    const at = evaluateTrade({ ...scenario('ibm-long'), atr: 0.4, currentPrice: 255.75 }, S);
    expect(at.action).toBe('MARKET_LATE_ENTRY');
    const over = evaluateTrade({ ...scenario('ibm-long'), atr: 0.4, currentPrice: 255.76 }, S);
    expect(over.action).toBe('SKIP_CHASED');
  });
  it('chase threshold setting is respected', () => {
    const r = evaluateTrade(scenario('dltr-missed'), { ...S, chaseThresholdAtr: 1.5 });
    expect(r.action).toBe('MARKET_LATE_ENTRY');
  });
});

describe('stale alerts', () => {
  it('more than 10 minutes without a breakout → NOT ELIGIBLE — STALE SETUP (hard fail)', () => {
    const r = evaluateTrade(scenario('trmb-stale'), S);
    expect(r.action).toBe('SKIP_STALE');
    expect(r.headline).toBe('NOT ELIGIBLE — STALE SETUP');
    expect(r.ticket).toBeNull();
    expect(r.candlesSinceAlert).toBe(3);
  });
  it('exactly 10 minutes is still allowed', () => {
    expect(evaluateTrade({ ...scenario('trmb-long'), minutesSinceAlert: 10 }, S).action).toBe('BUY_STOP');
  });
  it('unknown age (blank) is not treated as stale', () => {
    expect(evaluateTrade({ ...scenario('trmb-long'), minutesSinceAlert: null }, S).action).toBe('BUY_STOP');
  });
  it('alert window setting is respected', () => {
    expect(evaluateTrade(scenario('trmb-stale'), { ...S, alertWindowMinutes: 20 }).action).toBe('BUY_STOP');
  });
});

describe('existing positions (one position per ticker)', () => {
  it('same direction → DO NOT ADD, no plan calculated', () => {
    const r = evaluateTrade({ ...scenario('ibm-long'), hasOpenPosition: true, openPositionDirection: 'LONG' }, S);
    expect(r.action).toBe('DO_NOT_ADD');
    expect(r.headline).toBe('DO NOT ADD — POSITION/ORDER ALREADY EXISTS');
    expect(r.hardFails[0].code).toBe('EXISTING_SAME_TICKER_POSITION');
    expect(r.plan).toBeNull();
    expect(r.messages[0].text).toMatch(/one active position or pending order per ticker/);
  });
  it('opposite direction → manage existing trade, never reverse', () => {
    const r = evaluateTrade({ ...scenario('ibm-long'), hasOpenPosition: true, openPositionDirection: 'SHORT' }, S);
    expect(r.action).toBe('MANAGE_EXISTING');
    expect(r.messages[0].text).toMatch(/Do not automatically reverse/);
    expect(r.plan).toBeNull();
  });
  it('pyramiding override (Settings) calculates with a warning', () => {
    const r = evaluateTrade({ ...scenario('ibm-long'), hasOpenPosition: true, openPositionDirection: 'LONG' }, { ...S, allowPyramiding: true });
    expect(r.action).toBe('BUY_STOP');
    expect(r.warnings.join(' ')).toMatch(/Pyramiding override/);
  });
  it('existing-position check happens BEFORE the chase check (hierarchy step 2)', () => {
    const r = evaluateTrade({ ...scenario('hca-chased'), hasOpenPosition: true, openPositionDirection: 'LONG' }, S);
    expect(r.action).toBe('DO_NOT_ADD');
  });
});

describe('beginner safeguards', () => {
  it('every ready ticket has the correct price order', () => {
    for (const sc of SCENARIOS) {
      for (const useMarketEntry of [false, true]) {
        const r = evaluateTrade({ ...sc.inputs, useMarketEntry }, S);
        if (!r.ready || !r.ticket) continue;
        const p = r.ticket;
        if (p.direction === 'LONG') expect(p.stop < p.entry && p.entry < p.target).toBe(true);
        else expect(p.target < p.entry && p.entry < p.stop).toBe(true);
        expect(Number.isInteger(p.shares)).toBe(true);
        expect(p.shares).toBeGreaterThan(0);
        expect(p.positionValue).toBeLessThanOrEqual(sc.inputs.investmentAmount);
        expect(p.maxLoss).toBeLessThanOrEqual(sc.inputs.accountEquity * sc.inputs.riskPct + 1e-9);
      }
    }
  });
  it('skip states never carry a ticket', () => {
    for (const id of ['hca-chased', 'dltr-missed', 'ibm-failed', 'trmb-stale']) {
      const r = evaluateTrade(scenario(id), S);
      expect(r.ticket).toBeNull();
      expect(r.ready).toBe(false);
    }
  });
  it('zero shares (investment cap smaller than one share) is invalid, not a trade', () => {
    const r = evaluateTrade({ ...scenario('hca-chased'), currentPrice: 477.0, investmentAmount: 400 }, S);
    expect(r.action).toBe('INVALID_INPUT');
    expect(r.errors[0].message).toMatch(/0 shares/);
  });
  it('invalid structure is reported (target would be negative on a tiny short)', () => {
    const r = evaluateTrade(
      { ...scenario('nvda-short'), open: 2.0, high: 2.0, low: 0.02, close: 0.03, atr: 0.5, currentPrice: 1.0 },
      S,
    );
    expect(r.action).toBe('INVALID_STRUCTURE');
    expect(r.headline).toBe('INVALID TRADE STRUCTURE');
    expect(r.ready).toBe(false);
  });
});

describe('copy ticket, calculation steps and actual fill', () => {
  it('COPY TRADE text', () => {
    const r = evaluateTrade(scenario('nvda-short'), S);
    expect(formatTicket('nvda', r.ticket!)).toBe(
      ['NVDA SHORT', 'SELL STOP', 'Qty: 94', 'Entry: 212.53', 'Stop: 212.97', 'Take Profit: 211.65', 'Risk/share: 0.44', 'Position: $19,977.82', 'Max loss: $41.36', 'R:R: 2.0'].join('\n'),
    );
  });
  it('Show Calculation lines explain IBM step by step', () => {
    const i = scenario('ibm-long');
    const lines = calculationSteps(planTrigger(i, S), i, S).join('\n');
    expect(lines).toContain('Signal High = 255.60');
    expect(lines).toContain('Buffer = 0.0511 → rounded order buffer = 0.05');
    expect(lines).toContain('Entry = 255.60 + 0.05 = 255.65');
    expect(lines).toContain('R = MAX(0.4100, 0.3700) = 0.4100 → structural stop controls');
    expect(lines).toContain('Stop = 255.65 − 0.41 = 255.24');
    expect(lines).toContain('Target = 255.65 + 2 × 0.41 = 256.47');
  });
  it('actual fill is analysed separately and does not overwrite the plan', () => {
    const p = planTrigger(scenario('ibm-long'), S);
    const a = analyzeFill(p, 255.68);
    expect(a.slippagePerShare).toBeCloseTo(0.03, 8);
    expect(a.actualRiskPerShare).toBeCloseTo(0.44, 8);
    expect(a.actualRewardPerShare).toBeCloseTo(0.79, 8);
    expect(a.actualMaxLoss).toBeCloseTo(78 * 0.44, 8);
    expect(a.actualPositionCost).toBeCloseTo(78 * 255.68, 6);
    expect(a.riskInPlannedR).toBeCloseTo(0.44 / 0.41, 8);
    expect(p.entry).toBe(255.65);
  });
  it('actual SHORT fill below the trigger increases risk', () => {
    const p = planTrigger(scenario('nvda-short'), S);
    const a = analyzeFill(p, 212.5);
    expect(a.slippagePerShare).toBeCloseTo(0.03, 8);
    expect(a.actualRiskPerShare).toBeCloseTo(0.47, 8);
    expect(a.actualRewardPerShare).toBeCloseTo(0.85, 8);
  });
  it('fill beyond the stop is flagged', () => {
    const p = planTrigger(scenario('ibm-long'), S);
    expect(analyzeFill(p, 255.2).beyondStop).toBe(true);
  });
});

describe('settings', () => {
  it('RB v1 defaults', () => {
    expect(RB_V1_DEFAULTS).toMatchObject({
      minBuffer: 0.01, bufferPct: 0.0002, atrStopMultiple: 1, rewardMultiple: 2,
      chaseThresholdAtr: 0.25, riskPct: 0.0025, investmentCap: 20000, alertWindowMinutes: 10,
      allowPyramiding: false, strategyMode: 'RB_V1_BREAKOUT',
    });
    expect(validateSettings({ ...RB_V1_DEFAULTS })).toEqual([]);
  });
  it('rejects nonsense settings', () => {
    expect(validateSettings({ ...RB_V1_DEFAULTS, rewardMultiple: 0, riskPct: 0.2 }).length).toBe(2);
  });
});
