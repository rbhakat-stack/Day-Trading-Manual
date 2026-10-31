import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION } from '../../alertDecision';
import { aggregate15m } from '../../alertSnapshot';
import { etToEpoch } from '../../etTime';
import { classifyConditions, forming15m, type SipConditionInputs } from '../parityDiagnostics';
import { daysUpTo, sessionBars } from '../../__tests__/fixtures';

const TOL = DEFAULT_AUTOMATION.parity;
const AGREE_LONG: SipConditionInputs = { open: 100, close: 101, vwap: 100.5, ema9: 100.8, ema20: 100.2, rsi: 62, rvol: 2.1, close15m: 101, ema20_15m: 100 };

describe('parity classification (diagnostic only)', () => {
  it('all conditions agree → AGREE, only the standing SIP-RVOL note', () => {
    const r = classifyConditions(AGREE_LONG, 'LONG', TOL);
    expect(r.diagnostics.filter((d) => d.rule !== 'RVOL').every((d) => d.class === 'AGREE')).toBe(true);
    expect(r.diagnostics.find((d) => d.rule === 'RVOL')?.class).toBe('DIAGNOSTIC_ONLY');
    expect(r.warnings).toEqual(['SIP_RVOL_DIAGNOSTIC_ONLY']);
  });

  it('EVERY SIP condition disagrees (LONG alert) → DISAGREE on each, PARITY WARNINGs, and no blocking output', () => {
    const allWrong: SipConditionInputs = { open: 101, close: 99, vwap: 100, ema9: 99, ema20: 100, rsi: 40, rvol: 0.8, close15m: 98, ema20_15m: 100 };
    const r = classifyConditions(allWrong, 'LONG', TOL);
    for (const k of ['CLOSE_VS_VWAP', 'EMA9_VS_EMA20', 'RSI', 'CANDLE_DIRECTION', 'CONFIRM_15M'] as const) {
      expect(r.diagnostics.find((d) => d.rule === k)?.class, k).toBe('DISAGREE');
    }
    const rvol = r.diagnostics.find((d) => d.rule === 'RVOL')!;
    expect([rvol.class, rvol.sipPass]).toEqual(['DIAGNOSTIC_ONLY', false]); // never a warning trigger
    expect(r.warnings).toEqual([
      'PARITY_WARNING:CLOSE_VS_VWAP', 'PARITY_WARNING:EMA9_VS_EMA20', 'PARITY_WARNING:RSI', 'PARITY_WARNING:CANDLE_DIRECTION', 'PARITY_WARNING:CONFIRM_15M', 'SIP_RVOL_DIAGNOSTIC_ONLY',
    ]);
    // The result type carries diagnostics and warning codes only — there is no blocking / eligibility field.
    expect(Object.keys(r).sort()).toEqual(['diagnostics', 'warnings']);
  });

  it('SHORT alerts use the inverse conditions and RSI < 45', () => {
    const shortOk: SipConditionInputs = { open: 101, close: 100, vwap: 100.5, ema9: 100.2, ema20: 100.8, rsi: 38, rvol: 1.9, close15m: 99, ema20_15m: 100 };
    const r = classifyConditions(shortOk, 'SHORT', TOL);
    expect(r.diagnostics.filter((d) => d.rule !== 'RVOL').every((d) => d.class === 'AGREE')).toBe(true);
    expect(r.diagnostics.find((d) => d.rule === 'RSI')?.label).toBe('RSI14 < 45');
    expect(classifyConditions({ ...shortOk, rsi: 46 }, 'SHORT', TOL).diagnostics.find((d) => d.rule === 'RSI')?.class).toBe('KNIFE_EDGE');
  });

  it('knife-edge margins use the unchanged parity tolerances', () => {
    const r = classifyConditions({ ...AGREE_LONG, close: 100.01, open: 100.0, rsi: 54, vwap: 100.03, ema9: 100.0, ema20: 100.04 }, 'LONG', TOL);
    const cls = Object.fromEntries(r.diagnostics.map((d) => [d.rule, d.class]));
    expect(cls).toMatchObject({ CLOSE_VS_VWAP: 'KNIFE_EDGE', EMA9_VS_EMA20: 'KNIFE_EDGE', RSI: 'KNIFE_EDGE', CANDLE_DIRECTION: 'AGREE' });
    // Close == Open fails "Close > Open" but sits exactly on the threshold → knife-edge, not disagree
    expect(classifyConditions({ ...AGREE_LONG, open: 101, close: 101 }, 'LONG', TOL).diagnostics.find((d) => d.rule === 'CANDLE_DIRECTION')?.class).toBe('KNIFE_EDGE');
    expect(classifyConditions({ ...AGREE_LONG, open: 101.05, close: 101 }, 'LONG', TOL).diagnostics.find((d) => d.rule === 'CANDLE_DIRECTION')?.class).toBe('DISAGREE');
  });

  it('VRSK 2026-10-30 (real SIP values): RVOL 1.413 is diagnostic only; the latest-bound Close vs VWAP gap of $0.011 is knife-edge', () => {
    const r = classifyConditions({ open: 196.35, close: 196.535, vwap: 196.43096, ema9: 196.2868, ema20: 196.0679, rsi: 59.58, rvol: 1.413, close15m: 196.537, ema20_15m: 194.1874 }, 'LONG', TOL);
    expect(r.diagnostics.find((d) => d.rule === 'RVOL')).toMatchObject({ class: 'DIAGNOSTIC_ONLY', sipPass: false });
    expect(r.warnings.some((w) => w.includes('RVOL') && w.startsWith('PARITY_WARNING'))).toBe(false);
    const latest = classifyConditions({ open: 196.35, close: 196.42, vwap: 196.43096, ema9: 196.2868, ema20: 196.0679, rsi: 59.58, rvol: 1.3467, close15m: 196.537, ema20_15m: 194.1874 }, 'LONG', TOL);
    expect(latest.diagnostics.find((d) => d.rule === 'CLOSE_VS_VWAP')?.class).toBe('KNIFE_EDGE');
  });

  it('missing SIP inputs → UNAVAILABLE notes (never an error, never a block)', () => {
    const r = classifyConditions({ ...AGREE_LONG, vwap: null, rvol: null, close15m: null }, 'LONG', TOL);
    expect(r.warnings).toEqual(['SIP_UNAVAILABLE:CLOSE_VS_VWAP', 'SIP_UNAVAILABLE:RVOL', 'SIP_UNAVAILABLE:CONFIRM_15M', 'SIP_RVOL_DIAGNOSTIC_ONLY']);
  });

  it('forming-15m comparison is optional and classified the same way (diagnostic only)', () => {
    const f = { label: '12:15–12:30', close: 99, ema20: 100, bars5: 2 };
    const r = classifyConditions(AGREE_LONG, 'LONG', TOL, f);
    expect(r.diagnostics.find((d) => d.rule === 'CONFIRM_15M_FORMING')?.class).toBe('DISAGREE');
    expect(r.diagnostics.find((d) => d.rule === 'CONFIRM_15M')?.class).toBe('AGREE');
    expect(classifyConditions(AGREE_LONG, 'LONG', TOL, null).warnings).toContain('SIP_UNAVAILABLE:CONFIRM_15M_FORMING');
    expect(classifyConditions(AGREE_LONG, 'LONG', TOL).diagnostics.some((d) => d.rule === 'CONFIRM_15M_FORMING')).toBe(false);
  });
});

describe('forming 15m bucket', () => {
  const D = '2026-10-30';
  const bars = sessionBars(daysUpTo(D));
  it('mid-bucket signal close (12:25) → forming 12:15–12:30 with 2 of 3 bars, no data after the close', () => {
    const f = forming15m(bars, etToEpoch(D, '12:25'))!;
    expect(f).toMatchObject({ label: '12:15–12:30', bars5: 2 });
    const later = bars.map((b) => (b.t >= etToEpoch(D, '12:25') ? { ...b, c: 999 } : b));
    expect(forming15m(later, etToEpoch(D, '12:25'))).toEqual(f);
  });
  it('signal close on a 15m boundary (12:30) → the bucket that just completed (3 bars)', () => {
    const f = forming15m(bars, etToEpoch(D, '12:30'))!;
    expect(f).toMatchObject({ label: '12:15–12:30', bars5: 3 });
    const completed = aggregate15m(bars.filter((b) => b.t + 300_000 <= etToEpoch(D, '12:30'))).slice(-1)[0];
    expect(f.close).toBe(completed.c);
  });
  it('no bars → null', () => expect(forming15m([], etToEpoch(D, '12:30'))).toBeNull());
});
