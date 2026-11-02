/**
 * CR-14 — labels consistent with points; Location/Extension audit fields. CR-08 — SIP parity count over the five
 * non-RVOL checks with a separate SIP RVOL diagnostic line. Display layer only: RB v1.1 points are unchanged.
 */
import { describe, expect, it } from 'vitest';
import type { Candidate, RankingInputs } from '../opportunityTypes';
import { cloneRankerDefaults } from '../rankerSettings';
import { scoreLocation, scoreMomentum } from '../opportunityScorer';
import { displaySummary, locationAudit } from '../componentAudit';
import { classifyConditions, sipParitySummary } from '../../automation/v12/parityDiagnostics';

const S = cloneRankerDefaults();
function cand(o: Partial<Omit<Candidate, 'inputs'>> & { inputs?: Partial<RankingInputs> } = {}): Candidate {
  const { inputs, ...rest } = o;
  return {
    id: 'c1', date: '2026-10-30', alertTime: '10:00', createdAt: 1, ticker: 'XYZ', direction: 'LONG',
    open: 100, high: 101, low: 100, close: 101, atr: 1, currentPrice: 101,
    entry: 101.02, stop: 100.02, target: 103.02, shares: 99, positionValue: 10000, plannedRisk: 99, expectedReward: 198,
    orderType: 'BUY STOP', calcAction: 'BUY_STOP', calcReady: true, chaseDistanceAtr: -0.02, minutesSinceAlert: 1,
    scored: true, status: 'NEW', initialScore: null, entryScore: null, actualFill: null, exitPrice: null, notes: '', archived: false, keptAgainst: [],
    ...rest,
    inputs: { rvol: 4, rsi: 67, vwap: 100.3, ema9: 100.7, ema20: 100.1, close15m: 101, ema20_15m: 100, sector: 'S', industry: 'I', theme: '', ...inputs },
  } as Candidate;
}

describe('CR-14 momentum label follows the points', () => {
  it('RSI 62 (9/10) → "Strong momentum", never "Moderate momentum"; points unchanged', () => {
    const c = cand({ inputs: { rsi: 62 } });
    const m = scoreMomentum(c, S);
    expect(m.points).toBe(9);
    expect(displaySummary(m, c, S)).toBe('Strong momentum');
  });
  it('RSI 67 (10/10) strong; RSI 57 (6/10) moderate; RSI 72 extended; SHORT mirrored', () => {
    expect(displaySummary(scoreMomentum(cand({ inputs: { rsi: 67 } }), S), cand(), S)).toBe('Strong, not exhausted');
    expect(displaySummary(scoreMomentum(cand({ inputs: { rsi: 57 } }), S), cand(), S)).toBe('Moderate momentum');
    expect(displaySummary(scoreMomentum(cand({ inputs: { rsi: 72 } }), S), cand(), S)).toBe('Extended momentum');
    const sh = cand({ direction: 'SHORT', inputs: { rsi: 38 } });
    expect(scoreMomentum(sh, S).points).toBe(9);
    expect(displaySummary(scoreMomentum(sh, S), sh, S)).toBe('Strong momentum');
  });
});

describe('CR-14 Location/Extension audit', () => {
  it('exposes values used, VWAP, EMA20, ATR, unrounded numerator, ATR-normalized extension and band', () => {
    const c = cand({ currentPrice: 101.75, atr: 0.5, inputs: { vwap: 100.9, ema20: 101.1, ema9: 101.5 } });
    const a = locationAudit(c)!;
    expect(a).toMatchObject({ vwap: 100.9, ema20: 101.1, atr: 0.5, anchor: 'VWAP', band: '≤ 2.0', bandPoints: 7, ema9Deduction: 0 });
    expect(a.numerator).toBeCloseTo(0.85, 10);
    expect(a.extensionAtr).toBeCloseTo(1.7, 10);
    expect(a.points).toBe(scoreLocation(c, S).points);
    expect(displaySummary(scoreLocation(c, S), c, S)).toBe('Somewhat stretched');
  });
  it('price on the wrong side of VWAP/EMA20 (4 pts) is named as such, not "Very extended"', () => {
    const c = cand({ currentPrice: 100.0, inputs: { vwap: 100.3, ema20: 100.1, ema9: 100.2 } });
    expect(scoreLocation(c, S).points).toBe(4);
    expect(displaySummary(scoreLocation(c, S), c, S)).toBe('Wrong side of VWAP/EMA20');
  });
  it('audit points equal the RB v1.1 scorer points across a grid of prices, ATRs, directions and chase distances', () => {
    let n = 0;
    for (const dir of ['LONG', 'SHORT'] as const) {
      for (const atr of [0.2, 0.5, 1, 1.7]) {
        for (let k = -20; k <= 40; k++) {
          for (const chase of [-0.05, 0, 0.1, 0.24]) {
            const c = cand({ direction: dir, atr, currentPrice: 100 + (dir === 'LONG' ? 1 : -1) * k * 0.1, chaseDistanceAtr: chase, inputs: { vwap: 100, ema20: 99.9 + (dir === 'LONG' ? 0 : 0.2), ema9: 100.05 } });
            expect(locationAudit(c)!.points).toBe(scoreLocation(c, S).points);
            n++;
          }
        }
      }
    }
    expect(n).toBeGreaterThan(900);
  });
  it('missing inputs → no audit (never fabricated)', () => {
    expect(locationAudit(cand({ inputs: { vwap: null as unknown as number } }))).toBeNull();
  });
});

describe('CR-08 SIP parity text', () => {
  const tol = { vwapPct: 0.0005, emaPct: 0.0005, rsiPts: 1, priceAbs: 0.01, atrPct: 0.01, rvolPct: 0.05 };
  it('counts only the five non-RVOL checks; RVOL is a separate diagnostic line', () => {
    const p = classifyConditions({ open: 100, close: 101, vwap: 100.3, ema9: 100.7, ema20: 100.1, rsi: 67, rvol: 1.2, close15m: 101, ema20_15m: 100 }, 'LONG', tol, null);
    const s = sipParitySummary(p.diagnostics);
    expect(s.text).toBe('Non-RVOL SIP checks: 5/5 agree');
    expect(s.rvolText).toBe('SIP RVOL 1.20 vs 1.5 — diagnostic only (not counted, never blocking)');
    expect(s.text).not.toMatch(/6 of 6/);
  });
  it('a disagreeing condition is counted out of 5; unavailable RVOL is reported, not counted', () => {
    const p = classifyConditions({ open: 101, close: 100.5, vwap: 100.3, ema9: 100.7, ema20: 100.1, rsi: 67, rvol: Number.NaN, close15m: 101, ema20_15m: 100 }, 'LONG', tol);
    const s = sipParitySummary(p.diagnostics);
    expect(s.text).toBe('Non-RVOL SIP checks: 4/5 agree');
    expect(s.off.map((d) => d.rule)).toEqual(['CANDLE_DIRECTION']);
    expect(s.rvolText).toMatch(/unavailable/);
  });
});
