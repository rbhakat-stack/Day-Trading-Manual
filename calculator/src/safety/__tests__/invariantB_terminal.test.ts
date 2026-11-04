/**
 * S1 · Invariant B — a terminal disqualification (reliable chase beyond 0.25 ATR, or SETUP FAILED) never revives into a
 * new-order authorization after a price pullback. EXPECTED TO FAIL on the 280b982 baseline where marked [DEFECT].
 *
 * VRSK LONG 2026-11-04 10:35:09 (historical fixture). Expected values are derived from the market facts only:
 * entry 201.26, ATR 0.7879305 → chase limit 201.26 + 0.25 × ATR = 201.457; first round-lot beyond it: 201.465 @ 10:35:13.338.
 */
import { describe, expect, it } from 'vitest';
import { et, fixtureSteps, loadFixture, queueAuthorizes, rankerAuthorizes, runApp, type State } from './harness';
import { at, LONG, steps } from './synthetic';

const FX = loadFixture('vrsk-1035');
const REC = FX.records[0];
const ID = REC.id;
const ENTRY = 201.26;
const LIMIT = ENTRY + 0.25 * (REC.snapshot!.values!.atr as number);
const passes = runApp(FX.records, fixtureSteps(FX));
const firstChase = passes.findIndex((p) => (FX.quotes.VRSK[FX.stepsMs.indexOf(p.now)]?.[0] ?? 0) > LIMIT);

describe('S1 · B · VRSK LONG 10:35:09 terminal chase', () => {
  it('fixture facts: chase limit 201.457; first observation beyond it is the 201.465 round lot (10:35:13.338)', () => {
    expect(LIMIT).toBeCloseTo(201.457, 3);
    expect(FX.quotes.VRSK[firstChase]).toEqual([201.465, expect.stringContaining('15:35:13.338')]);
  });
  it('the Queue authorized the untriggered BUY STOP before the chase (10:35:12)', () => {
    expect(passes.slice(0, firstChase).some((p) => queueAuthorizes(p.row(ID)))).toBe(true);
  });
  it('[DEFECT D1] the Queue never authorizes a new order after the reliable chase observation', () => {
    const revived = passes.slice(firstChase).filter((p) => queueAuthorizes(p.row(ID))).map((p) => et(p.now));
    expect(revived).toEqual([]);
  });
  it('[DEFECT D2] the Opportunity Ranker never shows TRADE NOW after the reliable chase observation', () => {
    const revived = passes.slice(firstChase).filter((p) => rankerAuthorizes(p.ranked(ID))).map((p) => et(p.now));
    expect(revived).toEqual([]);
  });
  it('after the 10-minute window nothing is authorized by either surface', () => {
    const after = passes.filter((p) => p.now >= REC.alert.alertTimeMs + 600_000);
    expect(after.length).toBeGreaterThan(0);
    for (const p of after) {
      expect(queueAuthorizes(p.row(ID))).toBe(false);
      expect(rankerAuthorizes(p.ranked(ID))).toBe(false);
    }
  });
  it('[DEFECT D1] a reliable chase is persisted, so it survives a browser reload (terminal-events map)', () => {
    const persisted = JSON.parse(JSON.stringify(passes[firstChase + 2].state.terminal)) as State['terminal'];
    expect(Object.values(persisted).some((e) => e.recordId === ID)).toBe(true);
  });
});

describe('S1 · B · SETUP FAILED followed by recovery (synthetic)', () => {
  const rec = LONG();
  const p = runApp([rec], steps('AAA', [[1, 100.95], [2, 99.95], [3, 100.95], [4, 100.98]]));
  it('the Queue latches SETUP FAILED and withholds every later ticket (existing protection)', () => {
    expect(p[1].state.terminal[rec.id]).toMatchObject({ kind: 'SETUP_FAILED' });
    for (const x of p.slice(2)) expect(queueAuthorizes(x.row(rec.id))).toBe(false);
  });
  it('[DEFECT D2] the Ranker never shows TRADE NOW after the latched SETUP FAILED', () => {
    for (const x of p.slice(2)) expect(rankerAuthorizes(x.ranked(rec.id))).toBe(false);
  });
  it('the SETUP FAILED latch survives a reload (JSON round trip)', () => {
    const start = JSON.parse(JSON.stringify(p[2].state)) as State;
    const [r] = runApp([rec], steps('AAA', [[5, 100.95]]), { start });
    expect(r.row(rec.id)!.lifecycle.executionState).toBe('SETUP FAILED');
    expect(queueAuthorizes(r.row(rec.id))).toBe(false);
  });
});

describe('S1 · B · synthetic chase then pullback (no historical dependency)', () => {
  const rec = LONG();
  const p = runApp([rec], steps('AAA', [[1, 100.95], [2, 101.4], [3, 100.95], [4, 101.0]]));
  it('chase beyond 0.25 ATR (101.40 > 101.27) is CHASED / NO TRADE on the observing pass', () => {
    expect(p[1].row(rec.id)!.lifecycle.executionState).toBe('CHASED');
    expect(queueAuthorizes(p[1].row(rec.id))).toBe(false);
  });
  it('[DEFECT D1] the pullback below the trigger does not re-authorize the same alert', () => {
    for (const x of p.slice(2)) expect(queueAuthorizes(x.row(rec.id))).toBe(false);
  });
  it('[DEFECT D2] … nor does the Ranker', () => {
    for (const x of p.slice(2)) expect(rankerAuthorizes(x.ranked(rec.id))).toBe(false);
  });
  it('expiry wording does not claim "no trigger" when the trigger was crossed [DEFECT D12]', () => {
    const [x] = runApp([rec], steps('AAA', [[10.1, 101.1]]), { start: p[3].state });
    expect(x.row(rec.id)!.lifecycle.reason).not.toMatch(/no trigger/);
  });
  it('at 10.1 minutes neither surface authorizes (alert expired)', () => {
    const [x] = runApp([rec], steps('AAA', [[10.1, 100.95]]), { start: p[3].state });
    expect(queueAuthorizes(x.row(rec.id))).toBe(false);
    expect(rankerAuthorizes(x.ranked(rec.id))).toBe(false);
  });
  void at;
});
