import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION } from '../alertDecision';
import type { AlertTimeValues } from '../alertSnapshot';
import { buildAlertSnapshot } from '../alertSnapshot';
import { etToEpoch } from '../etTime';
import {
  activeBucket, checkHistoricalRequest, compareHistorical, cutoffsFor, deriveTicket, historicalWindow, intrabarSnapshot, parseEtTimestamp, requestWindows,
  runIntrabarReconstruction, type CheckedRequest, type HistoricalResult,
} from '../historicalParity';
import type { Bar } from '../indicators';
import { atr, ema, rsi, rvol, vwapSession } from '../indicators';
import { etParts } from '../etTime';
import { PARITY_FIELDS, type ParityField } from '../parity';
import { daysUpTo, minuteBars, toFive } from './fixtures';

const D = '2026-10-30';
const at = (hhmmss: string) => etToEpoch(D, hhmmss);
const LATER = at('19:00');
const MIN1 = minuteBars(daysUpTo(D));
const BARS5 = toFive(MIN1);
const req = (alertEt: string, direction: 'LONG' | 'SHORT' = 'LONG', precision?: 'EXACT' | 'MINUTE', symbol = 'IBM'): CheckedRequest => {
  const r = checkHistoricalRequest({ symbol, direction, alertEt, precision }, LATER);
  if (!r.ok) throw new Error(r.errors.join(' '));
  return r;
};
const run = (r: CheckedRequest, min1: Bar[] = MIN1, hist5: Bar[] = BARS5) => runIntrabarReconstruction(hist5, min1, r, { host: 'data.alpaca.markets', windows: requestWindows(r) });

/* IBM regression fixture (values read off TrendSpider / previous IEX run — test data only, never production logic). */
const TS: Record<ParityField, number> = { open: 256.95, high: 258.32, low: 256.95, close: 258.05, atr: 0.525, ema9: 257.12, ema20: 256.82, rsi: 71.3, rvol: 2.043, vwap: 256.79, close15m: 257.06, ema20_15m: 256.52 };
const IEX: AlertTimeValues = { open: 257.25, high: 258.32, low: 257.25, close: 258.03, volume: 1, atr: 0.3635, ema9: 257.1278, ema20: 256.8358, rsi: 70.8445, rvol: 1.9519, vwap: 256.9806, vwapAlternative: null, close15m: 257.03, ema20_15m: 256.5374 };

describe('request validation and precision', () => {
  it('parses ET wall-clock timestamps (DST-correct) and rejects malformed / impossible ones', () => {
    expect(parseEtTimestamp('2026-10-30 15:55:10')).toBe(Date.parse('2026-10-30T15:55:10-04:00'));
    expect(parseEtTimestamp('2026-12-01T10:00')).toBe(Date.parse('2026-12-01T10:00:00-05:00'));
    for (const bad of ['2026-02-30 10:00:00', '2026-10-30 24:00:00', '10/30/2026 15:55', '2026-10-30T15:55:10Z', '', '2026-03-08 02:30:00']) expect(parseEtTimestamp(bad)).toBeNull();
  });
  it('HH:MM:SS → exact second; HH:MM → approximate minute (never silently exact); explicit precision respected', () => {
    expect(req('2026-10-30 15:44:00')).toMatchObject({ precision: 'EXACT_SECOND', alertEt: '2026-10-30 15:44:00', cutoffs: [{ key: 'EXACT', ms: at('15:44:00') }] });
    expect(req('2026-10-30 15:44:20').precision).toBe('EXACT_SECOND_BRACKETED');
    expect(req('2026-10-30 15:44')).toMatchObject({ precision: 'APPROXIMATE_MINUTE', alertEt: '2026-10-30 15:44 (seconds unknown)', cutoffs: [{ key: 'EARLIEST', ms: at('15:44:00') }, { key: 'LATEST', ms: at('15:45:00') }] });
    expect(req('2026-10-30 15:44', 'LONG', 'EXACT').precision).toBe('EXACT_SECOND');
    const bad = checkHistoricalRequest({ symbol: 'IBM', direction: 'LONG', alertEt: '2026-10-30 15:44:10', precision: 'MINUTE' }, LATER);
    expect(bad.ok).toBe(false);
  });
  it('rejects bad ticker / direction / timestamp, and anything whose LATEST cutoff is too recent (before any fetch)', () => {
    const r = checkHistoricalRequest({ symbol: 'IBM1', direction: 'BUY', alertEt: '2026-10-30 15:55' }, LATER);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(2);
    expect(checkHistoricalRequest({ symbol: 'IBM', direction: 'LONG', alertEt: '2026-10-30 15:44' }, at('15:44') + 16.5 * 60_000).ok).toBe(false); // latest cutoff 15:45 is < 16 min old
    expect(checkHistoricalRequest({ symbol: 'IBM', direction: 'LONG', alertEt: '2026-10-30 15:44' }, at('15:45') + 16 * 60_000).ok).toBe(true);
  });
  it('request windows: 5m history ends before the active bucket; 1m bars cover only the bucket up to the latest cutoff', () => {
    const w = requestWindows(req('2026-10-30 15:44'));
    expect(w.history5m).toEqual({ startIso: historicalWindow(at('15:44')).startIso, endIso: new Date(at('15:39:59')).toISOString() });
    expect(w.intrabar1m).toEqual({ startIso: new Date(at('15:40')).toISOString(), endIso: new Date(at('15:44:59')).toISOString() });
    expect(requestWindows(req('2026-10-30 15:44:00')).intrabar1m.endIso).toBe(new Date(at('15:43:59')).toISOString());
  });
});

