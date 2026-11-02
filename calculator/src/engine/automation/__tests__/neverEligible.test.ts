/**
 * Never-eligible vs EXPIRED — STALE, and the 15:30 entry cutoff state. Only a valid setup can expire; an alert that
 * was never actionable keeps the reason. The RB v1.1 decision is unchanged in every case.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue, type QueueInput } from '../liveQueue';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import type { Candidate } from '../../ranker/opportunityTypes';
import { RB_V1_DEFAULTS } from '../../settings';
import { recordWith } from './fixtures';
import { freezeAlertSnapshots, type AlertSnapshotMap } from '../lifecycle/alertTimeSnapshot';
import { neverEligible } from '../lifecycle/executionState';

const ALERT = '2026-10-30T10:15:04-04:00';
const T0 = Date.parse(ALERT);
const NOW = T0 + 60_000;
const quote = (price: number, now: number): LiveQuote => ({ price, tradeIso: new Date(now - 1000).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 });
function run(records: AutoAlertRecord[], o: Partial<QueueInput> = {}) {
  const now = o.now ?? NOW;
  const quotes = Object.fromEntries(records.map((r) => [r.alert.symbol, quote(r.initialQuote!.price, now)]));
  return buildQueue({ records, candidates: [], positions: [], quotes, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify: () => ({ sector: 'S', industry: 'I', theme: '' }), parity: {}, strategyVersion: 'RB v1.1', ...o });
}
const strong = (values: Record<string, number> = {}, alertIso = ALERT) => recordWith({ symbol: 'XYZ', direction: 'LONG', alertIso, price: 100.95, values });
const TICKETS = ['TRADE NOW — ELITE', 'HIGH PRIORITY — TRADE CONSIDERATION'];
const weak = () => strong({ rvol: 1.5, rsi: 56, ema9: 100.15, ema20: 100.1 });
function session(rec: AutoAlertRecord, times: number[]) {
  let candidates: Candidate[] = [];
  let frozen: AlertSnapshotMap = {};
  return times.map((now) => {
    const out = run([rec], { candidates, frozen, now });
    candidates = out.candidates;
    frozen = freezeAlertSnapshots(frozen, out.rows, now, 91).map;
    return out.rows[0];
  });
}

describe('never-eligible vs EXPIRED — STALE', () => {
  it('after-hours alert stays NOT ELIGIBLE at 1, 11 and 60 minutes (never EXPIRED — STALE)', () => {
    const at = Date.parse('2026-10-30T15:55:04-04:00');
    const rows = session(strong({}, '2026-10-30T15:55:04-04:00'), [at + 60_000, at + 11 * 60_000, at + 60 * 60_000]);
    for (const r of rows) {
      expect(r.decision.decision).toBe('NOT ELIGIBLE');
      expect(r.lifecycle).toMatchObject({ executionState: 'NOT ELIGIBLE', finalActionability: 'NO TRADE' });
    }
    expect(rows[2].lifecycle.reason).toMatch(/^NOT ELIGIBLE — .*never actionable/);
  });
  it('below-threshold alert keeps BELOW THRESHOLD after the window (frozen alert-time reason)', () => {
    const [a, b] = session(weak(), [NOW, T0 + 11 * 60_000]);
    expect(a.lifecycle.executionState).toBe('BELOW THRESHOLD');
    expect(b.decision.detail).toBe('STALE — DO NOT TRADE'); // RB v1.1 output unchanged
    expect(b.lifecycle).toMatchObject({ executionState: 'BELOW THRESHOLD', finalActionability: 'NO TRADE', terminal: true });
  });
  it('data never trustworthy within the window stays DATA REVIEW (never actionable), not EXPIRED', () => {
    const rec: AutoAlertRecord = { ...strong(), status: 'DATA_ERROR', snapshot: null as unknown as AutoAlertRecord['snapshot'], errors: ['provider error'] };
    const r = run([rec], { now: T0 + 11 * 60_000 }).rows[0];
    expect(r.lifecycle).toMatchObject({ executionState: 'DATA REVIEW', finalActionability: 'NO TRADE' });
    expect(r.lifecycle.reason).toMatch(/Never actionable/);
  });
  it('missing / invalid v1.2 rule_set with no ticket at alert time → NOT ELIGIBLE (TrendSpider not qualified)', () => {
    const row = run([strong()], { now: T0 + 11 * 60_000 }).rows[0];
    const unq = { ...row, decision: { ...row.decision, decision: 'WATCHLIST' as const, detail: 'x' }, record: { ...row.record, v12: { qualification: { status: 'NOT_QUALIFIED', ruleSet: { status: 'MISSING' } } } } } as typeof row;
    expect(neverEligible(unq, null)).toEqual({ state: 'NOT ELIGIBLE', reason: 'NOT ELIGIBLE — TrendSpider not qualified: rule_set MISSING (never actionable)' });
  });
  it('a valid setup that aged out is EXPIRED — STALE; chased setups are time-driven, not never-eligible', () => {
    expect(session(strong(), [NOW, T0 + 11 * 60_000])[1].lifecycle.executionState).toBe('EXPIRED — STALE');
    const row = run([strong()]).rows[0];
    expect(neverEligible({ ...row, decision: { ...row.decision, decision: 'NOT ELIGIBLE', detail: 'DO NOT CHASE' } }, null)).toBeNull();
  });
});

describe('15:30 entry cutoff state', () => {
  const late = strong({}, '2026-10-30T15:29:04-04:00');
  it('alert 15:29, viewed 15:31: v1.1 output unchanged, historical ticket preserved in the frozen snapshot, v1.2 NO TICKET + cutoff', () => {
    let frozen: AlertSnapshotMap = {};
    const t1 = Date.parse('2026-10-30T15:29:40-04:00');
    const first = run([late], { now: t1 });
    frozen = freezeAlertSnapshots(frozen, first.rows, t1, 91).map;
    expect(first.rows[0].decision.ticket).not.toBeNull();
    const r = run([late], { candidates: first.candidates, frozen, now: Date.parse('2026-10-30T15:31:00-04:00') }).rows[0];
    // RB v1.1 evaluates the entry window at evaluation time: it withdraws the ticket itself (unchanged behaviour).
    expect(r.decision).toMatchObject({ decision: 'NOT ELIGIBLE', detail: 'NOT ELIGIBLE — NEW ENTRY WINDOW CLOSED', ticket: null });
    // The ticket issued at 15:29 is preserved as history.
    const snap = frozen[late.id];
    expect(TICKETS).toContain(snap.v11.decision);
    expect(snap.trade).toMatchObject({ entry: first.rows[0].candidate!.entry, shares: first.rows[0].candidate!.shares });
    expect(r.candidate).toMatchObject({ entry: snap.trade!.entry, shares: snap.trade!.shares });
    // v1.2 operational state: unambiguous, and the 15:29 alert is NOT reported as never eligible.
    expect(r.lifecycle).toMatchObject({ executionState: 'ENTRY WINDOW CLOSED', finalActionability: 'NO TICKET', entryWindowClosed: true });
    expect(neverEligible(r, snap)).toBeNull();
    expect(r.lifecycle.reason).toMatch(/NO TICKET — ENTRY WINDOW CLOSED/);
    expect(r.lifecycle.reason).toMatch(/DO NOT EXECUTE — AFTER 3:30 PM ENTRY CUTOFF/);
  });
  it('before the cutoff the same alert is READY (no flag)', () => {
    const r = run([late], { now: Date.parse('2026-10-30T15:29:40-04:00') }).rows[0];
    expect(r.lifecycle).toMatchObject({ finalActionability: 'READY', entryWindowClosed: false });
  });
});
