import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAlertSnapshot } from '../alertSnapshot';
import { etToEpoch } from '../etTime';
import { checkHistoricalRequest, historicalParityRvol, intrabarSnapshot, requestWindows, runIntrabarReconstruction, RVOL_PARITY_FORMULA } from '../historicalParity';
import { rvol, type Bar } from '../indicators';
import { daysUpTo, minuteBars, toFive } from './fixtures';

/**
 * Phase 1 — Historical SIP diagnostic RVOL aligned with TrendSpider: RVOL(t) = Volume(t) / SMA20(Volume) ending at t−1.
 * The live snapshot builder and the shared rvol() keep the legacy same-bar window (asserted below).
 */
const D = '2026-10-30';
const at = (hhmm: string) => etToEpoch(D, hhmm);
const FIVE = 300_000;
const MIN1 = minuteBars(daysUpTo(D), { vol: (i) => 1_000 + ((i * 37) % 23) * 120 });
const BARS5 = toFive(MIN1);
const req = (alertEt: string) => {
  const r = checkHistoricalRequest({ symbol: 'VRSK', direction: 'LONG', alertEt }, etToEpoch(D, '19:00'));
  if (!r.ok) throw new Error(r.errors.join(' '));
  return r;
};

/** 20 completed 5m bars ending just before `startHhmm` on D, with the given volumes (oldest first). */
const priorBars = (startHhmm: string, vols: number[]): Bar[] =>
  vols.map((v, i) => ({ t: at(startHhmm) - (vols.length - i) * FIVE, o: 1, h: 1, l: 1, c: 1, v }));
/** Volumes with an exact mean of `sma` that are not all equal (alternating ± spread). */
const around = (sma: number, spread = 500) => Array.from({ length: 20 }, (_, i) => sma + (i % 2 ? spread : -spread));

describe('TrendSpider-parity RVOL — denominator alignment', () => {
  it('(1) the current candle is excluded from its own denominator', () => {
    const hist = priorBars('12:30', around(3_558));
    const a = historicalParityRvol(hist, at('12:30'), 4_432);
    const b = historicalParityRvol(hist, at('12:30'), 44_320);
    expect(a.baseline).toBe(3_558);
    expect(b.baseline).toBe(3_558); // a 10× current candle does not move the baseline
    expect(a.value).toBe(4_432 / 3_558);
    expect(a.formula).toBe(RVOL_PARITY_FORMULA);
  });

  it('(2) the denominator is exactly the previous 20 completed 5m candles', () => {
    const vols = Array.from({ length: 25 }, (_, i) => 1_000 + i * 100);
    const hist = priorBars('12:30', vols);
    const p = historicalParityRvol(hist, at('12:30'), 5_000);
    expect(p.baselineBars).toHaveLength(20);
    expect(p.baselineBars.map((x) => x.v)).toEqual(vols.slice(-20));
    expect(p.baselineBars[19].t).toBe(at('12:25'));
    expect(p.baseline).toBe(vols.slice(-20).reduce((a, b) => a + b, 0) / 20);
    // the 21st-back candle has no effect; the 20th-back does
    expect(historicalParityRvol(hist.map((b, i) => (i === 4 ? { ...b, v: 1e9 } : b)), at('12:30'), 5_000).baseline).toBe(p.baseline);
    expect(historicalParityRvol(hist.map((b, i) => (i === 5 ? { ...b, v: 1e9 } : b)), at('12:30'), 5_000).baseline).not.toBe(p.baseline);
    // a candle at or after the active start never enters (even if a provider returned it)
    expect(historicalParityRvol([...hist, { t: at('12:30'), o: 1, h: 1, l: 1, c: 1, v: 1e9 }], at('12:30'), 5_000).baseline).toBe(p.baseline);
  });

  it('fewer than 20 completed candles (or a zero baseline) → null, never a guess', () => {
    expect(historicalParityRvol(priorBars('12:30', around(3_000).slice(0, 19)), at('12:30'), 100)).toMatchObject({ baseline: null, value: null });
    expect(historicalParityRvol(priorBars('12:30', new Array(20).fill(0)), at('12:30'), 100).value).toBeNull();
  });

  it('(3)(4) intrabar: numerator = partial volume up to the cutoff; denominator frozen across EARLIEST / LATEST', () => {
    const r = req('2026-10-30 12:28');
    const res = runIntrabarReconstruction(BARS5, MIN1, r, { host: 'h', windows: requestWindows(r) });
    const [e, l] = res.bounds.map((b) => b.snapshot);
    const prior20 = BARS5.filter((b) => b.t + FIVE <= at('12:25')).slice(-20);
    const sma = prior20.reduce((a, b) => a + b.v, 0) / 20;
    expect(e.rvolParity!.baseline).toBe(sma);
    expect(l.rvolParity!.baseline).toBe(sma);
    expect(e.rvolParity!.baselineBars).toEqual(l.rvolParity!.baselineBars);
    const partial = (until: string) => MIN1.filter((b) => b.t >= at('12:25') && b.t < at(until)).reduce((a, b) => a + b.v, 0);
    expect(e.rvolParity!.currentVolume).toBe(partial('12:28'));
    expect(l.rvolParity!.currentVolume).toBe(partial('12:29'));
    expect(e.values!.rvol).toBe(partial('12:28') / sma);
    expect(l.values!.rvol).toBe(partial('12:29') / sma);
    expect(l.values!.rvol).toBeGreaterThan(e.values!.rvol); // only the numerator grows
  });

  it('the RVOL20 > 1.5 condition is evaluated on the parity value', () => {
    const r = req('2026-10-30 12:28');
    for (const b of runIntrabarReconstruction(BARS5, MIN1, r, { host: 'h', windows: requestWindows(r) }).bounds) {
      expect(b.snapshot.alertConditions.find((c) => c.label === 'RVOL20 > 1.5')?.pass).toBe(b.snapshot.values!.rvol > 1.5);
    }
  });
});

