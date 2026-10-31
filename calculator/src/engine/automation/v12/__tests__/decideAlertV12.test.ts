import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideAlert, DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../../alertDecision';
import type { AlertTimeValues, DataIssue } from '../../alertSnapshot';
import { buildQueue, type QueueInput } from '../../liveQueue';
import { etToEpoch } from '../../etTime';
import { cloneRankerDefaults } from '../../../ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../../settings';
import { recordWith } from '../../__tests__/fixtures';
import { receiptAudit, withReconstruction, type AutoAlertRecordV12 } from '../audit';
import { ACTIVE_LOGIC_VERSION, decideActive, decideShadow, logicVersionOf } from '../dispatch';
import type { RuleSetEntry } from '../ruleSets';

/** Test-only registry (the production registry is EMPTY until the TrendSpider audit). */
const REG: RuleSetEntry[] = [
  { id: 'RBTS-L-901', direction: 'LONG', rulesVersion: 'RB v1.2', audited: '2026-01-01', checklistRef: 'test', active: true, rules: ['5m Close > VWAP', 'EMA9 > EMA20', 'RSI14 > 55', 'RVOL(20,SMA,1) > 1.5', 'Close > Open', '15m Close > 15m EMA20'] },
  { id: 'RBTS-S-901', direction: 'SHORT', rulesVersion: 'RB v1.2', audited: '2026-01-01', checklistRef: 'test', active: true, rules: ['5m Close < VWAP'] },
];
const D = '2026-10-30';
const SECTORS: Record<string, string> = { VRSK: 'Data', NVDA: 'Semis', MSFT: 'Software', IBM: 'IT', NEE: 'Utilities', AVGO: 'Semis2', IQV: 'Health', Q: 'Materials', GM: 'Autos' };
const FIVE = 300_000;
const W11 = { entryWindowStart: '09:45', entryWindowEnd: '15:30' };
const W12 = { ...W11, chaseThresholdAtr: 0.25 };

/** Record received `lagSec` after the close of the candle ending at `closeEt`, optionally with a v1.2 audit. */
function rec(o: { symbol: string; direction?: 'LONG' | 'SHORT'; closeEt: string; lagSec?: number; values?: Partial<AlertTimeValues>; price?: number; issues?: DataIssue[]; ruleSet?: string | null; registry?: RuleSetEntry[]; v12?: boolean; date?: string }): AutoAlertRecordV12 {
  const date = o.date ?? D;
  const direction = o.direction ?? 'LONG';
  const end = etToEpoch(date, o.closeEt);
  const receivedMs = end + (o.lagSec ?? 12) * 1000;
  const r = recordWith({ symbol: o.symbol, direction, alertIso: new Date(receivedMs).toISOString(), receivedMs, values: o.values ?? {}, price: o.price, issues: o.issues });
  r.alert.timeSource = 'RECEIVED';
  r.snapshot!.signal = { startIso: new Date(end - FIVE).toISOString(), endIso: new Date(end).toISOString(), label: '' };
  if (o.v12 === false) return r;
  const body = o.ruleSet === undefined ? { rule_set: direction === 'LONG' ? 'RBTS-L-901' : 'RBTS-S-901' } : o.ruleSet === null ? {} : { rule_set: o.ruleSet };
  const a = receiptAudit({ body, symbol: o.symbol, direction, receivedMs, v11Key: r.dedupeKey, registry: o.registry ?? REG });
  return { ...r, v12: withReconstruction(a, r, [], direction, DEFAULT_AUTOMATION.parity) };
}

const quote = (price: number, now: number): LiveQuote => ({ price, tradeIso: new Date(now - 1000).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 });
function run(records: AutoAlertRecord[], now: number, o: Partial<QueueInput> = {}) {
  const quotes: Record<string, LiveQuote> = {};
  for (const r of records) quotes[r.alert.symbol] = quote(r.initialQuote!.price, now);
  return buildQueue({
    records, candidates: [], positions: [], quotes, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(),
    classify: (s) => (SECTORS[s] ? { sector: SECTORS[s], industry: SECTORS[s], theme: '' } : null), parity: {}, strategyVersion: 'RB v1.1', ...o,
  });
}
const rowOf = (records: AutoAlertRecord[], sym: string, now: number) => run(records, now).rows.find((r) => r.record.alert.symbol === sym)!;
const nowAfter = (r: AutoAlertRecord, sec = 30) => r.receivedMs + sec * 1000;

