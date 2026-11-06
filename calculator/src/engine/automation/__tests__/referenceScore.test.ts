/**
 * PHASE C — reference-only scores and indicator mismatch diagnostics (display only). Real 2026-11-06 records:
 * Q LONG 14:40:06 (RVOL + candle not reproduced → INVALID_CANDLE_DIRECTION, NOT SCORED today), FTNT 10:30 / CARR 11:05
 * (RVOL-only DATA REVIEW), CTVA / Q 12:30 (all conditions reproduced). Variants are labelled SYNTHETIC.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import FXQ from './phase-c-q-2026-11-06.json';
import FX from './rvol-v1-observation-2026-11-06.json';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue, type QueueInput, type QueueRow } from '../liveQueue';
import { indicatorChecks, mismatchSummary, scoreView, totalFromComponents } from '../referenceScore';
import { captureReferences } from '../../../lib/referenceScoreHook';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../settings';
import { KNOWN_CLASSIFICATIONS } from '../../ranker/correlationRules';
import type { ComponentScore } from '../../ranker/opportunityTypes';

const ALL = [...(FXQ.records as unknown as AutoAlertRecord[]), ...(FX.records as unknown as AutoAlertRecord[])];
const rec = (p: string) => structuredClone(ALL.find((r) => r.id.startsWith(p))!) as AutoAlertRecord;
const classify = (s: string) => KNOWN_CLASSIFICATIONS[s] ?? { sector: `Sector-${s}`, industry: `Industry-${s}`, theme: '' };
function run(records: AutoAlertRecord[], o: { now?: number; classifyFn?: QueueInput['classify'] } = {}) {
  const now = o.now ?? Math.max(...records.map((r) => Date.parse(r.processedIso ?? r.receivedIso))) + 4_000;
  const quotes: Record<string, LiveQuote> = {};
  for (const r of records) if (r.initialQuote) quotes[r.alert.symbol] = { ...r.initialQuote, tradeIso: new Date(now - 1500).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 };
  const q: QueueInput = { records, candidates: [], positions: [], quotes, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify: o.classifyFn ?? classify, parity: {}, strategyVersion: 'RB v1.1', frozen: {}, terminal: {} };
  const before = JSON.stringify({ ...q, classify: undefined });
  const out = buildQueue(q);
  expect(JSON.stringify({ ...q, classify: undefined })).toBe(before);
  return out;
}
const row = (o: ReturnType<typeof buildQueue>, id: string) => o.rows.find((r) => r.record.id === id)!;

describe('root cause: Q LONG 14:40:06', () => {
  it('production keeps NOT SCORED (total null) only because a strategy hard rule failed; every component was computed; reference = existing arithmetic', () => {
    const r = rec('Q-L-144006');
    const x = row(run([r]), r.id);
    expect(x.decision.decision).toBe('DATA REVIEW REQUIRED'); // unchanged authoritative decision
    expect(x.decision.ticket).toBeNull();
    expect(x.ranked!.total).toBeNull();
    expect(x.ranked!.strategyEligible).toBe(false);
    expect(x.ranked!.missing).toEqual([]);
    expect(x.ranked!.hardFails.map((f) => f.code)).toContain('INVALID_CANDLE_DIRECTION');
    const v = scoreView(x);
    expect(v.kind).toBe('REFERENCE');
    if (v.kind !== 'REFERENCE') return;
    expect(v.components.find((k) => k.key === 'candle')).toMatchObject({ points: 0, na: 'N/A — INVALID LONG CANDLE' }); // existing N/A rule
    expect(v.components.find((k) => k.key === 'rvol')!.points).toBe(0); // RB SIP RVOL 1.21 → 0/15 (existing band)
    expect(v.total).toBe(totalFromComponents(x.ranked!.components).total);
    expect(v.hardFails).toContain('INVALID_CANDLE_DIRECTION');
    // trade plan unchanged
    const c = x.candidate!;
    expect([c.entry, c.stop, c.target, c.shares]).toEqual([116.78, 116.32, 117.7, 171]);
  });
  it('diagnostics: RVOL SOURCE DIFFERENCE + candle FAILED (hard rule) → 2 MISMATCHES, multiple-discrepancy headline', () => {
    const x = row(run([rec('Q-L-144006')]), 'Q-L-144006-10dbc0');
    const m = mismatchSummary(x);
    expect(m.count).toBe(2);
    expect(m.label).toBe('2 MISMATCHES');
    expect(m.headline).toBe('DATA REVIEW REQUIRED — MULTIPLE INDICATOR DISCREPANCIES');
    const byName = Object.fromEntries(m.checks.map((c) => [c.indicator, c]));
    expect(byName['RVOL(20)'].status).toBe('SOURCE DIFFERENCE');
    expect(byName['RVOL(20)'].trendspiderActual).toBe('NOT CAPTURED');
    expect(byName['5-minute candle direction']).toMatchObject({ status: 'FAILED' });
    expect(byName['5-minute candle direction'].blocks).toMatch(/INVALID_CANDLE_DIRECTION/);
    expect(['VWAP', 'EMA9 vs EMA20', 'RSI(14)', '15-minute confirmation'].every((n) => byName[n].status === 'PASS')).toBe(true);
  });
});

describe('formula identity — the reference arithmetic equals the ranker total on every scored candidate', () => {
  it('every scored row, each alert evaluated at its own processing time (later batch times expire earlier alerts)', () => {
    const scored = ['FTNT-S-1030', 'CARR', 'CTVA', 'Q-L-1230'].map((p) => { const r = rec(p); return row(run([r]), r.id); }).filter((r) => r.ranked?.total != null);
    expect(scored.length).toBe(4);
    for (const r of scored) expect(totalFromComponents(r.ranked!.components).total).toBe(r.ranked!.total);
    for (const r of scored) expect(scoreView(r)).toEqual({ kind: 'SCORED', total: r.ranked!.total });
  });
  it('synthetic component sets: 79 / 80 / 84 / 85 / 90 with a hard failure → exact reference totals (no award, no penalty)', () => {
    const mk = (pts: number[]): ComponentScore[] => (['trend', 'rvol', 'momentum', 'candle', 'location', 'time', 'capitalEfficiency', 'capitalAvailability', 'correlation', 'portfolioRisk'] as const).map((key, i) => ({ key, label: key, points: pts[i], max: 99, summary: '', calc: [], positives: [], negatives: [] }));
    const cases: [number[], number][] = [
      [[15, 6, 9, 7, 9, 8, 7, 8, 5, 5], 79], [[15, 6, 9, 7, 9, 8, 8, 8, 5, 5], 80], [[15, 9, 9, 8, 9, 8, 8, 8, 5, 5], 84], [[15, 9, 10, 8, 9, 8, 8, 8, 5, 5], 85], [[15, 12, 10, 9, 10, 8, 8, 8, 5, 5], 90],
    ];
    for (const [pts, want] of cases) {
      const fake = { decision: { decision: 'NOT ELIGIBLE', ticket: null }, record: { status: 'OK', snapshot: { values: {}, issues: [], alertConditions: [] }, alert: {} }, candidate: {}, ranked: { total: null, missing: [], components: mk(pts), hardFails: [{ code: 'INVALID_CANDLE_DIRECTION' }] } } as unknown as QueueRow;
      const v = scoreView(fake);
      expect(v).toMatchObject({ kind: 'REFERENCE', total: want });
      expect(fake.decision.decision).toBe('NOT ELIGIBLE'); // scoreView never touches the decision
    }
  });
});

describe('scenarios', () => {
  it('RVOL-only discrepancy (FTNT 10:30): already scored (DATA REVIEW display score) → SCORED; 1 MISMATCH (SOURCE DIFFERENCE)', () => {
    const x = row(run([rec('FTNT-S-1030')]), 'FTNT-S-103025-657c98');
    expect(scoreView(x).kind).toBe('SCORED');
    expect(mismatchSummary(x).label).toBe('1 MISMATCH (SOURCE DIFFERENCE)');
  });
  it('SYNTHETIC: invalid candle direction without RVOL discrepancy (CTVA SHORT, green candle) → hard fail, REFERENCE score, decision blocked', () => {
    const r = rec('CTVA');
    const { open, close } = r.snapshot!.values!; // swap O/C: same bar range, now a green candle (invalid for SHORT)
    r.snapshot!.values!.open = close; r.snapshot!.values!.close = open;
    r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (c.label.startsWith('Close') ? { ...c, pass: false } : c));
    const x = row(run([r]), r.id);
    expect(x.decision.ticket).toBeNull();
    expect(scoreView(x).kind).toBe('REFERENCE');
    expect(mismatchSummary(x).checks.find((c) => c.indicator === '5-minute candle direction')!.status).toBe('FAILED');
  });
  it('SYNTHETIC: failed VWAP / EMA / RSI conditions are FAILED, block via DATA REVIEW', () => {
    for (const pre of ['5m Close', 'EMA9', 'RSI14']) {
      const r = rec('CTVA');
      r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (c.label.startsWith(pre) ? { ...c, pass: false } : c));
      r.snapshot!.issues = [{ kind: 'REVIEW', code: 'ALERT_NOT_REPRODUCED', message: 'x' }];
      const x = row(run([r]), r.id);
      expect(x.decision.decision).toBe('DATA REVIEW REQUIRED');
      const c = mismatchSummary(x).checks.find((k) => k.required.startsWith(pre))!;
      expect(c.status).toBe('FAILED');
      expect(c.blocks).toMatch(/DATA REVIEW/);
    }
  });
  it('SYNTHETIC: failed 15-minute confirmation → HTF hard fail, trend component N/A (existing rule), REFERENCE score', () => {
    const r = rec('CTVA');
    r.snapshot!.values!.close15m = r.snapshot!.values!.ema20_15m + 0.5; // SHORT needs close15m < ema20_15m
    r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (c.label.startsWith('15m') ? { ...c, pass: false } : c));
    const x = row(run([r]), r.id);
    expect(x.ranked!.hardFails.map((f) => f.code)).toContain('HTF_CONFIRMATION_FAILED');
    const v = scoreView(x);
    expect(v.kind).toBe('REFERENCE');
    if (v.kind === 'REFERENCE') expect(v.components.find((k) => k.key === 'trend')!.points).toBe(0);
    expect(x.decision.ticket).toBeNull();
  });
  it('missing data → SCORE UNAVAILABLE with the exact reason (never a manufactured score)', () => {
    const noValues = rec('CTVA'); noValues.snapshot = { ...noValues.snapshot!, values: null, issues: [{ kind: 'INCOMPLETE', code: 'SIGNAL_CANDLE_MISSING', message: 'missing' }] };
    expect(scoreView(row(run([noValues]), noValues.id))).toMatchObject({ kind: 'UNAVAILABLE' });
    const incomplete = rec('CTVA'); incomplete.status = 'DATA_ERROR'; incomplete.errorCode = 'SIGNAL_CANDLE_INCOMPLETE'; incomplete.errors = ['SIGNAL_CANDLE_INCOMPLETE: 3 of 5 minutes'];
    expect(scoreView(row(run([incomplete]), incomplete.id))).toEqual({ kind: 'UNAVAILABLE', reasons: ['SIGNAL_CANDLE_INCOMPLETE: 3 of 5 minutes'] });
    const noVol = rec('CTVA'); noVol.snapshot!.values!.rvol = Number.NaN;
    expect(scoreView(row(run([noVol]), noVol.id))).toMatchObject({ kind: 'UNAVAILABLE', reasons: expect.arrayContaining(['Missing input: RVOL(20)']) });
    const badAtr = rec('CTVA'); badAtr.snapshot!.values!.atr = 0;
    const vAtr = scoreView(row(run([badAtr]), badAtr.id));
    expect(vAtr.kind).toBe('UNAVAILABLE');
    const noSector = rec('CTVA');
    expect(scoreView(row(run([noSector], { classifyFn: () => ({ sector: '', industry: '', theme: '' }) }), noSector.id))).toMatchObject({ kind: 'UNAVAILABLE', reasons: expect.arrayContaining(['Missing input: Sector']) });
  });
  it('expired / out-of-window evaluation: decision unchanged; reference (if any) stays reference-only', () => {
    const r = rec('Q-L-144006');
    const x = row(run([r], { now: r.receivedMs + 11 * 60_000 }), r.id);
    expect(x.decision.ticket).toBeNull();
    expect(['REFERENCE', 'UNAVAILABLE', 'SCORED']).toContain(scoreView(x).kind);
  });
  it('malformed rows never throw', () => {
    const odd = [{ decision: { decision: 'X' }, record: { status: 'OK', snapshot: null, alert: {} }, ranked: null } as unknown as QueueRow, { decision: { decision: 'X' }, record: { status: 'OK', snapshot: { values: {}, issues: [], alertConditions: [{ label: 'weird', pass: false }] }, alert: {} }, ranked: { total: null, missing: [], components: [], hardFails: [] } } as unknown as QueueRow];
    for (const o of odd) { expect(() => scoreView(o)).not.toThrow(); expect(() => indicatorChecks(o)).not.toThrow(); }
  });
});

describe('capture (session only, never stored)', () => {
  it('first REFERENCE value is kept; later evaluations never overwrite it; evaluations after the 10-minute window are labelled reconstructed', () => {
    const r = rec('Q-L-144006');
    const x = row(run([r]), r.id);
    const t0 = r.receivedMs + 5_000;
    const m1 = captureReferences(new Map(), [x], t0);
    expect(m1.get(r.id)).toMatchObject({ reconstructed: false, atMs: t0 });
    const changed = structuredClone(x);
    changed.ranked!.components = changed.ranked!.components.map((k) => (k.key === 'location' ? { ...k, points: k.points + 2 } : k));
    const m2 = captureReferences(m1, [changed], t0 + 60_000);
    expect(m2.get(r.id)).toEqual(m1.get(r.id)); // immutable once captured
    const reload = captureReferences(new Map(), [x], r.receivedMs + 30 * 60_000); // e.g. after a page reload
    expect(reload.get(r.id)!.reconstructed).toBe(true);
  });
});

describe('isolation', () => {
  it('source guard: no engine decision module, ranker or Netlify module imports the reference module; only the UI hook and the queue panel do', () => {
    const root = join(__dirname, '..', '..', '..', '..');
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') walk(p); } else if (/\.(ts|tsx|mts)$/.test(n)) files.push(p); } };
    walk(join(root, 'src'));
    walk(join(root, 'netlify'));
    expect(files.length).toBeGreaterThan(100);
    const users = files.filter((f) => /from '[^']*referenceScore'/.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f).split(sep).join('/')).sort();
    expect(users).toEqual(['src/components/live/QueueParts.tsx', 'src/lib/referenceScoreHook.ts']);
  });
  it('high volume: 400 rows of diagnostics in well under a second', () => {
    const x = row(run([rec('Q-L-144006')]), 'Q-L-144006-10dbc0');
    const rows = Array.from({ length: 400 }, (_, i) => ({ ...x, record: { ...x.record, id: `R${i}` } }) as QueueRow);
    const t = performance.now();
    for (const r of rows) { scoreView(r); mismatchSummary(r); }
    captureReferences(new Map(), rows, Date.now());
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
