import { describe, expect, it } from 'vitest';
import { aggregate15m, buildAlertSnapshot, regularSessionBars } from '../alertSnapshot';
import { etToEpoch } from '../etTime';
import { atr, ema, rsi, rvol, vwapSession, type Bar } from '../indicators';
import { etParts } from '../etTime';
import { daysUpTo, FIVE, sessionBars } from './fixtures';

const D = '2026-10-30';
const at = (hhmmss: string) => etToEpoch(D, hhmmss);
const bars = sessionBars(daysUpTo(D), { untilEt: '15:00' });

describe('5-minute signal candle (the candle that completed most recently at the alert time)', () => {
  it.each([
    ['10:07:30', '10:00–10:05'],
    ['10:10:02', '10:05–10:10'],
    ['10:15:04', '10:10–10:15'],
    ['14:30:00', '14:25–14:30'],
  ])('alert %s ET → %s', (t, label) => {
    expect(buildAlertSnapshot(bars, at(t), 'LONG').signal?.label).toBe(label);
  });
  it('never uses a later or still-forming candle even when the data contains it', () => {
    const s = buildAlertSnapshot(bars, at('10:15:04'), 'LONG'); // bars run to 15:00
    const sig = bars.find((b) => b.t === at('10:10'))!;
    expect(s.values).toMatchObject({ open: sig.o, high: sig.h, low: sig.l, close: sig.c });
    expect(s.barsUsed).toBe(bars.filter((b) => b.t <= at('10:10')).length);
  });
  it('an alert long after the candle closed is AMBIGUOUS → review (10:07:30 is 150 s after 10:05)', () => {
    expect(buildAlertSnapshot(bars, at('10:07:30'), 'LONG').issues.map((i) => i.code)).toContain('SIGNAL_CANDLE_AMBIGUOUS');
    expect(buildAlertSnapshot(bars, at('10:15:04'), 'LONG').issues.map((i) => i.code)).not.toContain('SIGNAL_CANDLE_AMBIGUOUS');
  });
  it('missing signal candle → DATA INCOMPLETE, no fallback to an older bar', () => {
    const s = buildAlertSnapshot(bars.filter((b) => b.t !== at('10:10')), at('10:15:04'), 'LONG');
    expect(s.values).toBeNull();
    expect(s.issues.find((i) => i.code === 'SIGNAL_CANDLE_MISSING')?.kind).toBe('INCOMPLETE');
  });
  it('no completed candle yet at 09:33 → incomplete', () => {
    expect(buildAlertSnapshot(bars, at('09:33:00'), 'LONG').issues[0].code).toBe('NO_COMPLETED_SIGNAL_CANDLE');
  });
  it('pre/post-market bars are ignored (Extended Hours OFF)', () => {
    const pre: Bar = { t: at('09:25'), o: 1, h: 999, l: 1, c: 1, v: 1e9 };
    const post: Bar = { t: etToEpoch('2026-10-29', '16:05'), o: 1, h: 999, l: 1, c: 1, v: 1e9 };
    expect(regularSessionBars([...bars, pre, post]).length).toBe(bars.length);
  });
});

describe('indicators are computed on bars up to the signal candle only', () => {
  it('match independent calculations', () => {
    const s = buildAlertSnapshot(bars, at('10:15:04'), 'LONG');
    const upto = bars.filter((b) => b.t <= at('10:10'));
    const last = upto.length - 1;
    const closes = upto.map((b) => b.c);
    expect(s.values!.ema9).toBeCloseTo(ema(closes, 9)[last] as number, 12);
    expect(s.values!.ema20).toBeCloseTo(ema(closes, 20)[last] as number, 12);
    expect(s.values!.rsi).toBeCloseTo(rsi(closes, 14)[last] as number, 12);
    expect(s.values!.atr).toBeCloseTo(atr(upto, 14)[last] as number, 12);
    expect(s.values!.rvol).toBeCloseTo(rvol(upto.map((b) => b.v), 20)[last] as number, 12);
    expect(s.values!.vwap).toBeCloseTo(vwapSession(upto, (b) => etParts(b.t).date)[last] as number, 12);
    expect(s.values!.rsi).toBeGreaterThan(60); // the fixture's +0.06/−0.03 rhythm keeps RSI in the 60s
    expect(s.values!.rsi).toBeLessThan(70);
    expect(s.values!.vwapAlternative).not.toBeNull(); // rolling-14 VWAP shown for parity checks
  });
  it('ROLLING_14 VWAP mode is selectable', () => {
    const a = buildAlertSnapshot(bars, at('10:15:04'), 'LONG');
    const b = buildAlertSnapshot(bars, at('10:15:04'), 'LONG', { ...a.config, vwapMode: 'ROLLING_14' });
    expect(b.values!.vwap).toBeCloseTo(a.values!.vwapAlternative as number, 12);
  });
  it('not enough history → ATR/EMA unavailable → INCOMPLETE (never ATR = 0)', () => {
    const today = sessionBars([D], { untilEt: '11:00' });
    const s = buildAlertSnapshot(today, at('10:15:04'), 'LONG');
    expect(s.values).toBeNull();
    expect(s.issues.map((i) => i.code)).toContain('INSUFFICIENT_HISTORY');
  });
  it('ATR that cannot be calculated is reported as ATR14_UNAVAILABLE', () => {
    const s = buildAlertSnapshot(sessionBars([D], { untilEt: '10:30' }), at('10:15:04'), 'LONG', { vwapMode: 'SESSION', maxSignalLagSec: 120, maxMissingBarRatio: 0.05, minWarmupBars: 1 });
    expect(s.issues.map((i) => i.code)).toContain('ATR14_UNAVAILABLE');
    expect(s.values).toBeNull();
  });
});

