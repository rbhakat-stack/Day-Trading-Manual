/**
 * v1.1 stabilization — DUPLICATE / EXISTING CANDIDATE (2026-11-05 incident: repeated 5-minute SHORT alerts on AMD, CAT,
 * FCX, GS, NVDA, TSLA all NOT ELIGIBLE with blank score and order details).
 *
 * Root cause: the block was measured against the CURRENT clock, so a blocked alert became a late candidate ~5 minutes
 * later, which then blocked the next alert (cascade); a blocked alert got no calculation at all (blank row, blank
 * alert-time snapshot). The safety rule itself (one live candidate / position per ticker, never pyramid) is unchanged.
 *
 * Synthetic records (clearly not market observations) unless a test names a historical fixture.
 */
import { describe, expect, it } from 'vitest';
import type { AutoAlertRecord } from '../../engine/automation/alertDecision';
import type { Candidate } from '../../engine/ranker/opportunityTypes';
import { recordWith } from '../../engine/automation/__tests__/fixtures';
import { fixtureSteps, loadFixture, queueAuthorizes, rankerAuthorizes, runApp, synthQuote, type Pass, type State, type Step } from './harness';
import { T0, withV12 } from './synthetic';

const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const atMin = (min: number) => T0 + min * 60_000;
const SHORT_VALUES = { open: 101, high: 101, low: 100, close: 100, atr: 1, ema9: 100.3, ema20: 100.9, rsi: 33, rvol: 4, vwap: 100.7, close15m: 100, ema20_15m: 101 };
/** LONG AAA alert `min` minutes after T0 (entry 101.02, stop 100.00); SHORT uses the mirrored geometry. */
const L = (min: number, o: Partial<Parameters<typeof recordWith>[0]> = {}): AutoAlertRecord => withV12(recordWith({ symbol: 'AAA', direction: 'LONG', alertIso: iso(min), price: 100.95, values: {}, ...o }));
const S = (min: number, o: Partial<Parameters<typeof recordWith>[0]> = {}): AutoAlertRecord => withV12(recordWith({ symbol: 'AAA', direction: 'SHORT', alertIso: iso(min), price: 100.05, values: SHORT_VALUES, ...o }));
/** A quote every 30 s from `from` to `to` minutes at `price` (fresh, as the app's polling would see it). */
const poll = (from: number, to: number, price: number | ((m: number) => number)): Step[] => {
  const out: Step[] = [];
  for (let m = from; m <= to + 1e-9; m += 0.5) { const now = atMin(m); out.push({ now, quotes: { AAA: synthQuote(typeof price === 'number' ? price : price(m), now) } }); }
  return out;
};
const firstRelease = (ps: Pass[], id: string) => ps.find((p) => p.row(id) && p.row(id)!.decision.decision !== 'SCORING');
const neverAuthorized = (ps: Pass[], id: string) => ps.filter((p) => queueAuthorizes(p.row(id)) || rankerAuthorizes(p.ranked(id))).map((p) => p.now);
const onePerTicker = (ps: Pass[], ids: string[]) => ps.every((p) => ids.filter((id) => queueAuthorizes(p.row(id))).length <= 1 && ids.filter((id) => rankerAuthorizes(p.ranked(id))).length <= 1);

