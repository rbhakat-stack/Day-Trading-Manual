/**
 * RVOL transparency (diagnostic only). TrendSpider-confirmed formula: RVOL(t) = volume(t) / shift(sma(volume, 20), 1).
 * Real Alpaca SIP fixtures: FTNT 10:25–10:30 and CARR 11:00–11:05 ET, 2026-11-06 (values production stored at alert time).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import FX from './rvol-ftnt-carr-2026-11-06.json';
import { rvol, sma, type Bar } from '../indicators';
import { historicalParityRvol } from '../historicalParity';
import { buildRvolDiagnostics, isRvolOnlyMismatch, rvolOnlyExplanation, tsFormulaRvol, TS_ACTUAL_NOT_CAPTURED } from '../rvolDiagnostics';
import type { SnapshotResult } from '../alertSnapshot';
import { decideAlert, DEFAULT_AUTOMATION, type AutoAlertRecord } from '../alertDecision';

type Sym = 'FTNT' | 'CARR';
const bars = (s: Sym): Bar[] => FX[s].bars.map(([t, o, h, l, c, v]) => ({ t: Date.parse(t as string), o: o as number, h: h as number, l: l as number, c: c as number, v: v as number }));
/** Literal transcription of TrendSpider's published code: div(volume, shift(sma(volume, 20), 1)). */
const tsFormula = (v: number[], i: number) => v[i] / (sma(v, 20)[i - 1] as number);

function snap(s: Sym, rv: number, failed: string[] = ['RVOL20 > 1.5']): SnapshotResult {
  const labels = ['5m Close < VWAP', 'EMA9 < EMA20', 'RSI14 < 45', 'RVOL20 > 1.5', 'Close < Open', '15m Close < 15m EMA20'];
  return {
    alertEt: '', alertDate: '2026-11-06', session: 'FULL', sessionNote: '', config: {} as SnapshotResult['config'],
    values: { volume: FX[s].productionStored.volume, rvol: rv } as SnapshotResult['values'],
    signal: { startIso: FX[s].signalStartIso, endIso: '', label: '' }, confirm15m: null, issues: [], barsUsed: 0,
    alertConditions: labels.map((label) => ({ label, pass: !failed.includes(label) })),
  } as SnapshotResult;
}

describe('RVOL formula parity (TrendSpider-confirmed) on real SIP fixtures', () => {
  const expected = { FTNT: { live: 1.4386080614138907, ts: 1.5122419681416208, base: 101838.2 }, CARR: { live: 1.0555709114082468, ts: 1.0163910793383826, base: 108211.3 } };
  for (const s of ['FTNT', 'CARR'] as Sym[]) {
    it(`${s}: live RB RVOL is unchanged; the diagnostic equals TrendSpider's published formula exactly`, () => {
      const b = bars(s);
      const v = b.map((x) => x.v);
      const i = b.length - 1;
      expect(b[i].t).toBe(Date.parse(FX[s].signalStartIso));
      expect(v[i]).toBe(FX[s].productionStored.volume);
      // live RB v1.1 (signal candle inside its own SMA20) — still exactly what production stored
      expect(rvol(v, 20)[i]).toBe(FX[s].productionStored.rvol);
      expect(rvol(v, 20)[i]).toBeCloseTo(expected[s].live, 12);
      const d = buildRvolDiagnostics(b, snap(s, FX[s].productionStored.rvol), '2026-11-06T00:00:00.000Z')!;
      expect(d.tsFormulaSipRvol).toBeCloseTo(tsFormula(v, i), 12);
      expect(d.tsFormulaSipRvol).toBeCloseTo(historicalParityRvol(b, b[i].t, v[i]).value as number, 12);
      expect(d.tsFormulaSipRvol).toBeCloseTo(expected[s].ts, 9);
      expect(d.baseline).toBeCloseTo(expected[s].base, 6);
      expect(d.baselineBars).toHaveLength(20);
      expect(d.baselineBars.some((x) => x.t === b[i].t)).toBe(false); // signal candle excluded from the denominator
      expect(d.rbRvol).toBe(FX[s].productionStored.rvol);
      expect(d.signalVolume).toBe(FX[s].productionStored.volume);
      // never presented as TrendSpider's actual value
      expect(d.trendspiderActual).toBeNull();
      expect(d.trendspiderActualSource).toBe('NOT_CAPTURED');
      expect(d.source).toBe('ALPACA_SIP');
    });
  }

  it('formula identity holds on randomized series that cross a session boundary (helper == TrendSpider code)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const day1 = Date.parse('2026-11-05T19:00:00Z'); // 14:00 ET → 15:55 ET (24 bars)
    const day2 = Date.parse('2026-11-06T14:30:00Z'); // 09:30 ET onward
    const b: Bar[] = [];
    for (let k = 0; k < 24; k++) b.push({ t: day1 + k * 300_000, o: 1, h: 1, l: 1, c: 1, v: Math.round(1e4 + rnd() * 3e5) });
    for (let k = 0; k < 12; k++) b.push({ t: day2 + k * 300_000, o: 1, h: 1, l: 1, c: 1, v: Math.round(1e4 + rnd() * 3e5) });
    const v = b.map((x) => x.v);
    for (let i = 20; i < b.length; i++) {
      const p = historicalParityRvol(b, b[i].t, v[i]);
      expect(p.value).toBeCloseTo(tsFormula(v, i), 12);
      // the live-side implementation equals both the diagnostic helper and TrendSpider's code
      expect(tsFormulaRvol(b, b[i].t, v[i]).value).toBeCloseTo(p.value as number, 12);
      expect(tsFormulaRvol(b, b[i].t, v[i]).baseline).toBe(p.baseline);
    }
  });

  it('fails closed (null, never estimated) with fewer than 20 previous candles', () => {
    const b = bars('FTNT').slice(-15);
    const d = buildRvolDiagnostics(b, snap('FTNT', 1.4), 'x')!;
    expect(d.tsFormulaSipRvol).toBeNull();
    expect(d.baseline).toBeNull();
  });

  it('returns null when the snapshot has no values (nothing recorded, nothing invented)', () => {
    expect(buildRvolDiagnostics(bars('FTNT'), null, 'x')).toBeNull();
    expect(buildRvolDiagnostics(bars('FTNT'), { ...snap('FTNT', 1), values: null } as SnapshotResult, 'x')).toBeNull();
  });
});