/** Real VRSK 2026-10-30 12:25–12:30 SIP values (Phase 2); TrendSpider RVOL 2.009 vs SIP 1.413. */
const VRSK: Partial<AlertTimeValues> = { open: 196.35, high: 196.55, low: 196.2, close: 196.535, atr: 0.3914, ema9: 196.2868, ema20: 196.0679, rsi: 59.58, rvol: 1.413, vwap: 196.43096, close15m: 196.537, ema20_15m: 194.1874 };
const NOT_REPRODUCED: DataIssue = { kind: 'REVIEW', code: 'ALERT_NOT_REPRODUCED', message: 'TrendSpider fired the LONG alert, but the reconstructed values do not satisfy: RVOL20 > 1.5.' };

describe('version dispatch', () => {
  it('RB v1.1 is the active logic; every record stamped RB v1.1 is decided by v1.1', () => {
    expect(ACTIVE_LOGIC_VERSION).toBe('RB v1.1');
    const r = rec({ symbol: 'NVDA', closeEt: '10:15', price: 100.95 });
    expect(logicVersionOf(r)).toBe('RB v1.1');
  });

  it('historical v1.1 record without a v1.2 audit → v1.1 path, no shadow, decision identical to decideAlert', () => {
    const r = rec({ symbol: 'NVDA', closeEt: '10:15', price: 100.95, v12: false });
    const now = nowAfter(r);
    const row = rowOf([r], 'NVDA', now);
    expect(row.shadow).toBeNull();
    const direct = decideAlert({ record: r, released: true, candidate: row.candidate, ranked: row.ranked, live: row.live, quote: row.quote, now, cfg: DEFAULT_AUTOMATION, parityMismatches: [], duplicateOf: null, window: W11 });
    expect(row.decision).toEqual(direct);
  });

  it('v1.1 record WITH a v1.2 audit → active decision still exactly v1.1; v1.2 only as SHADOW', () => {
    const r = rec({ symbol: 'VRSK', closeEt: '12:30', values: VRSK, price: 196.5, issues: [NOT_REPRODUCED] });
    const now = nowAfter(r);
    const row = rowOf([r], 'VRSK', now);
    const plain = rowOf([{ ...r, v12: undefined } as AutoAlertRecord], 'VRSK', now);
    expect(row.decision).toEqual(plain.decision); // the audit changes nothing in the active path
    expect(row.shadow?.mode).toBe('SHADOW');
  });

  it('a record whose logic version is RB v1.2 follows the v1.2 path (and gets no separate shadow)', () => {
    const r = rec({ symbol: 'VRSK', closeEt: '12:30', values: VRSK, price: 196.5, issues: [NOT_REPRODUCED] });
    const v12rec: AutoAlertRecordV12 = { ...r, versions: { ...r.versions, strategy: 'RB v1.2' } };
    const now = nowAfter(r);
    const row = rowOf([v12rec], 'VRSK', now);
    expect(row.shadow).toBeNull();
    expect(row.decision.flags).toContain('LOGIC RB v1.2');
    expect(row.decision.decision).not.toBe('DATA REVIEW REQUIRED'); // v1.1 would say DATA MISMATCH here
    const act = decideActive({ record: v12rec, released: true, candidate: row.candidate, ranked: row.ranked, live: row.live, quote: row.quote, now, cfg: DEFAULT_AUTOMATION, parityMismatches: [], duplicateOf: null, window: W11 },
      { released: true, candidateStatus: null, live: row.live, ranked: row.ranked, v11DataBlocked: true, quote: row.quote, now, cfg: DEFAULT_AUTOMATION, duplicateOf: null, window: W12 });
    expect(act.logicVersion).toBe('RB v1.2');
    expect(decideShadow(v12rec, { released: true, candidateStatus: null, live: null, ranked: null, v11DataBlocked: false, quote: null, now, cfg: DEFAULT_AUTOMATION, duplicateOf: null, window: W12 })).toBeNull();
  });
});