describe('Stabilization · first alert and a second distinct alert of the same ticker', () => {
  const a = L(0), b = L(5);
  const ps = runApp([a, b], poll(0.1, 20, 100.95));

  it('the first alert per symbol is evaluated normally (candidate, score, plan; no block)', () => {
    const r = firstRelease(ps, a.id)!.row(a.id)!;
    expect(r.blocked ?? null).toBeNull();
    expect(r.candidate).not.toBeNull();
    expect(r.ranked?.total).toEqual(expect.any(Number));
  });
  it('the second alert while the first is NEW is NOT ELIGIBLE — DUPLICATE, with a precise reason naming the blocker and its expiry', () => {
    const r = firstRelease(ps, b.id)!.row(b.id)!;
    expect([r.decision.decision, r.decision.detail, r.decision.ticket]).toEqual(['NOT ELIGIBLE', 'DUPLICATE / EXISTING CANDIDATE', null]);
    expect(r.blocked?.block).toMatchObject({ id: a.id, kind: 'LIVE_CANDIDATE', status: 'NEW', alertMs: a.alert.alertTimeMs, untilMs: a.alert.alertTimeMs + 600_000 });
    expect(r.decision.reasons[0]).toContain(a.id);
    expect(r.decision.reasons[0]).toContain('NOT ACTIONABLE');
    expect(r.decision.reasons[0]).not.toContain('pending order or position'); // the generic text is replaced by the real reason
  });
  it('the blocked alert keeps its own diagnostic plan and score — exactly what the same alert gets when evaluated alone', () => {
    const r = firstRelease(ps, b.id)!.row(b.id)!;
    const alone = runApp([b], poll(5.05, 6, b.initialQuote!.price));
    const ar = alone.find((p) => p.row(b.id)?.candidate && p.row(b.id)?.ranked)!.row(b.id)!; // its first scored pass
    expect(r.blocked?.plan).toEqual({ entry: ar.candidate!.entry, stop: ar.candidate!.stop, target: ar.candidate!.target, shares: ar.candidate!.shares, positionValue: ar.candidate!.positionValue, plannedRisk: ar.candidate!.plannedRisk, expectedReward: ar.candidate!.expectedReward, orderType: ar.candidate!.orderType });
    expect(r.blocked?.score).toBe(ar.ranked!.total);
    expect(r.blocked?.tier).toBe(ar.ranked!.tier);
  });
  it('the diagnostic is frozen into the alert-time snapshot (never blank) and read back unchanged on later passes', () => {
    const snap = ps[ps.length - 1].state.frozen[b.id];
    expect(snap.v11).toMatchObject({ decision: 'NOT ELIGIBLE', detail: 'DUPLICATE / EXISTING CANDIDATE', diagnostic: true });
    expect(snap.v11.total).toEqual(expect.any(Number));
    expect(snap.trade?.orderType).toBe('BUY STOP');
    expect(snap.blocked?.block.id).toBe(a.id);
    const later = ps.filter((p) => p.row(b.id)?.blocked?.source === 'FROZEN');
    expect(later.length).toBeGreaterThan(5);
    for (const p of later) expect([p.row(b.id)!.blocked!.score, p.row(b.id)!.blocked!.plan]).toEqual([snap.blocked!.score, snap.blocked!.plan]);
  });
  it('a blocked alert is never turned into a late candidate and is never authorized, even after the blocker expires', () => {
    expect(ps.some((p) => p.state.candidates.some((c) => c.id === b.id))).toBe(false);
    expect(neverAuthorized(ps, b.id)).toEqual([]);
    expect(ps[ps.length - 1].row(b.id)!.lifecycle.finalActionability).not.toBe('READY');
  });
  it('no pyramiding: never two authorizations for the ticker at the same instant', () => expect(onePerTicker(ps, [a.id, b.id])).toBe(true));
});

describe('Stabilization · an unexecuted candidate cannot block the ticker indefinitely (no cascade)', () => {
  // the 2026-11-05 pattern: TrendSpider fires every 5 minutes on the same ticker
  const rs = [L(0), L(5), L(10.5), L(15.5)];
  const ps = runApp(rs, poll(0.1, 30, 100.95));
  it('the alert at +5 is blocked by +0; the alert at +10.5 (blocker more than 10 min older) is evaluated on its own', () => {
    expect(firstRelease(ps, rs[1].id)!.row(rs[1].id)!.blocked?.block.id).toBe(rs[0].id);
    const r = firstRelease(ps, rs[2].id)!.row(rs[2].id)!;
    expect(r.blocked ?? null).toBeNull();
    expect(r.candidate).not.toBeNull();
  });
  it('the alert at +15.5 is blocked only by the evaluated +10.5 candidate, never by the blocked +5 alert', () => {
    expect(firstRelease(ps, rs[3].id)!.row(rs[3].id)!.blocked?.block.id).toBe(rs[2].id);
  });
  it('blocked alerts never become candidates; one authorization per ticker at most', () => {
    const ids = new Set(ps[ps.length - 1].state.candidates.map((c) => c.id));
    expect([ids.has(rs[0].id), ids.has(rs[1].id), ids.has(rs[2].id), ids.has(rs[3].id)]).toEqual([true, false, true, false]);
    expect(onePerTicker(ps, rs.map((r) => r.id))).toBe(true);
  });
});