describe('active 5m bucket and completed 15m candle', () => {
  it('(1) 15:44:00 → active 15:40–15:45; (2) 15:54:00 → 15:50–15:55; boundaries floor to the grid', () => {
    expect(activeBucket(at('15:44:00')).label).toBe('15:40–15:45');
    expect(activeBucket(at('15:54:00')).label).toBe('15:50–15:55');
    expect(activeBucket(at('15:44:59')).label).toBe('15:40–15:45');
    expect(activeBucket(at('15:45:00')).label).toBe('15:45–15:50');
  });
  it('(3) the 15m confirmation stays the last COMPLETED 15m candle (unchanged rule)', () => {
    expect(run(req('2026-10-30 15:44')).timing.confirm15mLabel).toBe('15:15–15:30');
    expect(run(req('2026-10-30 15:54')).timing.confirm15mLabel).toBe('15:30–15:45');
    expect(run(req('2026-10-30 10:16:00')).timing.confirm15mLabel).toBe('10:00–10:15');
    expect(run(req('2026-10-30 10:14:00')).timing.confirm15mLabel).toBe('09:45–10:00');
  });
});

describe('partial signal candle — no future data', () => {
  const r = req('2026-10-30 15:44:00');
  const s = intrabarSnapshot(BARS5, MIN1, r.alertMs, r.cutoffs[0].ms, 'LONG');
  const mins = MIN1.filter((b) => b.t >= at('15:40') && b.t < at('15:44'));
  it('(4)(5)(7) EXACT 15:44:00 uses the 1m bars 15:40–15:43 only (bar 15:44 covers trades ≥ 15:44:00 and is excluded)', () => {
    expect(s.minutesUsed).toEqual(['15:40', '15:41', '15:42', '15:43']);
    expect(s.cutoffEt).toBe('15:44:00');
    expect(s.values).toMatchObject({ open: mins[0].o, high: Math.max(...mins.map((b) => b.h)), low: Math.min(...mins.map((b) => b.l)), close: mins[3].c, volume: mins.reduce((a, b) => a + b.v, 0) });
    expect(s.signal?.label).toBe('15:40–15:45');
  });
  it('(6) indicators are the shared functions on [completed 5m history + the synthetic partial bar]', () => {
    const hist = BARS5.filter((b) => b.t + 300_000 <= at('15:40'));
    const p = s.values!;
    const series: Bar[] = [...hist, { t: at('15:40'), o: p.open, h: p.high, l: p.low, c: p.close, v: p.volume }];
    const n = series.length - 1;
    const closes = series.map((b) => b.c);
    expect(p.ema9).toBe(ema(closes, 9)[n]);
    expect(p.ema20).toBe(ema(closes, 20)[n]);
    expect(p.rsi).toBe(rsi(closes, 14)[n]);
    expect(p.atr).toBe(atr(series, 14)[n]);
    expect(p.rvol).toBe(rvol(series.map((b) => b.v), 20)[n]);
    expect(p.vwap).toBe(vwapSession(series, (b) => etParts(b.t).date)[n]);
    // and differs from the completed 15:40–15:45 bar (the old, leaky behaviour)
    const full = buildAlertSnapshot(BARS5, at('15:45:05'), 'LONG').values!;
    expect([p.high, p.close, p.volume, p.rvol]).not.toEqual([full.high, full.close, full.volume, full.rvol]);
  });
  it('(9) no leakage: changing any data at/after the cutoff changes nothing', () => {
    const spiked = MIN1.map((b) => (b.t >= at('15:44') ? { ...b, h: b.h + 50, l: b.l - 50, c: b.c + 20, v: b.v * 100 } : b));
    const spiked5 = BARS5.map((b) => (b.t >= at('15:40') ? { ...b, h: 999, v: 1e9 } : b));
    expect(intrabarSnapshot(spiked5, spiked, r.alertMs, r.cutoffs[0].ms, 'LONG')).toEqual(s);
  });
  it('an alert exactly at a bucket start has no active-candle data → fail closed', () => {
    const z = intrabarSnapshot(BARS5, MIN1, at('15:45:00'), at('15:45:00'), 'LONG');
    expect(z.values).toBeNull();
    expect(z.issues.map((i) => i.code)).toContain('NO_INTRABAR_DATA');
  });
  it('missing minutes / insufficient history fail closed or flag review', () => {
    const gap = intrabarSnapshot(BARS5, MIN1.filter((b) => b.t !== at('15:41')), r.alertMs, r.cutoffs[0].ms, 'LONG');
    expect(gap.issues.map((i) => i.code)).toContain('INTRABAR_MINUTES_MISSING');
    const thin = intrabarSnapshot(BARS5.slice(-20), MIN1, r.alertMs, r.cutoffs[0].ms, 'LONG');
    expect(thin.values).toBeNull();
    expect(thin.issues.map((i) => i.code)).toContain('INSUFFICIENT_HISTORY');
  });
});

