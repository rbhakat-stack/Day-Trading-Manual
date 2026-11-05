/**
 * Step 3 · A (engine side) — what the app does with a record that is still waiting for a final signal candle, and with a
 * snapshot that was completed late. Synthetic records (clearly not market observations); the record is DATA_ERROR
 * (SIGNAL_CANDLE_INCOMPLETE) until the retry that completes it, as stored by the server, and the app's state is carried
 * across that change exactly as on a real poll (harness `start`).
 */
import { describe, expect, it } from 'vitest';
import type { AutoAlertRecord, DelayedReconstruction } from '../../engine/automation/alertDecision';
import { triggerKey } from '../../engine/automation/lifecycle/terminalEvents';
import { queueAuthorizes, rankerAuthorizes, runApp, synthQuote, type Pass, type Step } from './harness';
import { at, LONG, T0 } from './synthetic';

/** Fresh quotes every 3 s (the app's real price polling; the S2a.2 continuity limit is 8 s). */
const poll = (from: number, to: number, price: number): Step[] => {
  const out: Step[] = [];
  for (let m = from; m <= to + 1e-9; m += 0.05) out.push({ now: at(m), quotes: { AAA: synthQuote(price, at(m)) } });
  return out;
};
const waiting = (r: AutoAlertRecord, final = false): AutoAlertRecord => ({
  ...r, status: 'DATA_ERROR', snapshot: null, initialQuote: null, calcAtAlert: null, attempts: final ? 4 : 2,
  errorCode: final ? 'SIGNAL_CANDLE_INCOMPLETE_FINAL' : 'SIGNAL_CANDLE_INCOMPLETE', nextAttemptMs: final ? null : at(1.5),
  errors: [`SIGNAL_CANDLE_INCOMPLETE: The final minute (10:14 ET) of the 10:10–10:15 ET candle is not yet in the 1-minute data.`],
  firstProcessedIso: new Date(T0 + 3000).toISOString(), processedIso: new Date(T0 + 3000).toISOString(),
});
/** The same record completed on the 3rd attempt at +3.5 min, with the server's delay evidence. */
const completed = (r: AutoAlertRecord, gap: DelayedReconstruction['gap']['status']): AutoAlertRecord => ({
  ...r, attempts: 3, firstProcessedIso: new Date(T0 + 3000).toISOString(), processedIso: new Date(at(3.5)).toISOString(),
  initialQuote: { price: 100.95, tradeIso: new Date(at(3.5) - 1000).toISOString(), fetchedIso: new Date(at(3.5)).toISOString() },
  delayedReconstruction: {
    firstAttemptIso: new Date(T0 + 3000).toISOString(), finalIso: new Date(at(3.5)).toISOString(), attempts: 3,
    gap: { status: gap, direction: 'LONG', entry: 101.02, fromIso: new Date(T0).toISOString(), toIso: new Date(at(3.5)).toISOString(), extreme: gap === 'CROSSED' ? 101.05 : 100.97, crossedAtIso: gap === 'CROSSED' ? new Date(at(2)).toISOString() : null, crossedPrice: gap === 'CROSSED' ? 101.05 : null, reason: `synthetic ${gap}` },
  },
});
function run(gap: DelayedReconstruction['gap']['status'], o: { observe?: boolean } = {}): { before: Pass[]; after: Pass[]; rec: AutoAlertRecord } {
  const rec = LONG();
  const before = runApp([waiting(rec)], poll(0.1, 3.4, 100.95), { observe: o.observe });
  const after = runApp([completed(rec, gap)], poll(3.5, 12, 100.95), { start: before[before.length - 1].state, observe: o.observe });
  return { before, after, rec };
}
const authorized = (ps: Pass[], id: string) => ps.filter((p) => queueAuthorizes(p.row(id)) || rankerAuthorizes(p.ranked(id)));

describe('Step 3 · D — one price for scoring, chase and execution; conservative trigger evidence', () => {
  /** Eligible executable price 100.95 (below the 101.02 entry), with the newer ineligible print the server skipped. */
  const withSkipped = (from: number, to: number, skipped: { price: number; conditions: string[] } | null): Step[] =>
    poll(from, to, 100.95).map((s) => ({ ...s, quotes: { AAA: { ...s.quotes.AAA, priceSource: skipped ? 'LATEST_ELIGIBLE' as const : 'LATEST' as const, skipped: skipped ? { ...skipped, tradeIso: new Date(s.now - 800).toISOString(), tape: 'A' } : null } } }));
  it('an odd-lot print at/through the entry ends the alert on the SAME pass (MISSED), although the executable price is below the entry; never revives', () => {
    const rec = LONG();
    const ps = runApp([rec], [...poll(0.1, 1, 100.95), ...withSkipped(1.05, 1.05, { price: 101.03, conditions: [' ', 'I'] }), ...poll(1.1, 4, 100.95)]);
    expect(authorized(ps.filter((p) => p.now < at(1.05)), rec.id).length).toBeGreaterThan(0);
    const hit = ps.find((p) => p.now === at(1.05))!;
    expect(hit.row(rec.id)!.ranked!.total).toEqual(expect.any(Number)); // scored on the eligible price
    expect(hit.row(rec.id)!.lifecycle.executionState).toBe('MISSED — TRIGGER CROSSED');
    expect(authorized(ps.filter((p) => p.now >= at(1.05)), rec.id)).toEqual([]);
    expect(ps[ps.length - 1].state.terminal[triggerKey(rec.id)]).toMatchObject({ kind: 'TRIGGER_CROSSED', price: 101.03 });
  });
  it('an average-price / derivatively priced print at/through the entry is not evidence: the alert stays READY', () => {
    const rec = LONG();
    const ps = runApp([rec], [...poll(0.1, 1, 100.95), ...withSkipped(1.05, 2, { price: 101.5, conditions: [' ', '4', 'B'] })]);
    expect(ps[ps.length - 1].state.terminal[triggerKey(rec.id)]).toBeUndefined();
    expect(authorized(ps.filter((p) => p.now >= at(1.05)), rec.id).length).toBeGreaterThan(0);
  });
  it('a skipped odd lot below the entry changes nothing (LONG); for a SHORT the mirror applies (price ≤ entry)', () => {
    const rec = LONG();
    const ps = runApp([rec], [...poll(0.1, 1, 100.95), ...withSkipped(1.05, 2, { price: 100.99, conditions: [' ', 'I'] })]);
    expect(ps[ps.length - 1].state.terminal[triggerKey(rec.id)]).toBeUndefined();
  });
});