describe('Stabilization · reload, late first sight and polling order', () => {
  const a = L(0), b = L(5);
  it('reload (state restored from storage) keeps the alert blocked with the identical frozen diagnostic', () => {
    const pre = runApp([a, b], poll(0.1, 6, 100.95));
    const st = JSON.parse(JSON.stringify(pre[pre.length - 1].state)) as State;
    const post = runApp([a, b], poll(6.5, 25, 100.95), { start: st });
    for (const p of post) expect(p.row(b.id)?.blocked?.score).toBe(st.frozen[b.id].blocked!.score);
    expect(post.some((p) => p.state.candidates.some((c) => c.id === b.id))).toBe(false);
    expect(neverAuthorized(post, b.id)).toEqual([]);
  });
  it('a snapshot recorded by the previous version (DUPLICATE, no diagnostic field) stays blocked — never revived after the update', () => {
    const pre = runApp([a, b], poll(0.1, 6, 100.95));
    const st = JSON.parse(JSON.stringify(pre[pre.length - 1].state)) as State;
    const legacy = { ...st.frozen[b.id] } as Record<string, unknown>;
    delete legacy.blocked;
    st.frozen[b.id] = legacy as never;
    st.candidates = st.candidates.map((c) => (c.id === a.id ? { ...c, status: 'SKIPPED' as const } : c)); // the original blocker is gone
    const post = runApp([a, b], poll(6.5, 12, 100.95), { start: st });
    for (const p of post) expect(p.row(b.id)?.decision.detail).toBe('DUPLICATE / EXISTING CANDIDATE');
    expect(post.some((p) => p.state.candidates.some((c) => c.id === b.id))).toBe(false);
  });
  it('the app first seeing both alerts 20 minutes later reaches the same block (decided as of the alert time, not the clock)', () => {
    const late = runApp([a, b], poll(20, 21, 100.95));
    expect(late[0].row(b.id)?.blocked?.block.id).toBe(a.id);
    expect(late[late.length - 1].state.candidates.some((c) => c.id === b.id)).toBe(false);
  });
  it('the same alert delivered twice is one record and one candidate, and never blocks itself', () => {
    const ps = runApp([a, a], poll(0.1, 3, 100.95));
    const last = ps[ps.length - 1];
    expect(last.state.candidates.filter((c) => c.id === a.id)).toHaveLength(1);
    expect(last.row(a.id)?.blocked ?? null).toBeNull();
  });
});

