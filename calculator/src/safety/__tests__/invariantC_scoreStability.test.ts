/**
 * S1 · Invariant C — frozen alert-time strategy quality vs live price / portfolio conditions vs final authorization.
 * These are CHARACTERIZATION tests of the current live-score model (they document behaviour; the scoring policy is
 * pending user approval — see S1_SAFETY_SPEC.md §4). Policy-dependent invariants are listed as todo.
 *
 * UNH LONG 2026-11-04 14:00:09 (historical fixture): EMA9 410.175, ATR 1.2165 → the location rule "dEMA9 > 1.0 ATR → −1"
 * flips at 410.175 + 1.2165 = 411.3915. Above it location = 0 (total 74), at/below it location = 1 (total 75).
 */
import { describe, expect, it } from 'vitest';
import { classifyScore } from '../../engine/ranker/candidateRanker';
import { V12_SHADOW_GRADES } from '../../engine/automation/v12/v12Thresholds';
import { comps, et, fixtureSteps, loadFixture, queueAuthorizes, RK, runApp, synthQuote } from './harness';

const FX = loadFixture('unh-1400');
const U = FX.records.find((r) => r.alert.symbol === 'UNH')!;
const V = U.snapshot!.values!;
const FLIP = (V.ema9 as number) + 1.0 * (V.atr as number);
const passes = runApp(FX.records, fixtureSteps(FX));
const scored = passes.map((p) => ({ p, r: p.row(U.id)! })).filter((x) => x.r.ranked?.total != null);

describe('S1 · C · UNH LONG 14:00:09 — price-driven 74 ↔ 75', () => {
  it('fixture facts: flip price 411.39; frozen alert-time v1.1 74 SKIP and v1.2 74/91 WATCHLIST', () => {
    expect(FLIP).toBeCloseTo(411.3915, 3);
    const snap = passes[passes.length - 1].state.frozen[U.id];
    expect(snap.v11).toMatchObject({ total: 74, tier: 'SKIP' });
    expect(snap.v12).toMatchObject({ total: 74, tierOptionB: 'WATCHLIST' });
  });
  it('every live score equals 74 + location, and location = (price ≤ flip ? 1 : 0); no other component moves', () => {
    for (const { p, r } of scored) {
      const price = r.quote!.price;
      const c = comps(r.ranked);
      expect(c.location, `${et(p.now)} @ ${price}`).toBe(price <= FLIP ? 1 : 0);
      expect(r.ranked!.total).toBe(74 + c.location);
      expect({ ...c, location: 0 }).toEqual({ trend: 15, rvol: 6, momentum: 10, candle: 9, location: 0, time: 8, capitalEfficiency: 6, capitalAvailability: 8, correlation: 7, portfolioRisk: 5 });
    }
  });
  it('observed sequence: 74 @ 411.58 (14:00:12) → 75 @ 411.2335 (14:00:33); oscillates repeatedly; decision stays SKIP', () => {
    const at = (t: string) => scored.find((x) => et(x.p.now).startsWith(t))!;
    expect([at('14:00:12').r.quote!.price, at('14:00:12').r.ranked!.total]).toEqual([411.5839, 74]);
    expect([at('14:00:33').r.quote!.price, at('14:00:33').r.ranked!.total]).toEqual([411.2335, 75]);
    const flips = scored.filter((x, i) => i > 0 && x.r.ranked!.total !== scored[i - 1].r.ranked!.total).length;
    expect(flips).toBeGreaterThanOrEqual(10);
    for (const { r } of scored) expect(r.decision.decision).toBe('SKIP');
  });
  it('the boundary itself, on the real UNH record (synthetic quotes 411.39 vs 411.40): 75 vs 74', () => {
    const now = U.receivedMs + 3000;
    const total = (price: number) => runApp([U], [{ now, quotes: { UNH: synthQuote(price, now) } }])[0].row(U.id)!.ranked!.total;
    expect([total(411.39), total(411.40)]).toEqual([75, 74]);
  });
  it('v1.2 re-scores live too: its live score moves 74 ↔ 75 while the displayed (frozen) v1.2 score stays 74', () => {
    const live = new Set(scored.map((x) => x.r.shadow?.score?.total).filter((x) => x != null));
    expect([...live].sort()).toEqual([74, 75]);
    for (const { r } of scored) expect(r.lifecycle.frozenV12?.total ?? 74).toBe(74);
  });
  it('the peer SHW (arrived 14:00:16) does not change UNH\'s score here (identical totals with and without it)', () => {
    const solo = runApp([U], fixtureSteps(FX));
    scored.forEach(({ p, r }) => expect(solo.find((s) => s.now === p.now)!.row(U.id)!.ranked?.total ?? null).toBe(r.ranked!.total));
  });
});

