import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, type LiveQuote } from '../../alertDecision';
import { buildAlertSnapshot, DEFAULT_SNAPSHOT_CONFIG, type SnapshotConfig } from '../../alertSnapshot';
import { etToEpoch } from '../../etTime';
import { buildQueue } from '../../liveQueue';
import { daysUpTo, recordWith, sessionBars } from '../../__tests__/fixtures';
import { cloneRankerDefaults } from '../../../ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../../settings';
import { needsRvolOptionalSnapshot, receiptAudit, v12Snapshot, withReconstruction, type AutoAlertRecordV12 } from '../audit';
import type { RuleSetEntry } from '../ruleSets';

/** Phase 3C.1 — RVOL-optional reconstruction (RB_V1_2_ARCHITECTURE.md §25). TEST / HYPOTHETICAL rule sets only. */
const REG: RuleSetEntry[] = [{ id: 'RBTS-L-901', direction: 'LONG', rulesVersion: 'RB v1.2', audited: 'TEST', checklistRef: 'TEST/HYPOTHETICAL', active: true, rules: ['TEST'] }];
const D = '2026-10-30';
const at = (hhmmss: string) => etToEpoch(D, hhmmss);
const ALERT = at('10:15:12');
const SIG = at('10:10');
const BARS = sessionBars(daysUpTo(D), { untilEt: '10:20' });
/** Same bars with a zero-volume signal candle → SIP RVOL20 cannot be calculated (RVOL20_UNAVAILABLE). */
const NO_RVOL = BARS.map((b) => (b.t === SIG ? { ...b, v: 0 } : b));
const OPT: SnapshotConfig = { ...DEFAULT_SNAPSHOT_CONFIG, optionalIndicators: ['RVOL20'] };
const codes = (s: { issues: { code: string }[] }) => s.issues.map((i) => i.code);

describe('snapshot builder: default (RB v1.1) behaviour is unchanged', () => {
  it('missing SIP RVOL still drops every value with RVOL20_UNAVAILABLE (INCOMPLETE)', () => {
    const s = buildAlertSnapshot(NO_RVOL, ALERT, 'LONG');
    expect(s.values).toBeNull();
    expect(s.issues.find((i) => i.code === 'RVOL20_UNAVAILABLE')?.kind).toBe('INCOMPLETE');
    expect(s.alertConditions).toEqual([]);
    expect(needsRvolOptionalSnapshot(s)).toBe(true);
  });
  it('an explicit empty optional list is the same as the default config', () => {
    for (const bars of [BARS, NO_RVOL]) {
      const a = buildAlertSnapshot(bars, ALERT, 'LONG');
      const b = buildAlertSnapshot(bars, ALERT, 'LONG', { ...DEFAULT_SNAPSHOT_CONFIG, optionalIndicators: [] });
      expect({ ...b, config: a.config }).toEqual(a);
    }
  });
  it('the default config object carries no optional list (stored v1.1 snapshots are byte-identical)', () => {
    expect(DEFAULT_SNAPSHOT_CONFIG).not.toHaveProperty('optionalIndicators');
    expect(JSON.stringify(buildAlertSnapshot(BARS, ALERT, 'LONG').config)).toBe(JSON.stringify(DEFAULT_SNAPSHOT_CONFIG));
  });
  it('when SIP RVOL is available, RVOL-optional gives exactly the v1.1 values, issues and conditions', () => {
    const a = buildAlertSnapshot(BARS, ALERT, 'LONG');
    const b = buildAlertSnapshot(BARS, ALERT, 'LONG', OPT);
    expect(a.values).not.toBeNull();
    expect({ ...b, config: a.config }).toEqual(a);
    expect(needsRvolOptionalSnapshot(a)).toBe(false);
  });
});