describe('Stabilization · pending orders, positions and direction changes (no pyramiding)', () => {
  const setStatus = (id: string, status: Candidate['status'], fromMin: number) => (now: number, cs: Candidate[]) => (now >= atMin(fromMin) ? cs.map((c) => (c.id === id ? { ...c, status } : c)) : cs);
  it('a PENDING order blocks any later alert of the ticker, LONG or SHORT, with the pending-order reason', () => {
    const a = L(0), b = L(15), c = S(16);
    const ps = runApp([a, b, c], poll(0.1, 18, 100.95), { before: setStatus(a.id, 'PENDING', 1) });
    for (const x of [b, c]) {
      const r = firstRelease(ps, x.id)!.row(x.id)!;
      expect(r.blocked?.block).toMatchObject({ id: a.id, kind: 'PENDING_ORDER', untilMs: null });
      expect(r.decision.reasons[0]).toContain('pending order');
    }
  });
  it('a FILLED position blocks any later alert of the ticker with the open-position reason (never reverse, never add)', () => {
    const a = L(0), b = S(30);
    const ps = runApp([a, b], poll(0.1, 31, 100.95), { before: setStatus(a.id, 'FILLED', 1) });
    const r = firstRelease(ps, b.id)!.row(b.id)!;
    expect(r.blocked?.block).toMatchObject({ id: a.id, kind: 'OPEN_POSITION' });
    expect(r.decision.reasons[0]).toContain('open position');
  });
  it('LONG→SHORT within 10 minutes of an unsubmitted LONG is blocked (ticker-level rule unchanged); after 10 minutes it is evaluated', () => {
    const a = L(0), b = S(5), c = S(11);
    const ps = runApp([a, b, c], poll(0.1, 13, 100.5));
    expect(firstRelease(ps, b.id)!.row(b.id)!.blocked?.block.id).toBe(a.id);
    expect(firstRelease(ps, c.id)!.row(c.id)!.blocked ?? null).toBeNull();
  });
  it('SHORT→LONG mirrors it', () => {
    const a = S(0), b = L(5);
    const ps = runApp([a, b], poll(0.1, 6, 100.5));
    expect(firstRelease(ps, b.id)!.row(b.id)!.blocked?.block.id).toBe(a.id);
  });
  it('an expired, skipped or canceled earlier candidate never blocks', () => {
    for (const status of ['SKIPPED', 'CANCELED', 'EXPIRED'] as const) {
      const a = L(0), b = L(5);
      const ps = runApp([a, b], poll(0.1, 6, 100.95), { before: setStatus(a.id, status, 2) });
      expect(firstRelease(ps, b.id)!.row(b.id)!.blocked ?? null).toBeNull();
    }
  });
});

describe('Stabilization · S2a and broker-verification safeguards are preserved', () => {
  it('an earlier alert that CHASED stays terminal; the later blocked alert is never authorized', () => {
    const a = L(0), b = L(5);
    const ps = runApp([a, b], poll(0.1, 9, (m) => (m < 1 ? 100.95 : 101.6)), { observe: true });
    const last = ps[ps.length - 1];
    expect(last.row(a.id)!.lifecycle.terminal).toBe(true);
    expect(firstRelease(ps, b.id)!.row(b.id)!.blocked?.block.id).toBe(a.id);
    expect([...neverAuthorized(ps.filter((p) => p.now >= atMin(1)), a.id), ...neverAuthorized(ps, b.id)]).toEqual([]);
  });
  it('missing broker verification still withholds every ticket; blocked alerts stay blocked and unauthorized', () => {
    const a = L(0), b = L(5);
    const ps = runApp([a, b], poll(0.1, 7, 100.95), { portfolioGate: 'Broker data unavailable' });
    expect(neverAuthorized(ps, a.id)).toEqual([]);
    expect(neverAuthorized(ps, b.id)).toEqual([]);
    expect(firstRelease(ps, b.id)!.row(b.id)!.blocked?.block.id).toBe(a.id);
  });
});

describe('Stabilization · 2026-11-04 NCLH historical fixture (repeated alerts)', { timeout: 120_000 }, () => {
  const fx = loadFixture('nclh-1145');
  const ps = runApp(fx.records, fixtureSteps(fx).filter((_s, i) => i % 4 === 0), { observe: true });
  const nclh = fx.records.filter((r) => r.alert.symbol === 'NCLH');
  it('every NCLH alert blocked as duplicate keeps a frozen diagnostic plan and score; none becomes a late candidate', () => {
    const last = ps[ps.length - 1];
    const blockedIds = nclh.filter((r) => ps.some((p) => p.row(r.id)?.decision.detail === 'DUPLICATE / EXISTING CANDIDATE')).map((r) => r.id);
    expect(blockedIds.length).toBeGreaterThan(0);
    for (const id of blockedIds) {
      expect(last.state.frozen[id].blocked?.plan?.orderType).toBe('BUY STOP');
      expect(last.state.frozen[id].v11.total).toEqual(expect.any(Number));
      expect(last.state.candidates.some((c) => c.id === id)).toBe(false);
    }
  });
  it('never two NCLH authorizations at the same instant', () => expect(onePerTicker(ps, nclh.map((r) => r.id))).toBe(true));
});
