import { describe, expect, it } from 'vitest';
import { atr, ema, rsi, rvol, sma, trueRange, vwapRolling, vwapSession, type Bar } from '../indicators';
import { etParts, etToEpoch, mmss, parseIsoWithZone } from '../etTime';
import { previousTradingDates, sessionFor } from '../marketCalendar';
import { dedupeKey, parseAlertPayload, withoutSecrets } from '../alertPayload';

/* ───────────────────────── indicators ───────────────────────── */

describe('EMA / SMA', () => {
  it('SMA(3)', () => expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]));
  it('EMA(3) of 1..10 is seeded with the SMA and then equals x − 1 (α = 0.5)', () => {
    expect(ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)).toEqual([null, null, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
  it('EMA is null (never 0) until n values exist', () => expect(ema([5, 6], 9)).toEqual([null, null]));
  it('EMA(9)/EMA(20) α = 2/(n+1)', () => {
    const xs = Array.from({ length: 30 }, (_, i) => 100 + i);
    const e9 = ema(xs, 9);
    expect(e9[8]).toBeCloseTo(104, 10); // SMA of 100..108
    expect(e9[9]).toBeCloseTo(0.2 * 109 + 0.8 * 104, 10);
  });
});

describe('RSI(14) — Wilder (classic StockCharts example)', () => {
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64];
  const r = rsi(closes, 14);
  it('first value at the 15th close; exact Wilder values (TA-Lib) 70.46 / 66.25 / 66.48 / 69.35 …', () => {
    expect(r.slice(0, 14).every((x) => x === null)).toBe(true);
    expect(r.slice(14, 18).map((x) => +(x as number).toFixed(2))).toEqual([70.46, 66.25, 66.48, 69.35]);
  });
  it('within 0.1 of the published StockCharts table (which rounds its intermediate averages)', () => {
    const published = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97];
    r.slice(14).forEach((x, i) => expect(Math.abs((x as number) - published[i])).toBeLessThan(0.1));
  });
  it('only gains → 100; flat → 50', () => {
    expect(rsi(Array.from({ length: 16 }, (_, i) => i), 14)[15]).toBe(100);
    expect(rsi(Array(16).fill(5), 14)[15]).toBe(50);
  });
});

describe('ATR(14) — Wilder', () => {
  const b = (o: number, h: number, l: number, c: number): Bar => ({ t: 0, o, h, l, c, v: 1 });
  it('true range uses the previous close (gaps count)', () => {
    expect(trueRange([b(10, 11, 9, 10), b(12, 13, 12, 12.5)])).toEqual([2, 3]); // 13 − prev close 10
  });
  it('seeded with the SMA of the first n TR, then RMA', () => {
    const bars = [b(10, 11, 9, 10), b(10, 12, 10, 11), b(11, 12, 10, 11), b(11, 13, 11, 12)]; // TR 2, 2, 2, 2
    const a = atr(bars, 3);
    expect(a).toEqual([null, null, 2, 2]);
    const bars2 = [...bars, b(12, 16, 12, 15)]; // TR 4
    expect(atr(bars2, 3)[4]).toBeCloseTo((2 * 2 + 4) / 3, 12);
  });
});

describe('RVOL(20) = Volume ÷ SMA(Volume, 20) including the current bar', () => {
  it('4-bar example', () => expect(rvol([10, 10, 10, 40], 4)[3]).toBeCloseTo(40 / 17.5, 12));
  it('20-bar: 19 × 1000 + 4000 → 4000 / 1150', () => {
    const v = [...Array(19).fill(1000), 4000];
    expect(rvol(v, 20)[19]).toBeCloseTo(4000 / 1150, 12);
    expect(rvol(v, 20)[18]).toBeNull();
  });
});

describe('VWAP (HLC3)', () => {
  const bars: Bar[] = [
    { t: 1, o: 10, h: 12, l: 9, c: 11, v: 100 }, // HLC3 10.6667
    { t: 2, o: 11, h: 13, l: 11, c: 12, v: 300 }, // HLC3 12
    { t: 3, o: 20, h: 21, l: 19, c: 20, v: 100 }, // new session
  ];
  it('session VWAP restarts each trading day', () => {
    const v = vwapSession(bars, (b) => (b.t < 3 ? 'd1' : 'd2'));
    expect(v[1]).toBeCloseTo((32 / 3 * 100 + 12 * 300) / 400, 10);
    expect(v[2]).toBeCloseTo(20, 10);
  });
  it('rolling VWAP over the last n bars (the alternative reading of VWAP(14))', () => {
    expect(vwapRolling(bars, 2)[2]).toBeCloseTo((12 * 300 + 20 * 100) / 400, 10);
    expect(vwapRolling(bars, 2)[0]).toBeNull();
  });
});

/* ───────────────────────── time zone, calendar ───────────────────────── */