describe('RVOL-only DATA REVIEW explanation (text only)', () => {
  it('detects RVOL-only vs mixed mismatches', () => {
    expect(isRvolOnlyMismatch(snap('FTNT', 1.43))).toBe(true);
    expect(isRvolOnlyMismatch(snap('FTNT', 1.43, ['RVOL20 > 1.5', 'RSI14 < 45']))).toBe(false);
    expect(isRvolOnlyMismatch(snap('FTNT', 1.43, ['RSI14 < 45']))).toBe(false);
    expect(isRvolOnlyMismatch(snap('FTNT', 1.43, []))).toBe(false);
    expect(isRvolOnlyMismatch(null)).toBe(false);
  });

  it('labels both values correctly and never calls the SIP value TrendSpider actual', () => {
    const s = snap('FTNT', 1.4386080614138907);
    const d = buildRvolDiagnostics(bars('FTNT'), s, 'x');
    const t = rvolOnlyExplanation(s, d, 'SHORT');
    expect(t).toContain('RB current RVOL 1.44');
    expect(t).toContain('TrendSpider-formula RVOL on Alpaca SIP 1.51 (diagnostic only)');
    expect(t).toContain(`TrendSpider actual RVOL ${TS_ACTUAL_NOT_CAPTURED}`);
    expect(t).toContain('no ticket');
    // older record without the diagnostic: not recomputed from later data
    expect(rvolOnlyExplanation(s, undefined, 'SHORT')).toContain('TrendSpider-formula RVOL on Alpaca SIP not recorded at alert time');
  });
});

describe('decideAlert — RVOL-only mismatch: same decision, detail, section and no ticket; only the reason text is precise', () => {
  const alertMs = Date.parse('2026-11-06T15:30:25.355Z');
  const rec = (failed: string[], withDiag: boolean): AutoAlertRecord => {
    const s = snap('FTNT', 1.4386080614138907, failed);
    s.issues = [{ kind: 'REVIEW', code: 'ALERT_NOT_REPRODUCED', message: `TrendSpider fired the SHORT alert, but the automated values do not satisfy: ${failed.join('; ')}. Data feeds or indicator settings may differ.` }];
    return {
      id: 'FTNT-S-103025-657c98', dedupeKey: 'k', receivedIso: new Date(alertMs).toISOString(), receivedMs: alertMs, status: 'OK',
      alert: { strategy: 'RB_V1', symbol: 'FTNT', direction: 'SHORT', alertName: 'RB v1 SHORT Setup', alertTimeMs: alertMs, alertTimeIso: new Date(alertMs).toISOString(), timeSource: 'RECEIVED', lastPrice: null },
      payload: {}, snapshot: s, provider: { name: 'Alpaca', feed: 'sip', host: 'h' }, marketDataThroughIso: null, initialQuote: null, calcAtAlert: null,
      sameTickerEarlier: [], errors: [], attempts: 1, versions: { rules: 'RB v1.1', scoring: 'RB v1.1', strategy: 'RB v1.1' }, processedIso: null,
      rvolDiagnostics: withDiag ? buildRvolDiagnostics(bars('FTNT'), s, 'x') : undefined,
    };
  };
  const decide = (r: AutoAlertRecord) => decideAlert({ record: r, released: true, candidate: null, ranked: null, live: null, quote: null, now: alertMs + 2000, cfg: DEFAULT_AUTOMATION, parityMismatches: [], duplicateOf: null });

  it('RVOL-only: DATA REVIEW REQUIRED / DATA MISMATCH — MANUAL REVIEW, no ticket, precise reason', () => {
    const d = decide(rec(['RVOL20 > 1.5'], true));
    expect([d.decision, d.detail, d.section, d.ticket]).toEqual(['DATA REVIEW REQUIRED', 'DATA MISMATCH — MANUAL REVIEW', 'DATA_REVIEW', null]);
    expect(d.reasons[0]).toMatch(/^RVOL NOT VERIFIED/);
    expect(d.reasons[0]).toContain('TrendSpider-formula RVOL on Alpaca SIP 1.51 (diagnostic only)');
  });
  it('mixed mismatch (RVOL + RSI): original generic reason, same decision', () => {
    const d = decide(rec(['RSI14 < 45', 'RVOL20 > 1.5'], true));
    expect([d.decision, d.detail, d.ticket]).toEqual(['DATA REVIEW REQUIRED', 'DATA MISMATCH — MANUAL REVIEW', null]);
    expect(d.reasons[0]).toMatch(/^TrendSpider fired the SHORT alert, but the automated values do not satisfy: RSI14 < 45; RVOL20 > 1.5/);
  });
  it('older record without the diagnostic: same decision; value shown as not recorded at alert time', () => {
    const d = decide(rec(['RVOL20 > 1.5'], false));
    expect(d.decision).toBe('DATA REVIEW REQUIRED');
    expect(d.reasons[0]).toContain('not recorded at alert time');
  });
});