describe('snapshot builder: RVOL20 optional (RB v1.2 reconstruction)', () => {
  const v11 = buildAlertSnapshot(NO_RVOL, ALERT, 'LONG');
  const v12 = buildAlertSnapshot(NO_RVOL, ALERT, 'LONG', OPT);
  it('keeps the values when RVOL alone is missing; RVOL is NaN, never defaulted', () => {
    expect(v12.values).not.toBeNull();
    expect(v12.values!.rvol).toBeNaN();
    expect(codes(v12)).not.toContain('RVOL20_UNAVAILABLE');
    expect(codes(v12).filter((c) => c !== 'ALERT_NOT_REPRODUCED')).toEqual(codes(v11).filter((c) => c !== 'RVOL20_UNAVAILABLE'));
  });
  it('ticket geometry and the other indicators are the same bars, same formulas', () => {
    const ref = buildAlertSnapshot(BARS, ALERT, 'LONG').values!;
    const sig = NO_RVOL.find((b) => b.t === SIG)!;
    expect(v12.values).toMatchObject({ open: sig.o, high: sig.h, low: sig.l, close: sig.c, volume: 0, atr: ref.atr, ema9: ref.ema9, ema20: ref.ema20, rsi: ref.rsi, close15m: ref.close15m, ema20_15m: ref.ema20_15m });
    expect(v12.signal).toEqual(v11.signal);
  });
  it('the RVOL alert-condition re-check is omitted (not reported as a failure)', () => {
    expect(v12.alertConditions.map((c) => c.label)).not.toContain('RVOL20 > 1.5');
    expect(v12.alertConditions).toHaveLength(5);
  });
  it('does not broaden optionality: insufficient history / missing signal candle stay INCOMPLETE', () => {
    const short = buildAlertSnapshot(sessionBars([D], { untilEt: '10:20' }).map((b) => (b.t === SIG ? { ...b, v: 0 } : b)), ALERT, 'LONG', OPT);
    expect(short.values).toBeNull();
    expect(codes(short)).toContain('INSUFFICIENT_HISTORY');
    const missing = buildAlertSnapshot(NO_RVOL.filter((b) => b.t !== SIG), ALERT, 'LONG', OPT);
    expect(missing.values).toBeNull();
    expect(codes(missing)).toContain('SIGNAL_CANDLE_MISSING');
    const atrGone = buildAlertSnapshot(sessionBars([D], { untilEt: '10:30' }), ALERT, 'LONG', { ...OPT, minWarmupBars: 1 });
    expect(atrGone.values).toBeNull();
    expect(codes(atrGone)).toContain('ATR14_UNAVAILABLE');
  });
  it('only RVOL20 can be declared optional (type-level)', () => {
    // @ts-expect-error VWAP / EMA / RSI / ATR / 15m stay required
    const bad: SnapshotConfig = { ...DEFAULT_SNAPSHOT_CONFIG, optionalIndicators: ['VWAP'] };
    expect(bad).toBeTruthy();
  });
});