describe('trust boundary in the decision (Invariant A)', () => {
  it('missing rule_set → NOT QUALIFIED', () => {
    const r = rec({ symbol: 'NVDA', closeEt: '10:15', price: 100.95, ruleSet: null });
    expect(rowOf([r], 'NVDA', nowAfter(r)).shadow).toMatchObject({ decision: 'NOT QUALIFIED', qualified: false, detail: 'NOT QUALIFIED — RULE SET MISSING' });
  });
  it('production registry (empty): even RBTS-L-001 is NOT QUALIFIED', () => {
    const r = rec({ symbol: 'NVDA', closeEt: '10:15', price: 100.95, ruleSet: 'RBTS-L-001', registry: [] });
    expect(rowOf([r], 'NVDA', nowAfter(r)).shadow).toMatchObject({ decision: 'NOT QUALIFIED', detail: 'NOT QUALIFIED — RULE SET UNKNOWN' });
  });
  it('direction conflict → NOT QUALIFIED', () => {
    const r = rec({ symbol: 'NVDA', closeEt: '10:15', price: 100.95, ruleSet: 'RBTS-S-901' });
    expect(rowOf([r], 'NVDA', nowAfter(r)).shadow?.detail).toBe('NOT QUALIFIED — RULE SET CONFLICT');
  });
});

describe('Invariant C — SIP disagreement never rejects a qualified alert', () => {
  it('VRSK 2026-10-30 12:25 LONG: SIP RVOL 1.413 → v1.1 DATA MISMATCH, v1.2 qualified and NOT rejected for RVOL', () => {
    const r = rec({ symbol: 'VRSK', closeEt: '12:30', values: VRSK, price: 196.5, issues: [NOT_REPRODUCED] });
    const row = rowOf([r], 'VRSK', nowAfter(r));
    expect(row.decision).toMatchObject({ decision: 'DATA REVIEW REQUIRED', detail: 'DATA MISMATCH — MANUAL REVIEW' });
    const s = row.shadow!;
    expect(s.qualified).toBe(true);
    expect(['NOT QUALIFIED', 'NOT ELIGIBLE', 'DATA REVIEW REQUIRED']).not.toContain(s.decision);
    expect(s.dataReview).toEqual([]);
    expect(s.warnings).toContain('SIP_RVOL_DIAGNOSTIC_ONLY');
    expect(r.v12!.conditionDiagnostics.find((d) => d.rule === 'RVOL')).toMatchObject({ class: 'DIAGNOSTIC_ONLY', sipPass: false });
  });

  it('EVERY SIP condition disagrees → still qualified, PARITY WARNINGs + waived SIP vetoes, no eligibility veto from parity', () => {
    const wrong: Partial<AlertTimeValues> = { open: 101, high: 101.2, low: 99.8, close: 100, atr: 1, vwap: 100.5, ema9: 99.5, ema20: 100.2, rsi: 40, rvol: 0.8, close15m: 99, ema20_15m: 100 };
    const r = rec({ symbol: 'GM', closeEt: '11:00', values: wrong, price: 100.5, issues: [{ ...NOT_REPRODUCED, message: 'all six fail' }] });
    const row = rowOf([r], 'GM', nowAfter(r));
    expect(row.decision.decision).toBe('DATA REVIEW REQUIRED'); // v1.1: data mismatch
    const s = row.shadow!;
    expect(s.qualified).toBe(true);
    expect(['NOT QUALIFIED', 'NOT ELIGIBLE', 'DATA REVIEW REQUIRED']).not.toContain(s.decision);
    expect(s.decision).toBe('QUALIFIED — SCORE PENDING'); // v1.1 ranker cannot score it yet (step 6)
    for (const w of ['PARITY_WARNING:CLOSE_VS_VWAP', 'PARITY_WARNING:EMA9_VS_EMA20', 'PARITY_WARNING:RSI', 'PARITY_WARNING:CANDLE_DIRECTION', 'PARITY_WARNING:CONFIRM_15M', 'SIP_VETO_WAIVED:INVALID_CANDLE_DIRECTION', 'SIP_VETO_WAIVED:HTF_CONFIRMATION_FAILED']) {
      expect(s.warnings, w).toContain(w);
    }
  });

  it('corrected MSFT 2026-10-30 13:35 (TS RVOL 1.624, SIP 1.946): RVOL diagnostic only, no warning, ticket identical to v1.1', () => {
    const r = rec({ symbol: 'MSFT', closeEt: '13:40', values: { rvol: 1.946 }, price: 100.95 });
    const row = rowOf([r], 'MSFT', nowAfter(r));
    expect(r.v12!.conditionDiagnostics.find((d) => d.rule === 'RVOL')).toMatchObject({ class: 'DIAGNOSTIC_ONLY', sipPass: true });
    expect(row.shadow!.warnings.filter((w) => w.startsWith('PARITY_WARNING'))).toEqual([]);
    expect(row.shadow!.decision).toBe(row.decision.decision);
    expect(row.shadow!.ticket).toEqual(row.decision.ticket);
  });
});