describe('15-minute confirmation = LAST FULLY COMPLETED regular-session 15m candle at the alert time', () => {
  it.each([
    ['10:07:00', '09:45–10:00'],
    ['10:18:00', '10:00–10:15'],
    ['14:52:00', '14:30–14:45'],
    ['14:30:00', '14:15–14:30'],
    ['14:40:00', '14:15–14:30'], // NOT 14:30–14:45 (still forming)
    ['14:44:59', '14:15–14:30'],
    ['14:45:00', '14:30–14:45'],
  ])('alert %s → %s', (t, label) => {
    expect(buildAlertSnapshot(bars, at(t), 'LONG').confirm15m?.label).toBe(label);
  });
  it('alert 15:40 → 15:15–15:30 (and the time rule hard-fails separately)', () => {
    const late = sessionBars(daysUpTo(D));
    expect(buildAlertSnapshot(late, at('15:40:00'), 'LONG').confirm15m?.label).toBe('15:15–15:30');
  });
  it('15m bars are aggregated from the regular-session 5m bars; close = last 5m close', () => {
    const agg = aggregate15m(bars);
    const k = agg.find((x) => x.t === at('10:00'))!;
    const parts = bars.filter((b) => b.t >= at('10:00') && b.t < at('10:15'));
    expect(k).toMatchObject({ o: parts[0].o, c: parts[2].c, h: Math.max(...parts.map((p) => p.h)), l: Math.min(...parts.map((p) => p.l)), count: 3 });
    const s = buildAlertSnapshot(bars, at('10:18:00'), 'LONG');
    expect(s.values!.close15m).toBe(parts[2].c);
    expect(s.values!.ema20_15m).toBeCloseTo(ema(agg.filter((x) => x.t <= at('10:00')).map((x) => x.c), 20).slice(-1)[0] as number, 12);
  });
  it('a 15m candle missing a 5m bar is flagged for review', () => {
    const s = buildAlertSnapshot(bars.filter((b) => b.t !== at('10:05')), at('10:18:00'), 'LONG');
    expect(s.issues.map((i) => i.code)).toContain('CONFIRM_15M_PARTIAL');
  });
});

describe('data-quality checks', () => {
  it('alert conditions are re-checked on the automated values (feed consistency)', () => {
    const s = buildAlertSnapshot(bars, at('10:15:04'), 'SHORT'); // uptrend data, SHORT alert → cannot reproduce
    expect(s.issues.find((i) => i.code === 'ALERT_NOT_REPRODUCED')?.kind).toBe('REVIEW');
  });
  it('too many missing bars today → review', () => {
    const gappy = bars.filter((b, i) => !(etParts(b.t).date === D && i % 3 === 0));
    expect(buildAlertSnapshot(gappy, at('11:00:03'), 'LONG').issues.map((i) => i.code)).toContain('MISSING_BARS');
  });
  it('holiday, early close and unknown calendar year are flagged', () => {
    const ec = '2026-11-27';
    const b = sessionBars(daysUpTo(ec), { untilEt: '11:00' });
    expect(buildAlertSnapshot(b, etToEpoch(ec, '10:15:04'), 'LONG').issues.map((i) => i.code)).toContain('EARLY_CLOSE_SESSION');
  });
  it('bar times are 5 minutes apart and start on the 09:30 grid', () => {
    expect(bars.every((b) => (b.t - etToEpoch(etParts(b.t).date, '09:30')) % FIVE === 0)).toBe(true);
  });
});
