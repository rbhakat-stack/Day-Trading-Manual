/**
 * S1 · Invariant E — independent same-ticker alerts are not blocked by an earlier NON-ACTIONABLE candidate, while a
 * submitted order or an open position still blocks a duplicate entry. [DEFECT] tests are EXPECTED TO FAIL on 280b982.
 *
 * NCLH LONG 2026-11-04 11:45:11 → 12:15:20 (historical fixture, same ticker only).
 */
import { describe, expect, it } from 'vitest';
import { et, fixtureSteps, loadFixture, queueAuthorizes, rankerAuthorizes, runApp } from './harness';
import { ALERT, LONG, steps } from './synthetic';

const FX = loadFixture('nclh-1145');
const passes = runApp(FX.records, fixtureSteps(FX));
const recs = FX.records;
const firstRelease = (id: string) => passes.find((p) => p.row(id) && p.row(id)!.decision.decision !== 'SCORING');

describe('S1 · E · NCLH sequence', () => {
  it('characterization: the first NCLH alert (11:45:11) was never trade-eligible (frozen SKIP)', () => {
    const snap = passes[passes.length - 1].state.frozen[recs[0].id];
    expect(snap.v11.tier === 'SKIP' || snap.v11.tier === 'LOW_PRIORITY').toBe(true);
  });
  it('[DEFECT D4] no later independent NCLH alert is rejected as DUPLICATE because of an earlier non-actionable NEW candidate', () => {
    const blocked = recs.slice(1).filter((r) => firstRelease(r.id)?.row(r.id)!.decision.detail === 'DUPLICATE / EXISTING CANDIDATE').map((r) => `${r.id}@${et(firstRelease(r.id)!.now)}`);
    expect(blocked).toEqual([]);
  });
  it('[DEFECT D8] no NCLH alert-time snapshot is frozen blank because of the duplicate short-circuit', () => {
    const snaps = passes[passes.length - 1].state.frozen;
    const blank = recs.filter((r) => snaps[r.id]?.v11.decision === 'NOT ELIGIBLE' && snaps[r.id]?.v11.total === null && passes.some((p) => p.row(r.id)?.decision.detail === 'DUPLICATE / EXISTING CANDIDATE')).map((r) => r.id);
    expect(blank).toEqual([]);
  });
  it('characterization: a blocked alert gets its candidate only after the earlier one goes stale (≈ 5 minutes late)', () => {
    const r = recs.find((x) => x.id.startsWith('NCLH-L-115008'))!;
    const created = passes.find((p) => p.state.candidates.some((c) => c.id === r.id))!;
    expect(created.now - r.receivedMs).toBeGreaterThan(4 * 60_000);
  });
  it('the Ranker and Queue never authorize two NCLH entries at the same instant (no duplicate recommendations)', () => {
    for (const p of passes) {
      expect(recs.filter((r) => queueAuthorizes(p.row(r.id))).length).toBeLessThanOrEqual(1);
      expect(recs.filter((r) => rankerAuthorizes(p.ranked(r.id))).length).toBeLessThanOrEqual(1);
    }
  });
});

describe('S1 · E · protections that must stay (synthetic)', () => {
  const first = LONG();
  const second = LONG({ alertIso: '2026-10-30T10:18:04-04:00' });
  it('a submitted (PENDING) earlier entry blocks a new same-ticker alert as DUPLICATE', () => {
    const p = runApp([first, second], steps('AAA', [[1, 100.95], [4.5, 100.95]]), { before: (now, cs) => (now > Date.parse(ALERT) + 120_000 ? cs.map((c) => (c.id === first.id ? { ...c, status: 'PENDING' as const } : c)) : cs) });
    expect(p[1].row(second.id)!.decision.detail).toBe('DUPLICATE / EXISTING CANDIDATE');
    expect(queueAuthorizes(p[1].row(second.id))).toBe(false);
  });
  it('a filled earlier entry blocks a new same-ticker alert as DUPLICATE', () => {
    const p = runApp([first, second], steps('AAA', [[1, 100.95], [4.5, 100.95]]), { before: (now, cs) => (now > Date.parse(ALERT) + 120_000 ? cs.map((c) => (c.id === first.id ? { ...c, status: 'FILLED' as const } : c)) : cs) });
    expect(p[1].row(second.id)!.decision.detail).toBe('DUPLICATE / EXISTING CANDIDATE');
  });
  it('a user-SKIPPED earlier candidate does not block a new independent alert', () => {
    const p = runApp([first, second], steps('AAA', [[1, 100.95], [4.5, 100.95]]), { before: (now, cs) => (now > Date.parse(ALERT) + 120_000 ? cs.map((c) => (c.id === first.id ? { ...c, status: 'SKIPPED' as const } : c)) : cs) });
    expect(p[1].row(second.id)!.decision.detail).not.toBe('DUPLICATE / EXISTING CANDIDATE');
  });
});