describe('Invariant D — DATA REVIEW only for integrity problems', () => {
  const issue = (code: string, kind: 'INCOMPLETE' | 'REVIEW' = 'INCOMPLETE'): DataIssue => ({ kind, code, message: code });
  const shadowOf = (r: AutoAlertRecordV12) => rowOf([r], r.alert.symbol, nowAfter(r)).shadow!;
  it.each([
    ['ambiguous mapping (lag 180 s)', () => rec({ symbol: 'NVDA', closeEt: '10:15', lagSec: 180, price: 100.95 }), 'SIGNAL_MAPPING_AMBIGUOUS'],
    ['missing signal candle', () => { const r = rec({ symbol: 'NVDA', closeEt: '10:15', price: 100.95, issues: [issue('SIGNAL_CANDLE_MISSING')] }); r.snapshot!.values = null; return r; }, 'SIGNAL_CANDLE_MISSING'],
    ['impossible OHLC', () => rec({ symbol: 'NVDA', closeEt: '10:15', values: { high: 100.5, close: 101 }, price: 100.95 }), 'SIGNAL_CANDLE_INVALID'],
    ['ATR unavailable', () => rec({ symbol: 'NVDA', closeEt: '10:15', values: { atr: 0 }, price: 100.95 }), 'ATR14_UNAVAILABLE'],
    ['insufficient history', () => { const r = rec({ symbol: 'NVDA', closeEt: '10:15', price: 100.95, issues: [issue('INSUFFICIENT_HISTORY')] }); r.snapshot!.values = null; return r; }, 'INSUFFICIENT_HISTORY'],
    ['too many missing bars', () => rec({ symbol: 'NVDA', closeEt: '10:15', price: 100.95, issues: [issue('MISSING_BARS', 'REVIEW')] }), 'MISSING_BARS'],
    ['provider failure', () => { const r = rec({ symbol: 'NVDA', closeEt: '10:15', price: 100.95 }); return { ...r, status: 'DATA_ERROR' as const, snapshot: null, errors: ['network down'] }; }, 'DATA_ERROR'],
    ['corrupt reconstruction', () => { const r = rec({ symbol: 'NVDA', closeEt: '10:15', price: 100.95 }); return { ...r, snapshot: null }; }, 'RECONSTRUCTION_INCOMPLETE'],
    ['signal candle ≠ mapped candle', () => { const r = rec({ symbol: 'NVDA', closeEt: '10:15', price: 100.95 }); r.snapshot!.signal = { startIso: new Date(etToEpoch(D, '10:05')).toISOString(), endIso: '', label: '' }; return r; }, 'SIGNAL_CANDLE_MISMATCH'],
    ['early-close session', () => rec({ symbol: 'NVDA', closeEt: '10:15', price: 100.95, issues: [issue('EARLY_CLOSE_SESSION', 'REVIEW')] }), 'EARLY_CLOSE_SESSION'],
    ['market closed day (holiday receipt)', () => rec({ symbol: 'NVDA', closeEt: '10:15', price: 100.95, date: '2026-11-26' }), 'MARKET_CLOSED_DAY'],
    ['calendar not loaded', () => rec({ symbol: 'NVDA', closeEt: '10:15', price: 100.95, date: '2030-01-07' }), 'CALENDAR_UNAVAILABLE'],
  ])('%s → DATA REVIEW (%s)', (_name, make, code) => {
    const s = shadowOf(make());
    expect(s.decision).toBe('DATA REVIEW REQUIRED');
    expect(s.dataReview).toContain(code);
  });
  it('indicator disagreement alone (ALERT_NOT_REPRODUCED) is NOT DATA REVIEW', () => {
    const s = shadowOf(rec({ symbol: 'VRSK', closeEt: '12:30', values: VRSK, price: 196.5, issues: [NOT_REPRODUCED] }));
    expect(s.decision).not.toBe('DATA REVIEW REQUIRED');
  });
  it('delayed delivery (61–120 s) is a warning, not DATA REVIEW', () => {
    const s = shadowOf(rec({ symbol: 'NVDA', closeEt: '10:15', lagSec: 90, price: 100.95 }));
    expect(s.decision).not.toBe('DATA REVIEW REQUIRED');
    expect(s.warnings[0]).toBe('DELIVERY_DELAYED');
  });
});