describe('(5)–(10) VRSK examples read off TrendSpider (Volume, prior-candle SMA20 → RVOL)', () => {
  const CASES: [string, number, number, string][] = [
    ['12:00', 100, 2_922, '0.034'],
    ['12:05', 692, 2_864, '0.242'],
    ['12:10', 658, 2_808, '0.234'],
    ['12:20', 12_177, 2_797, '4.354'],
    ['12:25', 6_649, 3_310, '2.009'],
    ['12:30', 4_432, 3_558, '1.246'],
  ];
  for (const [hhmm, vol, sma, ts] of CASES) {
    it(`VRSK ${hhmm}: ${vol} / ${sma} → TrendSpider ${ts}`, () => {
      const p = historicalParityRvol(priorBars(hhmm, around(sma)), at(hhmm), vol);
      expect(p.baseline).toBe(sma);
      expect(p.value!.toFixed(3)).toBe(ts);
    });
  }
  it('the legacy same-bar formula does NOT reproduce TrendSpider on the same inputs (why the diagnostic changed)', () => {
    const vols = [...around(2_797), 12_177];
    expect(rvol(vols, 20)[20]!.toFixed(3)).not.toBe('4.354');
  });
  it('VRSK real Alpaca SIP volumes 2026-10-30 (completed candles): 12:30 = 8,181 / 8,111 = 1.0086; 12:25 = 11,336 / 8,021 = 1.4133', () => {
    // 5m SIP volumes 10:45 … 12:25 ET (regular session), read from Alpaca historical bars during the VRSK diagnostic.
    const sip = [9536, 11296, 6495, 8834, 5019, 5922, 1515, 2824, 5610, 16602, 13927, 7083, 5609, 12367, 4579, 570, 2132, 2381, 15900, 22219, 11336];
    const hist = priorBars('12:30', sip);
    const c1230 = historicalParityRvol(hist, at('12:30'), 8_181);
    expect(c1230.baseline).toBe(8_111);
    expect(c1230.value!.toFixed(4)).toBe('1.0086');
    const c1225 = historicalParityRvol(hist, at('12:25'), 11_336);
    expect(c1225.baseline).toBe(8_021);
    expect(c1225.value!.toFixed(4)).toBe('1.4133');
  });
});