describe('(7)(8) precision modes', () => {
  it('approximate minute → EARLIEST (through :00) and LATEST (through :59) bounds, labelled approximate', () => {
    const res = run(req('2026-10-30 15:44'));
    expect(res.precision).toBe('APPROXIMATE_MINUTE');
    expect(res.bounds.map((b) => [b.key, b.snapshot.cutoffEt, b.snapshot.minutesUsed.length])).toEqual([['EARLIEST', '15:44:00', 4], ['LATEST', '15:45:00', 5]]);
    expect(res.notices.map((n) => n.code)).toEqual(['APPROXIMATE_INTRABAR_RECONSTRUCTION', 'RVOL_SEMANTICS_UNDER_VALIDATION']);
  });
  it('exact second with seconds ≠ 00 → INTRABAR_TIME_PRECISION_LIMITATION and a bracket (never presented as exact)', () => {
    const res = run(req('2026-10-30 15:44:20'));
    expect(res.precision).toBe('EXACT_SECOND_BRACKETED');
    expect(res.notices[0].code).toBe('INTRABAR_TIME_PRECISION_LIMITATION');
    expect(res.bounds.map((b) => b.snapshot.cutoffEt)).toEqual(['15:44:00', '15:45:00']);
    expect(cutoffsFor(at('15:44:00'), 'EXACT_SECOND')).toEqual([{ key: 'EXACT', ms: at('15:44:00') }]);
  });
});

describe('comparison across bounds (existing tolerances, unchanged)', () => {
  it('PASS if within tolerance of a bound; BETWEEN if between bounds but within neither; MISMATCH otherwise', () => {
    const mk = (v: Partial<AlertTimeValues>) => ({ key: 'EARLIEST' as const, snapshot: { values: { ...IEX, ...v } } }) as HistoricalResult['bounds'][number];
    const res = { bounds: [mk({ high: 100 }), { ...mk({ high: 101 }), key: 'LATEST' as const }] };
    const rows = compareHistorical(res, { high: 100.5, open: 257.25, low: 999 }, DEFAULT_AUTOMATION.parity);
    expect(Object.fromEntries(rows.map((r) => [r.field, r.result]))).toEqual({ open: 'PASS', high: 'BETWEEN', low: 'MISMATCH' });
    expect(rows.find((r) => r.field === 'open')?.passedAt).toEqual(['EARLIEST', 'LATEST']);
  });
});

