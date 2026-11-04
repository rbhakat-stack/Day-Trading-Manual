/**
 * S1 · Invariants A and D — one authoritative execution authorization; the Queue and the Opportunity Ranker never give
 * conflicting actionable answers for the same alert, quote, portfolio and instant. [DEFECT] tests are EXPECTED TO FAIL
 * on the 280b982 baseline.
 */
import { describe, expect, it } from 'vitest';
import type { ManualPosition } from '../../engine/ranker/opportunityTypes';
import { comps, et, fixtureSteps, loadFixture, queueAuthorizes, rankerAuthorizes, runApp } from './harness';
import { LONG, steps } from './synthetic';

/** Every instant at which the Ranker shows TRADE NOW although the Queue refuses (same pass = same state). */
const violations = (passes: ReturnType<typeof runApp>) =>
  passes.flatMap((p) => p.rows.filter((r) => rankerAuthorizes(p.ranked(r.record.id)) && !queueAuthorizes(r)).map((r) => `${r.record.id}@${et(p.now)}:${r.decision.decision}`));

describe('S1 · A · Ranker must not override a Queue refusal (synthetic)', () => {
  it('[DEFECT D2] stale current price (6 s old > 5 s limit): Queue refuses; Ranker must not show TRADE NOW', () => {
    const rec = LONG();
    const p = runApp([rec], steps('AAA', [[1, 100.95], [2, 100.95, { ageMs: 6000 }]]));
    expect(p[1].row(rec.id)!.decision.detail).toBe('STALE DATA — REFRESHING');
    expect(rankerAuthorizes(p[1].ranked(rec.id))).toBe(false);
  });
  it('[DEFECT D2] DATA REVIEW (SIP did not reproduce the alert): Queue refuses; Ranker must not show TRADE NOW', () => {
    const rec = LONG({ issues: [{ kind: 'REVIEW', code: 'ALERT_NOT_REPRODUCED', message: 'RVOL20 > 1.5 not reproduced' }] });
    const [p] = runApp([rec], steps('AAA', [[1, 100.95]]));
    expect(p.row(rec.id)!.decision.decision).toBe('DATA REVIEW REQUIRED');
    expect(rankerAuthorizes(p.ranked(rec.id))).toBe(false);
  });
  it('[DEFECT D2] no executable quote at all: Queue refuses; Ranker must not authorize from the alert-time price', () => {
    const rec = LONG();
    const [p] = runApp([rec], steps('AAA', [[1, null]]));
    expect(queueAuthorizes(p.row(rec.id))).toBe(false);
    expect(rankerAuthorizes(p.ranked(rec.id))).toBe(false);
  });
  it('portfolio verification gate: Queue withholds the ticket (existing protection)', () => {
    const rec = LONG();
    const [p] = runApp([rec], steps('AAA', [[1, 100.95]]), { portfolioGate: 'Broker data unavailable' });
    expect(p.row(rec.id)!.lifecycle.portfolioUnverified).toBe(true);
    expect(queueAuthorizes(p.row(rec.id))).toBe(false);
  });
  it('agreement when everything is valid: both authorize the fresh, untriggered ELITE setup', () => {
    const rec = LONG();
    const [p] = runApp([rec], steps('AAA', [[1, 100.95]]));
    expect(queueAuthorizes(p.row(rec.id))).toBe(true);
    expect(rankerAuthorizes(p.ranked(rec.id))).toBe(true);
  });
});

describe('S1 · A · broker / position precedence (synthetic)', () => {
  it('a submitted order (PENDING) is never a new-entry recommendation on either surface', () => {
    const rec = LONG();
    const p = runApp([rec], steps('AAA', [[1, 100.95], [2, 100.95]]), { before: (now, cs) => (now >= Date.parse('2026-10-30T10:17:04-04:00') ? cs.map((c) => ({ ...c, status: 'PENDING' as const })) : cs) });
    expect(p[1].row(rec.id)!.lifecycle.executionState).toBe('SUBMITTED');
    expect(queueAuthorizes(p[1].row(rec.id))).toBe(false);
    expect(rankerAuthorizes(p[1].ranked(rec.id))).toBe(false);
  });
  it('an open position in the ticker blocks a new same-ticker alert on both surfaces (no pyramiding)', () => {
    const rec = LONG();
    const pos: ManualPosition = { id: 'pos-AAA', ticker: 'AAA', direction: 'LONG', sector: 'Sector-AAA', industry: 'Industry-AAA', theme: '', positionValue: 10000, plannedRisk: 50, entry: 100, stop: 99, target: 102, status: 'OPEN' } as ManualPosition;
    const [p] = runApp([rec], steps('AAA', [[1, 100.95]]), { positions: [pos] });
    expect(queueAuthorizes(p.row(rec.id))).toBe(false);
    expect(rankerAuthorizes(p.ranked(rec.id))).toBe(false);
  });
});

describe('S1 · D · BSX LONG 12:20:06 — Queue 81 vs Ranker 85 at 12:26:49 (historical fixture)', () => {
  const FX = loadFixture('bsx-1220-peers');
  const passes = runApp(FX.records, fixtureSteps(FX));
  const ID = 'BSX-L-122006-77deee';
  // The instant of the audit observation (12:26:49), else the first instant at which the two totals differ.
  const p = passes.find((x) => et(x.now) === '12:26:49' && x.row(ID)?.ranked?.total !== x.ranked(ID)?.total) ?? passes.find((x) => x.row(ID)?.ranked?.total != null && x.ranked(ID)?.total != null && x.row(ID)!.ranked!.total !== x.ranked(ID)!.total)!;
  it('characterization: same instant, same state — the totals differ only by capital efficiency (6 vs 10)', () => {
    const q = p.row(ID)!.ranked!;
    const r = p.ranked(ID)!;
    expect([q.total, r.total]).toEqual([81, 85]);
    const qc = comps(q), rc = comps(r);
    expect(Object.keys(qc).filter((k) => qc[k] !== rc[k])).toEqual(['capitalEfficiency']);
    expect([qc.capitalEfficiency, rc.capitalEfficiency]).toEqual([6, 10]);
  });
  it('characterization: cause — the Queue excludes the DATA REVIEW peer NCLH 12:25:20 (2 peers → neutral 6/10); the Ranker counts it (3 peers → percentile 10/10)', () => {
    expect(p.row('NCLH-L-122520-d40c0b')!.decision.decision).toBe('DATA REVIEW REQUIRED');
    expect(p.row(ID)!.ranked!.components.find((k) => k.key === 'capitalEfficiency')!.calc.join(' ')).toMatch(/Only 2 candidate/);
    expect(p.ranked(ID)!.components.find((k) => k.key === 'capitalEfficiency')!.calc.join(' ')).toMatch(/Percentile among 3 candidates/);
  });
  it('[DEFECT D3] the two surfaces report the same strategy score for the same alert at the same instant', () => {
    expect(p.ranked(ID)!.total).toBe(p.row(ID)!.ranked!.total);
  });
  it('[DEFECT D2/D3] over the whole fixture, the Ranker never shows TRADE NOW where the Queue refuses', () => {
    expect(violations(passes)).toEqual([]);
  });
});

describe('S1 · A · whole-window invariant on the other historical fixtures', () => {
  for (const name of ['vrsk-1035', 'bsx-1300', 'unh-1400', 'nclh-1145']) {
    it(`${name}: no instant where the Ranker authorizes what the Queue refuses`, () => {
      const FX = loadFixture(name);
      expect(violations(runApp(FX.records, fixtureSteps(FX)))).toEqual([]);
    }, 60_000); // whole-window replays of real fixtures
  }
});