describe('queue: v1.1 unchanged, v1.2 continues when SIP RVOL alone is unavailable', () => {
  const snap11 = buildAlertSnapshot(NO_RVOL, ALERT, 'LONG');
  const snap12 = buildAlertSnapshot(NO_RVOL, ALERT, 'LONG', OPT);
  const price = snap12.values!.close;
  const base = recordWith({ symbol: 'GM', direction: 'LONG', alertIso: new Date(ALERT).toISOString(), receivedMs: ALERT, values: {}, price });
  base.alert.timeSource = 'RECEIVED';
  base.snapshot = snap11;
  const receipt = receiptAudit({ body: { rule_set: 'RBTS-L-901' }, symbol: 'GM', direction: 'LONG', receivedMs: ALERT, v11Key: base.dedupeKey, registry: REG });
  const fixed: AutoAlertRecordV12 = { ...base, v12: withReconstruction(receipt, base, NO_RVOL, 'LONG', DEFAULT_AUTOMATION.parity, snap12) };
  const before: AutoAlertRecordV12 = { ...base, v12: withReconstruction(receipt, base, NO_RVOL, 'LONG', DEFAULT_AUTOMATION.parity) };
  const now = ALERT + 30_000;
  const quote: LiveQuote = { price, tradeIso: new Date(now - 1000).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 };
  const run = (r: AutoAlertRecordV12) => buildQueue({ records: [r], candidates: [], positions: [], quotes: { GM: quote }, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify: () => ({ sector: 'Autos', industry: 'Autos', theme: '' }), parity: {}, strategyVersion: 'RB v1.1' });

  it('the audit stores the RVOL-optional rebuild; reconstruction has geometry and SIP RVOL = null', () => {
    expect(fixed.v12!.rvolOptionalSnapshot).toBe(snap12);
    expect(v12Snapshot(fixed)).toBe(snap12);
    expect(v12Snapshot(before)).toBe(snap11);
    expect(fixed.v12!.reconstruction).toMatchObject({ high: snap12.values!.high, low: snap12.values!.low, close: snap12.values!.close, atr14: snap12.values!.atr, sipRvol: null });
    expect(fixed.v12!.dataReview).toEqual([]);
    expect(fixed.v12!.warnings).toContain('SIP_UNAVAILABLE:RVOL');
  });
  it('v1.1: no candidate, identical decision and output with or without the v1.2 fix', () => {
    const plain = run({ ...base });
    const a = run(before);
    const b = run(fixed);
    expect(plain.candidates).toEqual([]);
    for (const q of [a, b]) {
      expect(q.candidates).toEqual(plain.candidates);
      expect(q.rows[0].decision).toEqual(plain.rows[0].decision);
      expect(q.rows[0].candidate).toBeNull();
      expect(q.rows[0].ranked).toBeNull();
      expect(q.changed).toBe(plain.changed);
    }
  });
  it('v1.2 before the fix: DATA REVIEW (reconstruction incomplete) — the dependency', () => {
    expect(run(before).rows[0].shadow).toMatchObject({ decision: 'DATA REVIEW REQUIRED', dataReview: ['RECONSTRUCTION_INCOMPLETE'] });
  });
  it('v1.2 with the fix: scored with the 6/15 floor from the RVOL-optional reconstruction; SIP RVOL only a diagnostic', () => {
    const sh = run(fixed).rows[0].shadow!;
    expect(sh.dataReview).toEqual([]);
    expect(sh.scoring).toBe('V12_RANKING');
    expect(sh.score).toMatchObject({ rvolPoints: 6, rvolMode: 'QUALIFIED_FLOOR' });
    expect(sh.score!.total).not.toBeNull();
    expect(sh.warnings).toContain('SIP_UNAVAILABLE:RVOL');
  });
  it('JSON round-trip (blob storage turns NaN into null) scores the same', () => {
    const stored = JSON.parse(JSON.stringify(fixed)) as AutoAlertRecordV12;
    expect(stored.v12!.rvolOptionalSnapshot!.values!.rvol).toBeNull();
    expect(run(stored).rows[0].shadow!.score).toEqual(run(fixed).rows[0].shadow!.score);
  });
  it('an unqualified record never gets a v1.2-only candidate', () => {
    const unq: AutoAlertRecordV12 = { ...base, v12: withReconstruction(receiptAudit({ body: {}, symbol: 'GM', direction: 'LONG', receivedMs: ALERT, v11Key: base.dedupeKey, registry: REG }), base, NO_RVOL, 'LONG', DEFAULT_AUTOMATION.parity, snap12) };
    expect(run(unq).rows[0].shadow).toMatchObject({ decision: 'NOT QUALIFIED', score: null });
  });
  it('RVOL missing plus another missing input: the rebuild stays incomplete → DATA REVIEW (integrity)', () => {
    const shortBars = sessionBars([D], { untilEt: '10:20' }).map((b) => (b.t === SIG ? { ...b, v: 0 } : b));
    const s11 = buildAlertSnapshot(shortBars, ALERT, 'LONG');
    const s12 = buildAlertSnapshot(shortBars, ALERT, 'LONG', OPT);
    const r = { ...base, snapshot: s11 };
    const rec: AutoAlertRecordV12 = { ...r, v12: withReconstruction(receipt, r, shortBars, 'LONG', DEFAULT_AUTOMATION.parity, s12) };
    expect(run(rec).rows[0].shadow).toMatchObject({ decision: 'DATA REVIEW REQUIRED' });
    expect(run(rec).rows[0].shadow!.dataReview).toContain('INSUFFICIENT_HISTORY');
  });
});