describe('S1 · C · BSX LONG 13:00:15 — frozen 82 (WATCHLIST) and later live authorizations (historical fixture)', () => {
  const B = loadFixture('bsx-1300');
  const ID = 'BSX-L-130015-7a1518';
  const ps = runApp(B.records, fixtureSteps(B));
  const auth = ps.map((p) => queueAuthorizes(p.row(ID)));
  const windows = auth.filter((a, i) => a && !(i > 0 && auth[i - 1])).length;
  it('characterization: frozen alert-time v1.1 is below the 85 trade threshold', () => {
    expect(ps[ps.length - 1].state.frozen[ID].v11).toMatchObject({ total: 82, tier: 'WATCHLIST' });
  });
  // Revised for the approved D policy (was: "under the current live model the Queue nevertheless authorizes it in several
  // separate windows" — every one of those windows came after the entry trigger had already been crossed). A confirmed
  // crossing of the 46.46 trigger at 13:00:36 ET (fresh prints at/through it until ≈ 13:02) is terminal: the alert is
  // never authorized afterwards, even when the live score later reaches ≥ 85 on a pullback.
  it('the confirmed trigger crossing at 13:00:36 is latched (fresh print ≥ 46.46) and the alert is never authorized after it', () => {
    const ev = ps[ps.length - 1].state.terminal[`${ID}|TRIGGER`];
    expect(ev).toMatchObject({ kind: 'TRIGGER_CROSSED', entry: 46.46 });
    expect(ev.price).toBeGreaterThanOrEqual(46.46);
    expect(et(ev.observedAtMs)).toBe('13:00:36');
    expect(ps.filter((p) => p.now >= ev.observedAtMs && queueAuthorizes(p.row(ID))).map((p) => et(p.now))).toEqual([]);
    expect(windows).toBe(0); // the live score never reached 85 before the crossing (82 / 6-point frozen capital efficiency)
  });
  it('after the crossing the lifecycle is MISSED — TRIGGER CROSSED (terminal) on every pass inside the window, even at a live score ≥ 85', () => {
    const ev = ps[ps.length - 1].state.terminal[`${ID}|TRIGGER`];
    const after = ps.filter((p) => p.now > ev.observedAtMs && p.now < ev.alertTimeMs + 600_000 && p.row(ID));
    expect(after.some((p) => (p.row(ID)!.ranked?.total ?? 0) >= 85)).toBe(true);
    for (const p of after) expect(p.row(ID)!.lifecycle.executionState).toBe('MISSED — TRIGGER CROSSED');
  });
  it('characterization: every authorization coincides with a live score ≥ 85 (the live tier, not the frozen tier, decides)', () => {
    ps.forEach((p, i) => { if (auth[i]) expect(p.row(ID)!.ranked!.total).toBeGreaterThanOrEqual(85); });
  });
  it('[DEFECT D1] no authorization after the alert was observed chased beyond 0.25 ATR', () => {
    const chasedAt = ps.findIndex((p) => p.row(ID)?.lifecycle.executionState === 'CHASED');
    if (chasedAt < 0) return; // never chased in this window — nothing to assert
    expect(ps.slice(chasedAt).filter((p) => queueAuthorizes(p.row(ID))).map((p) => et(p.now))).toEqual([]);
  });
  it.todo('POLICY A (pending approval): an alert frozen below 85 is never authorized later without a new TrendSpider alert');
  it.todo('POLICY C (pending approval): a later upgrade requires the explicitly approved upgrade conditions');
});

describe('S1 · C · tier boundaries (thresholds unchanged)', () => {
  it('RB v1.1 grades 90 / 85 / 80 / 75', () => {
    expect([74, 75, 79, 80, 84, 85, 89, 90].map((s) => classifyScore(s, RK))).toEqual(['SKIP', 'LOW_PRIORITY', 'LOW_PRIORITY', 'WATCHLIST', 'WATCHLIST', 'HIGH_PRIORITY', 'HIGH_PRIORITY', 'ELITE']);
  });
  it('RB v1.2 shadow Option B grades 82 / 78 / 73 / 69 (max 91)', () => {
    expect(V12_SHADOW_GRADES).toEqual({ elite: 82, high: 78, watchlist: 73, low: 69 });
    expect([77, 78, 81, 82].map((s) => classifyScore(s, { ...RK, grades: { ...V12_SHADOW_GRADES } }))).toEqual(['WATCHLIST', 'HIGH_PRIORITY', 'HIGH_PRIORITY', 'ELITE']);
  });
});