describe('America/New_York time (never the browser/server zone)', () => {
  it('EDT and EST conversions, including after the DST changes', () => {
    expect(new Date(etToEpoch('2026-10-30', '10:00')).toISOString()).toBe('2026-10-30T14:00:00.000Z'); // EDT
    expect(new Date(etToEpoch('2026-11-02', '10:00')).toISOString()).toBe('2026-11-02T15:00:00.000Z'); // EST (DST ended Nov 1)
    expect(etParts(Date.parse('2026-03-09T14:30:00Z')).hhmm).toBe('10:30'); // DST started Mar 8
    expect(etParts(Date.parse('2026-03-06T14:30:00Z')).hhmm).toBe('09:30');
  });
  it('alert timestamps need an explicit offset (naive times are ambiguous)', () => {
    expect(parseIsoWithZone('2026-10-30T14:30:00-04:00')).toBe(Date.parse('2026-10-30T18:30:00Z'));
    expect(parseIsoWithZone('2026-10-30T18:30:00Z')).toBe(Date.parse('2026-10-30T18:30:00Z'));
    expect(parseIsoWithZone('2026-10-30T14:30:00')).toBeNull();
    expect(parseIsoWithZone('10/30/2026 2:30 PM')).toBeNull();
  });
  it('mm:ss', () => expect([mmss(42_000), mmss(558_000), mmss(-5)]).toEqual(['00:42', '09:18', '00:00']));
});

describe('market calendar (fail closed outside the loaded years)', () => {
  it('full day, holiday, early close, weekend, unknown year', () => {
    expect(sessionFor('2026-10-30').kind).toBe('FULL');
    expect(sessionFor('2026-11-26').kind).toBe('HOLIDAY');
    expect(sessionFor('2026-11-27')).toMatchObject({ kind: 'EARLY_CLOSE', close: '13:00' });
    expect(sessionFor('2026-10-31').kind).toBe('WEEKEND');
    expect(sessionFor('2028-03-01').kind).toBe('UNKNOWN');
  });
  it('previous trading dates skip weekends and holidays', () => {
    expect(previousTradingDates('2026-11-30', 3)).toEqual(['2026-11-27', '2026-11-25', '2026-11-24']);
  });
});

/* ───────────────────────── webhook payload ───────────────────────── */

describe('webhook payload validation', () => {
  const now = Date.parse('2026-10-30T18:31:00Z');
  const good = { strategy: 'RB_V1', symbol: 'nvda', direction: 'SHORT', alert_name: 'RB v1 SHORT Setup', last_price: '212.44', alert_time: '2026-10-30T14:30:00-04:00' };
  it('parses the documented JSON', () => {
    const r = parseAlertPayload(good, now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.alert).toMatchObject({ symbol: 'NVDA', direction: 'SHORT', lastPrice: 212.44, alertTimeIso: '2026-10-30T18:30:00.000Z', test: false });
  });
  it.each([
    ['wrong strategy', { ...good, strategy: 'OTHER' }],
    ['bad ticker', { ...good, symbol: 'NVDA;DROP' }],
    ['unknown direction', { ...good, direction: 'UP' }],
    ['direction contradicts the alert name', { ...good, direction: 'LONG' }],
    ['naive timestamp', { ...good, alert_time: '2026-10-30 14:30' }],
    ['future timestamp', { ...good, alert_time: '2026-10-30T15:30:00-04:00' }],
    ['ancient replay', { ...good, alert_time: '2026-10-28T14:30:00-04:00' }],
    ['negative price', { ...good, last_price: '-1' }],
    ['non-numeric price', { ...good, last_price: 'abc' }],
  ])('rejects %s', (_, body) => expect(parseAlertPayload(body, now).ok).toBe(false));
  it('missing alert_time → server receipt time, labelled RECEIVED; a malformed one is still rejected', () => {
    const r = parseAlertPayload({ ...good, alert_time: undefined }, now);
    expect(r.ok && [r.alert.alertTimeMs, r.alert.timeSource]).toEqual([now, 'RECEIVED']);
    const g = parseAlertPayload(good, now);
    expect(g.ok && g.alert.timeSource).toBe('PAYLOAD');
    expect(parseAlertPayload({ ...good, alert_time: 'yesterday' }, now).ok).toBe(false);
  });
  it('rejects non-objects', () => {
    for (const b of [null, 'x', 42, []]) expect(parseAlertPayload(b, now).ok).toBe(false);
  });
  it('direction may come from the alert name; BUY/SELL accepted', () => {
    const r = parseAlertPayload({ ...good, direction: undefined, alert_name: 'RB v1 LONG Setup' }, now);
    expect(r.ok && r.alert.direction).toBe('LONG');
    const s = parseAlertPayload({ ...good, direction: 'sell' }, now);
    expect(s.ok && s.alert.direction).toBe('SHORT');
  });
  it('dedupe key = ticker + direction + timestamp + alert type; secrets stripped', () => {
    const r = parseAlertPayload(good, now);
    expect(r.ok && dedupeKey(r.alert)).toBe(`NVDA|SHORT|${Date.parse('2026-10-30T18:30:00Z') / 1000}|RB_V1_SHORT_SETUP`);
    expect(withoutSecrets({ ...good, token: 's3cret', secret: 'x', apiKey: 'y' })).toEqual(good);
  });
});