describe('release safety — the diagnostic can never influence a decision', () => {
  it('decideAlert is identical (decision, detail, section, ticket, gate) whatever the diagnostic value, or without it', () => {
    const alertMs = Date.parse('2026-11-06T15:30:25.355Z');
    const base = (diag: AutoAlertRecord['rvolDiagnostics'], failed: string[]): AutoAlertRecord => {
      const s = snap('FTNT', 1.4386080614138907, failed);
      s.issues = failed.length ? [{ kind: 'REVIEW', code: 'ALERT_NOT_REPRODUCED', message: 'm' }] : [];
      return {
        id: 'X', dedupeKey: 'k', receivedIso: '', receivedMs: alertMs, status: 'OK',
        alert: { strategy: 'RB_V1', symbol: 'FTNT', direction: 'SHORT', alertName: 'RB v1 SHORT Setup', alertTimeMs: alertMs, alertTimeIso: new Date(alertMs).toISOString(), timeSource: 'RECEIVED', lastPrice: null },
        payload: {}, snapshot: s, provider: { name: 'Alpaca', feed: 'sip', host: 'h' }, marketDataThroughIso: null, initialQuote: null, calcAtAlert: null,
        sameTickerEarlier: [], errors: [], attempts: 1, versions: { rules: 'RB v1.1', scoring: 'RB v1.1', strategy: 'RB v1.1' }, processedIso: null, rvolDiagnostics: diag,
      };
    };
    const d0 = buildRvolDiagnostics(bars('FTNT'), snap('FTNT', 1.4386080614138907), 'x')!;
    const variants = [undefined, null, d0, { ...d0, tsFormulaSipRvol: 99 }, { ...d0, tsFormulaSipRvol: 0.01 }, { ...d0, trendspiderActual: 5 } as typeof d0];
    for (const failed of [['RVOL20 > 1.5'], ['RSI14 < 45', 'RVOL20 > 1.5'], []]) {
      const outs = variants.map((v) => decideAlert({ record: base(v, failed), released: true, candidate: null, ranked: null, live: null, quote: null, now: alertMs + 2000, cfg: DEFAULT_AUTOMATION, parityMismatches: [], duplicateOf: null }));
      const key = (d: (typeof outs)[number]) => JSON.stringify([d.decision, d.detail, d.section, d.ticket, d.gate, d.flags]);
      for (const o of outs) expect(key(o)).toBe(key(outs[0]));
    }
  });

  it('source guard: the diagnostic field is read only by the reason text (decideAlert) and the display; written only by processAlert', () => {
    const root = join(__dirname, '..', '..', '..', '..');
    const files: string[] = [];
    const walk = (dir: string) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') walk(p); } else if (/\.(ts|tsx|mts)$/.test(n)) files.push(p); } };
    walk(join(root, 'src'));
    walk(join(root, 'netlify'));
    expect(files.length).toBeGreaterThan(100);
    const users = files.filter((f) => /rvolDiagnostics/.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f).split(sep).join('/')).sort();
    expect(users).toEqual(['netlify/lib/processAlert.ts', 'src/components/live/QueueParts.tsx', 'src/engine/automation/alertDecision.ts']); // (+ the module itself, which defines RvolDiagnostics)
    // alertDecision uses it only inside the reason text builder
    const ad = readFileSync(join(root, 'src/engine/automation/alertDecision.ts'), 'utf8');
    expect(ad.match(/rec\.rvolDiagnostics/g)).toHaveLength(1);
    expect(ad).toMatch(/rvolOnlyExplanation\(snap, rec\.rvolDiagnostics, rec\.alert\.direction\)/);
  });
});