describe('Step 3 · A — waiting for a final signal candle', () => {
  it('SIGNAL_CANDLE_INCOMPLETE: DATA REVIEW with the precise reason, no candidate, no score, no ticket, never authorized', () => {
    const { before, rec } = run('NOT_CROSSED');
    for (const p of before) {
      const r = p.row(rec.id)!;
      expect(r.decision).toMatchObject({ decision: 'DATA REVIEW REQUIRED', detail: 'SIGNAL CANDLE INCOMPLETE — RETRY SCHEDULED', ticket: null });
      expect(r.decision.reasons[0]).toMatch(/SIGNAL_CANDLE_INCOMPLETE/);
      expect(r.candidate).toBeNull();
    }
    expect(authorized(before, rec.id)).toEqual([]);
  });
  it('retries exhausted: SIGNAL CANDLE INCOMPLETE — MANUAL REVIEW REQUIRED, and at expiry it stays never-actionable (no revival)', () => {
    const rec = LONG();
    const ps = runApp([waiting(rec, true)], poll(0.1, 12, 100.95));
    expect(ps[0].row(rec.id)!.decision.detail).toBe('SIGNAL CANDLE INCOMPLETE — MANUAL REVIEW REQUIRED');
    expect(authorized(ps, rec.id)).toEqual([]);
    expect(ps[ps.length - 1].row(rec.id)!.lifecycle.finalActionability).toBe('NO TRADE');
  });
});

describe('Step 3 · A — a snapshot completed late (requirements 9–11)', () => {
  it('NOT_CROSSED (server proved every minute and trade): authorized normally — but only inside the ORIGINAL 10-minute window', () => {
    const { after, rec } = run('NOT_CROSSED', { observe: true });
    const t = authorized(after, rec.id).map((p) => p.now);
    expect(t.length).toBeGreaterThan(0);
    expect(Math.max(...t)).toBeLessThan(rec.alert.alertTimeMs + 600_000); // expiry never reset by the late data
    expect(after.find((p) => p.now >= rec.alert.alertTimeMs + 600_000)!.row(rec.id)!.lifecycle.executionState).toBe('EXPIRED — STALE');
  });
  it('UNVERIFIED (gap evidence missing): never authorized — DATA REVIEW / NO TICKET with the reason; fail closed, even with continuous observation afterwards', () => {
    const { after, rec } = run('UNVERIFIED', { observe: true });
    expect(authorized(after, rec.id)).toEqual([]);
    const r = after.find((p) => p.row(rec.id)?.decision.ticket)!.row(rec.id)!;
    expect(r.lifecycle).toMatchObject({ finalActionability: 'NO TICKET', executionState: 'DATA REVIEW' });
    expect(r.lifecycle.reason).toMatch(/trigger continuity during the delayed reconstruction is unverified/);
  });
  it('UNVERIFIED also refuses when the caller does not track observation (no legacy bypass)', () => {
    const { after, rec } = run('UNVERIFIED');
    expect(authorized(after, rec.id)).toEqual([]);
  });
  it('CROSSED during the delay: latched as the terminal missed trigger (MISSED), never authorized, survives reload', () => {
    const { after, rec } = run('CROSSED', { observe: true });
    expect(authorized(after, rec.id)).toEqual([]);
    const ev = after[after.length - 1].state.terminal[triggerKey(rec.id)];
    expect(ev).toMatchObject({ kind: 'TRIGGER_CROSSED', price: 101.05, entry: 101.02, observedAtMs: at(2) });
    expect(after[2].row(rec.id)!.lifecycle.executionState).toBe('MISSED — TRIGGER CROSSED');
    const reload = runApp([completed(rec, 'CROSSED')], poll(5, 8, 100.95), { start: JSON.parse(JSON.stringify(after[4].state)), observe: true });
    expect(authorized(reload, rec.id)).toEqual([]);
  });
  it('entry, stop, target, quantity, risk and score of the late snapshot equal those of the same alert processed on time; the v1.2 shadow is unchanged', () => {
    const rec = LONG();
    const onTime = runApp([rec], poll(3.5, 4, 100.95));
    const late = runApp([completed(rec, 'NOT_CROSSED')], poll(3.5, 4, 100.95));
    const a = onTime[onTime.length - 1].row(rec.id)!, b = late[late.length - 1].row(rec.id)!;
    const plan = (r: typeof a) => [r.candidate!.entry, r.candidate!.stop, r.candidate!.target, r.candidate!.shares, r.candidate!.plannedRisk, r.ranked!.total];
    expect(plan(b)).toEqual(plan(a));
    expect(b.shadow).toEqual(a.shadow);
  });
});