describe('(11)–(16) everything except RVOL is unchanged', () => {
  const r = req('2026-10-30 12:28');
  const res = runIntrabarReconstruction(BARS5, MIN1, r, { host: 'h', windows: requestWindows(r) });
  it('OHLC, volume, ATR, EMA9, EMA20, RSI, VWAP equal the unchanged builder on [history + partial bar]; 15m equals the alert-time builder', () => {
    for (const b of res.bounds) {
      const s = b.snapshot;
      const hist = BARS5.filter((x) => x.t + FIVE <= at('12:25'));
      const mins = MIN1.filter((x) => x.t >= at('12:25') && x.t + 60_000 <= Date.parse(s.cutoffIso));
      const partial: Bar = { t: at('12:25'), o: mins[0].o, h: Math.max(...mins.map((x) => x.h)), l: Math.min(...mins.map((x) => x.l)), c: mins[mins.length - 1].c, v: mins.reduce((a, x) => a + x.v, 0) };
      const builder = buildAlertSnapshot([...hist, partial], at('12:30'), 'LONG').values!;
      const at15 = buildAlertSnapshot(hist, r.alertMs, 'LONG').values!;
      const { rvol: parity, close15m, ema20_15m, ...rest } = s.values!;
      const { rvol: legacy, close15m: _c, ema20_15m: _e, ...expected } = builder;
      expect(rest).toEqual(expected);
      expect([close15m, ema20_15m]).toEqual([at15.close15m, at15.ema20_15m]);
      expect(s.rvolParity!.legacy).toBe(legacy);
      expect(parity).not.toBe(legacy);
    }
  });
  it('intrabarSnapshot exposes the same parity value it compares', () => {
    const s = intrabarSnapshot(BARS5, MIN1, r.alertMs, r.cutoffs[0].ms, 'LONG');
    expect(s.values!.rvol).toBe(s.rvolParity!.value);
  });
});

describe('(17)–(19) live path unchanged', () => {
  it('(17) the live snapshot builder still uses the legacy same-bar RVOL (current candle inside its own SMA20)', () => {
    const live = buildAlertSnapshot(BARS5, at('12:30') + 5_000, 'LONG');
    const bars = BARS5.filter((b) => b.t + FIVE <= at('12:30'));
    const i = bars.findIndex((b) => b.t === at('12:25'));
    expect(live.values!.rvol).toBe(rvol(bars.slice(0, i + 1).map((b) => b.v), 20)[i]);
  });
  it('the shared rvol() keeps its same-bar definition', () => {
    const v = [...new Array(19).fill(100), 300];
    expect(rvol(v, 20)[19]).toBe(300 / ((19 * 100 + 300) / 20));
  });
  it('(18)(19) no live module (webhook, queue, decision, ranker, calculator, portfolio, journal) imports the diagnostic', () => {
    const root = join(__dirname, '..', '..', '..', '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') walk(p); } else if (/\.(ts|tsx|mts)$/.test(n)) files.push(p);
      }
    };
    walk(join(root, 'src'));
    walk(join(root, 'netlify'));
    const allowed = /historicalParity\.ts$|historicalSip\.ts$|rb-historical-parity\.mts$|HistoricalSipTest\.tsx$|automationClient\.ts$/;
    const importers = files.filter((f) => /from\s+'[^']*historicalParity'/.test(readFileSync(f, 'utf8'))).filter((f) => !allowed.test(f));
    expect(importers).toEqual([]);
  });
});