describe('(10) IBM regression — alert ≈ 15:54 LONG', () => {
  const res = run(req('2026-10-30 15:54'));
  it('active 15:50–15:55, 15m 15:30–15:45; the LATEST bound equals the completed 15:50–15:55 candle (the old 12/12 result)', () => {
    expect(res.timing.activeLabel).toBe('15:50–15:55');
    expect(res.timing.confirm15mLabel).toBe('15:30–15:45');
    const old = buildAlertSnapshot(BARS5, at('15:55:10'), 'LONG');
    expect(old.signal?.label).toBe('15:50–15:55');
    expect(res.bounds[1].snapshot.values).toEqual(old.values);
    expect(res.bounds[0].snapshot.minutesUsed).toEqual(['15:50', '15:51', '15:52', '15:53']);
  });
  it('previous IEX values still mismatch TrendSpider on Open, Low, ATR, VWAP, 15m Close (default tolerances)', () => {
    const fake = { bounds: [{ key: 'EXACT' as const, snapshot: { values: IEX } }] } as unknown as HistoricalResult;
    expect(compareHistorical(fake, TS, DEFAULT_AUTOMATION.parity).filter((x) => x.result !== 'PASS').map((x) => x.field)).toEqual(['open', 'low', 'atr', 'vwap', 'close15m']);
    expect(compareHistorical(fake, TS, DEFAULT_AUTOMATION.parity)).toHaveLength(PARITY_FIELDS.length);
  });
  it('derived ticket from the TrendSpider values (existing calculator): 258.37 / 256.95 / 261.21, 77 sh; NOT ELIGIBLE after 15:30', () => {
    const t = deriveTicket('IBM', 'LONG', at('15:54'), TS)!;
    expect(t).toMatchObject({ side: 'LONG', action: 'BUY', orderType: 'BUY STOP', entry: 258.37, stop: 256.95, target: 261.21, riskPerShare: 1.42, riskMethod: 'STRUCTURAL', shares: 77, limitedBy: 'INVESTMENT', rewardRatio: 2, calcAction: 'NOT_ELIGIBLE' });
    expect(t.plannedRisk).toBeCloseTo(109.34, 2);
    expect(t.potentialProfit).toBeCloseTo(218.68, 2);
    expect(t.hardFails.join(' ')).toMatch(/15:30/);
  });
});

describe('(11) NEE regression — alert ≈ 15:44 SHORT', () => {
  const down = minuteBars(daysUpTo(D), { price: (i) => 80 - 0.004 * i + [0, -0.03, 0.02, -0.05, -0.01][i % 5] });
  const res = run(req('2026-10-30 15:44', 'SHORT', undefined, 'NEE'), down, toFive(down));
  it('active signal candle 15:40–15:45 (not the completed 15:35–15:40); completed 15m 15:15–15:30', () => {
    expect(res.timing.activeLabel).toBe('15:40–15:45');
    for (const b of res.bounds) expect(b.snapshot.signal?.label).toBe('15:40–15:45');
    expect(res.timing.confirm15mLabel).toBe('15:15–15:30');
    expect(buildAlertSnapshot(toFive(down), at('15:44:00'), 'SHORT').signal?.label).toBe('15:35–15:40'); // what the old diagnostic picked
    expect(res.bounds[0].snapshot.values?.open).toBe(down.find((b) => b.t === at('15:40'))?.o);
  });
  it('derived ticket is a SELL STOP labelled diagnostic; NOT ELIGIBLE (after 15:30)', () => {
    const d = res.bounds[0].derived!;
    expect(d).toMatchObject({ side: 'SHORT', action: 'SELL', orderType: 'SELL STOP', calcAction: 'NOT_ELIGIBLE' });
  });
  it('result is diagnostic only: no id / dedupe key / status / quote', () => {
    expect(res).toMatchObject({ mode: 'HISTORICAL_DIAGNOSTIC', reconstruction: 'INTRABAR', provider: { feed: 'sip' }, request: { endpoint: 'bars', currentPriceFetched: false } });
    for (const k of ['id', 'dedupeKey', 'status', 'receivedMs', 'initialQuote']) expect(res).not.toHaveProperty(k);
  });
});