describe('qualification and the entry window stay separate', () => {
  it.each([
    ['IBM', 'LONG', '15:55', 10.4],
    ['NEE', 'SHORT', '15:45', 14],
    ['AVGO', 'LONG', '16:00', 14],
    ['IQV', 'LONG', '16:00', 15.1],
    ['Q', 'LONG', '16:00', 17.5],
  ] as const)('%s %s (candle closing %s): qualified, then NOT ELIGIBLE (after 15:30)', (symbol, direction, closeEt, lag) => {
    const values: Partial<AlertTimeValues> = direction === 'SHORT' ? { open: 101, high: 101, low: 100, close: 100, ema9: 100.1, ema20: 100.7, vwap: 100.6, rsi: 35, close15m: 100, ema20_15m: 101 } : {};
    const r = rec({ symbol, direction, closeEt, lagSec: lag, values, price: direction === 'SHORT' ? 100.05 : 100.95 });
    const s = rowOf([r], symbol, nowAfter(r)).shadow!;
    expect(s.qualified).toBe(true);
    expect(s.decision).toBe('NOT ELIGIBLE');
    expect(s.reasons.join(' ')).toMatch(/15:30|window|after/i);
  });
});

describe('Invariant B — SIP never manufactures a setup', () => {
  it('AVGO 2026-10-30 15:00: no genuine webhook → no record → no candidate, no decision (attractive SIP values are irrelevant)', () => {
    const out = run([], etToEpoch(D, '15:05:30'));
    expect(out.rows).toEqual([]);
    expect(out.candidates).toEqual([]);
  });
  it('only the webhook path creates records, and only queue records become candidates (source scan)', () => {
    const root = join(__dirname, '..', '..', '..', '..', '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') walk(p); } else if (/\.(ts|tsx|mts)$/.test(n)) files.push(p);
      }
    };
    walk(join(root, 'src'));
    walk(join(root, 'netlify'));
    const callers = (re: RegExp) => files.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1).replace(/\\/g, '/')).sort();
    expect(callers(/candidateFromRecord\(/)).toEqual(['src/engine/automation/autoCandidate.ts', 'src/engine/automation/liveQueue.ts']);
    expect(callers(/store\.put\(/)).toEqual(['netlify/lib/processAlert.ts']);
  });
});

describe('dedupe and tickets', () => {
  it('a v1.2 redelivery (duplicateOf set) → NOT ELIGIBLE DUPLICATE in the shadow; v1.1 unaffected', () => {
    const r = rec({ symbol: 'NVDA', closeEt: '10:15', price: 100.95 });
    r.v12 = { ...r.v12!, duplicateOf: 'NVDA-L-original' };
    const row = rowOf([r], 'NVDA', nowAfter(r));
    expect(row.shadow).toMatchObject({ decision: 'NOT ELIGIBLE', detail: 'DUPLICATE / EXISTING CANDIDATE' });
    expect(row.decision.decision).not.toBe('NOT ELIGIBLE');
  });
  it('qualified, clean alert: v1.2 shadow reaches the same TRADE NOW decision with the identical ticket (Invariant E)', () => {
    const r = rec({ symbol: 'NVDA', closeEt: '10:15', price: 100.95 });
    const row = rowOf([r], 'NVDA', nowAfter(r));
    expect(row.decision.decision).toMatch(/TRADE NOW|HIGH PRIORITY/);
    expect(row.shadow!.decision).toBe(row.decision.decision);
    expect(row.shadow!.ticket).toEqual(row.decision.ticket);
    expect(row.shadow!.scoring).toBe('V11_RANKING');
  });
});
