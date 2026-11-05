/**
 * v1.1 stabilization — duplicate handling, ticker reservation (D4) and confirmed missed trigger (D).
 *
 * 2026-11-05 incident: repeated 5-minute SHORT alerts on AMD, CAT, FCX, GS, NVDA, TSLA all NOT ELIGIBLE (DUPLICATE) with
 * blank score and order details. Step 1 (26a0731) decided the block as of the alert time and gave blocked alerts a
 * frozen diagnostic. Step 2 (approved D4): a NEW / WATCHLIST candidate no longer reserves the ticker at all — every
 * distinct alert is evaluated on its own; only a submitted order or an open position blocks a new alert; at most one
 * alert per ticker is actionable (the incumbent authorized alert keeps it, any direction); missing broker verification
 * still withholds every ticket. (Approved D): a confirmed crossing of the entry trigger before submission is terminal.
 *
 * Synthetic records (clearly not market observations) unless a test names a historical fixture.
 * LONG AAA: entry 101.02, stop 100.00, ATR 1 (chase limit 101.27). SHORT AAA: entry 99.98.
 */
import { describe, expect, it } from 'vitest';
import { buildQueue } from '../../engine/automation/liveQueue';
import { DEFAULT_AUTOMATION, type AutoAlertRecord } from '../../engine/automation/alertDecision';
import { applyTickerReservations } from '../../engine/automation/lifecycle/tickerReservation';
import { authorizedKey, triggerKey } from '../../engine/automation/lifecycle/terminalEvents';
import type { BrokerWorkingEntry } from '../../engine/automation/lifecycle/portfolioExposure';
import type { Candidate, ManualPosition } from '../../engine/ranker/opportunityTypes';
import { RB_V1_DEFAULTS } from '../../engine/settings';
import { recordWith } from '../../engine/automation/__tests__/fixtures';
import { classify, fixtureSteps, loadFixture, queueAuthorizes, RK, rankerAuthorizes, runApp, synthQuote, type Pass, type State, type Step } from './harness';
import { T0, withV12 } from './synthetic';

const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const atMin = (min: number) => T0 + min * 60_000;
const SHORT_VALUES = { open: 101, high: 101, low: 100, close: 100, atr: 1, ema9: 100.3, ema20: 100.9, rsi: 33, rvol: 4, vwap: 100.7, close15m: 100, ema20_15m: 101 };
/** LONG AAA alert `min` minutes after T0 (entry 101.02, stop 100.00); SHORT uses the mirrored geometry (entry 99.98). */
const L = (min: number, o: Partial<Parameters<typeof recordWith>[0]> = {}): AutoAlertRecord => withV12(recordWith({ symbol: 'AAA', direction: 'LONG', alertIso: iso(min), price: 100.95, values: {}, ...o }));
const S = (min: number, o: Partial<Parameters<typeof recordWith>[0]> = {}): AutoAlertRecord => withV12(recordWith({ symbol: 'AAA', direction: 'SHORT', alertIso: iso(min), price: 100.05, values: SHORT_VALUES, ...o }));
/** A quote every 30 s from `from` to `to` minutes at `price` (fresh, as the app's polling would see it). */
const poll = (from: number, to: number, price: number | ((m: number) => number), opt: { ageMs?: number; tradeAgeMs?: number } = {}): Step[] => {
  const out: Step[] = [];
  for (let m = from; m <= to + 1e-9; m += 0.5) { const now = atMin(m); out.push({ now, quotes: { AAA: synthQuote(typeof price === 'number' ? price : price(m), now, opt.ageMs, opt.tradeAgeMs) } }); }
  return out;
};
const firstRelease = (ps: Pass[], id: string) => ps.find((p) => p.row(id) && p.row(id)!.decision.decision !== 'SCORING');
const authorizedAt = (ps: Pass[], id: string) => ps.filter((p) => queueAuthorizes(p.row(id)) || rankerAuthorizes(p.ranked(id))).map((p) => p.now);
/** Never two actionable alerts of the ticker at the same instant, on either surface (queue = execution authority). */
const onePerTicker = (ps: Pass[], ids: string[]) => ps.every((p) => ids.filter((id) => queueAuthorizes(p.row(id))).length <= 1 && ids.filter((id) => rankerAuthorizes(p.ranked(id))).length <= 1);
const inOwnWindow = (ps: Pass[], r: AutoAlertRecord) => authorizedAt(ps, r.id).every((t) => t >= r.alert.alertTimeMs && t < r.alert.alertTimeMs + RB_V1_DEFAULTS.alertWindowMinutes * 60_000);
const setStatus = (id: string, status: Candidate['status'], fromMin: number) => (now: number, cs: Candidate[]) => (now >= atMin(fromMin) ? cs.map((c) => (c.id === id ? { ...c, status } : c)) : cs);

describe('D4 · every distinct alert of a ticker is evaluated on its own (no reservation by mere existence)', () => {
  const a = L(0), b = L(5);
  const ps = runApp([a, b], poll(0.1, 20, 100.95));

  it('the second alert while the first is NEW is NOT a duplicate: own candidate, own score, own plan', () => {
    const r = firstRelease(ps, b.id)!.row(b.id)!;
    expect(r.decision.detail).not.toBe('DUPLICATE / EXISTING CANDIDATE');
    expect(r.blocked ?? null).toBeNull();
    expect(r.candidate?.id).toBe(b.id);
    expect(r.ranked?.total).toEqual(expect.any(Number));
  });
  it('while the incumbent holds the ticker, the later alert is never actionable (its own evaluation stays visible)', () => {
    expect(authorizedAt(ps.filter((p) => p.now < a.alert.alertTimeMs + 600_000), b.id)).toEqual([]);
    expect(authorizedAt(ps.filter((p) => p.now >= atMin(5) && p.now < atMin(10)), a.id).length).toBeGreaterThan(0); // incumbent keeps it
  });
  it('a later HIGHER-scoring alert never displaces the incumbent: the incumbent stays READY; the challenger is HELD (ticket withheld, reason names the holder)', () => {
    const inc = L(0, { values: { rvol: 2.5 } }), ch = L(5); // 93 vs 96 at 100.95
    const qs = runApp([inc, ch], poll(0.1, 9, 100.95));
    const p = firstRelease(qs, ch.id)!;
    expect(p.row(ch.id)!.ranked!.total).toBeGreaterThan(p.row(inc.id)!.ranked!.total!);
    expect(queueAuthorizes(p.row(inc.id))).toBe(true);
    const r = p.row(ch.id)!;
    expect(r.decision.ticket).not.toBeNull(); // independently qualifies (RB v1.1 decision unchanged) …
    expect(r.lifecycle).toMatchObject({ executionState: 'HELD — TICKER RESERVED', finalActionability: 'NO TICKET', heldBy: { recordId: inc.id } });
    expect(r.lifecycle.reason).toContain(inc.id);
    expect(queueAuthorizes(r)).toBe(false); // … but is not actionable while the incumbent holds the ticker
    expect(rankerAuthorizes(p.ranked(ch.id))).toBe(false);
    for (const x of qs.filter((y) => y.now >= atMin(5))) expect([queueAuthorizes(x.row(inc.id)), queueAuthorizes(x.row(ch.id))]).toEqual([true, false]);
  });
  it('the incumbent records its first authorization once (write-once evidence for deterministic arbitration)', () => {
    const ev = ps[ps.length - 1].state.terminal[authorizedKey(a.id)];
    expect(ev).toMatchObject({ kind: 'AUTHORIZED', recordId: a.id });
    expect(ev.observedAtMs).toBe(authorizedAt(ps, a.id)[0]);
    expect(ps[ps.length - 1].state.terminal[authorizedKey(b.id)]?.observedAtMs ?? Infinity).toBeGreaterThanOrEqual(a.alert.alertTimeMs + 600_000);
  });
  it('takeover: after the incumbent expires (10 min) the later alert, still inside its own window, may be authorized', () => {
    const t = authorizedAt(ps, b.id);
    expect(t.length).toBeGreaterThan(0);
    expect(Math.min(...t)).toBeGreaterThanOrEqual(a.alert.alertTimeMs + 600_000);
    expect(inOwnWindow(ps, b)).toBe(true); // never after its own original window
  });
  it('no pyramiding: never two actionable alerts for the ticker at the same instant', () => expect(onePerTicker(ps, [a.id, b.id])).toBe(true));
});

describe('D4 · the 2026-11-05 pattern (an alert every 5 minutes) — no cascade, no reservation by non-actionable alerts', () => {
  const rs = [L(0), L(5), L(10.5), L(15.5)];
  const ps = runApp(rs, poll(0.1, 30, 100.95));
  it('every alert is evaluated (a candidate each; none DUPLICATE)', () => {
    const ids = new Set(ps[ps.length - 1].state.candidates.map((c) => c.id));
    expect(rs.map((r) => ids.has(r.id))).toEqual([true, true, true, true]);
    expect(rs.filter((r) => ps.some((p) => p.row(r.id)?.decision.detail === 'DUPLICATE / EXISTING CANDIDATE'))).toEqual([]);
  });
  it('one actionable alert per ticker at every instant; each authorized only inside its own window', () => {
    expect(onePerTicker(ps, rs.map((r) => r.id))).toBe(true);
    for (const r of rs) expect(inOwnWindow(ps, r)).toBe(true);
  });
  it('the reservation passes in alert order (incumbent first, then the earliest still-valid alert)', () => {
    const first = rs.map((r) => authorizedAt(ps, r.id)[0] ?? null);
    expect(first[0]).not.toBeNull();
    const seq = first.filter((x): x is number => x !== null);
    expect([...seq].sort((x, y) => x - y)).toEqual(seq);
  });
});

describe('D4 · a non-actionable earlier alert never reserves the ticker', () => {
  it('an earlier DATA REVIEW alert does not hold the ticker: the later valid alert is authorized immediately', () => {
    const a = L(0, { issues: [{ kind: 'REVIEW', code: 'ALERT_NOT_REPRODUCED', message: 'not reproduced' }] }), b = L(3);
    const ps = runApp([a, b], poll(0.1, 5, 100.95));
    expect(authorizedAt(ps, a.id)).toEqual([]);
    const r = firstRelease(ps, b.id)!.row(b.id)!;
    expect(r.lifecycle.heldBy ?? null).toBeNull();
    expect(queueAuthorizes(r)).toBe(true);
  });
  it('an earlier below-threshold alert (82 < 85) does not hold the ticker', () => {
    const a = L(0, { values: { rvol: 2.5 }, price: 100.2 }), b = L(3);
    const ps = runApp([a, b], poll(0.1, 5, (m) => (m < 3 ? 100.2 : 100.95)));
    expect(firstRelease(ps, a.id)!.row(a.id)!.ranked!.total).toBeLessThan(85);
    expect(authorizedAt(ps.filter((p) => p.now < atMin(3)), a.id)).toEqual([]);
    expect(onePerTicker(ps, [a.id, b.id])).toBe(true);
    // b is authorized at first release only if a never was; a (now ≥ 85 at 100.95) may hold it instead — never both
    const fr = firstRelease(ps, b.id)!;
    expect(queueAuthorizes(fr.row(b.id)) || queueAuthorizes(fr.row(a.id))).toBe(true);
  });
  it('a user-skipped or canceled incumbent releases the ticker; the later valid alert takes over inside its window', () => {
    for (const status of ['SKIPPED', 'CANCELED'] as const) {
      const a = L(0), b = L(3);
      const ps = runApp([a, b], poll(0.1, 8, 100.95), { before: setStatus(a.id, status, 4) });
      expect(authorizedAt(ps.filter((p) => p.now < atMin(4)), b.id)).toEqual([]);
      expect(authorizedAt(ps.filter((p) => p.now >= atMin(4)), b.id).length).toBeGreaterThan(0);
      expect(onePerTicker(ps, [a.id, b.id])).toBe(true);
    }
  });
});

describe('D4 · opposite directions — one reservation per ticker regardless of LONG or SHORT', () => {
  const held = (ps: Pass[], inc: AutoAlertRecord, ch: AutoAlertRecord) => {
    const r = firstRelease(ps, ch.id)!.row(ch.id)!;
    expect(r.decision.detail).not.toBe('DUPLICATE / EXISTING CANDIDATE');
    expect(r.candidate?.direction).toBe(ch.alert.direction);
    expect(authorizedAt(ps.filter((p) => p.now < inc.alert.alertTimeMs + 600_000), ch.id)).toEqual([]);
    expect(ps.some((p) => p.row(ch.id)?.lifecycle.heldBy?.recordId === inc.id)).toBe(true);
    expect(onePerTicker(ps, [inc.id, ch.id])).toBe(true);
  };
  it('LONG incumbent, higher-scoring SHORT challenger: the SHORT is evaluated (not DUPLICATE) and HELD, never simultaneously actionable', () => {
    const a = L(0, { values: { rvol: 2.5 } }), b = S(3);
    held(runApp([a, b], poll(0.1, 9, 100.5)), a, b);
  });
  it('SHORT incumbent, higher-scoring LONG challenger mirrors it', () => {
    const a = S(0, { values: { ...SHORT_VALUES, rvol: 2.5 } }), b = L(3);
    held(runApp([a, b], poll(0.1, 9, 100.5)), a, b);
  });
});

describe('D4 · arbitration is sticky and deterministic (pure function over the rows and the write-once evidence)', () => {
  const a = L(0), b = L(3);
  const ps = runApp([a, b], poll(0.1, 4, 100.95));
  const p = ps[ps.length - 1];
  const ticket = p.row(a.id)!.decision.ticket;
  // both rows as the Queue would offer them (independently qualifying), before arbitration
  const rowsUnheld = () => p.rows.map((r) => ({ ...r, decision: { ...r.decision, ticket: r.decision.ticket ?? ticket }, lifecycle: { ...r.lifecycle, heldBy: null, executionState: 'ACTIVE' as const, finalActionability: 'READY' as const } }));
  it('an incumbent that is not READY on this pass (score / price flicker) still holds the ticker; the challenger stays HELD', () => {
    const rows = rowsUnheld().map((r) => (r.record.id === a.id ? { ...r, lifecycle: { ...r.lifecycle, finalActionability: 'NO TICKET' as const } } : r));
    const out = applyTickerReservations(rows, p.state.terminal, p.now);
    expect(out.find((r) => r.record.id === b.id)!.lifecycle.heldBy?.recordId).toBe(a.id);
  });
  it('a latched terminal event of the incumbent (missed trigger) releases the reservation', () => {
    const ev = { ...p.state.terminal, [triggerKey(a.id)]: { ...p.state.terminal[authorizedKey(a.id)], kind: 'TRIGGER_CROSSED' as const } };
    // the incumbent's own lifecycle is then MISSED (not offered); the challenger qualifies independently
    const rows = rowsUnheld().map((r) => (r.record.id === a.id ? { ...r, lifecycle: { ...r.lifecycle, executionState: 'MISSED — TRIGGER CROSSED' as const, finalActionability: 'NO TRADE' as const } } : r));
    const out = applyTickerReservations(rows, ev, p.now);
    expect(out.find((r) => r.record.id === b.id)!.lifecycle.heldBy ?? null).toBeNull();
  });
  it('without any recorded authorization, simultaneous qualifiers are ordered by alert time, then arrival, then id', () => {
    const out = applyTickerReservations(rowsUnheld(), {}, p.now);
    expect(out.find((r) => r.record.id === a.id)!.lifecycle.heldBy ?? null).toBeNull();
    expect(out.find((r) => r.record.id === b.id)!.lifecycle.heldBy?.recordId).toBe(a.id);
  });
  it('reload: the same rows and stored evidence give the same holder (state restored from storage)', () => {
    const st = JSON.parse(JSON.stringify(p.state)) as State;
    const post = runApp([a, b], poll(4.5, 7, 100.95), { start: st });
    for (const x of post) {
      expect([queueAuthorizes(x.row(a.id)), queueAuthorizes(x.row(b.id))]).toEqual([true, false]);
      if (x.row(b.id)!.decision.ticket) expect(x.row(b.id)!.lifecycle.heldBy?.recordId).toBe(a.id);
    }
    expect(post[post.length - 1].state.terminal[authorizedKey(a.id)]).toEqual(st.terminal[authorizedKey(a.id)]);
  });
});

describe('Pending orders, positions and broker verification (no pyramiding; fail closed)', () => {
  it('a PENDING order blocks any later alert of the ticker, LONG or SHORT, with the pending-order reason and a frozen diagnostic', () => {
    const a = L(0), b = L(15), c = S(16);
    const ps = runApp([a, b, c], poll(0.1, 18, 100.95), { before: setStatus(a.id, 'PENDING', 1) });
    for (const x of [b, c]) {
      const r = firstRelease(ps, x.id)!.row(x.id)!;
      expect(r.blocked?.block).toMatchObject({ id: a.id, kind: 'PENDING_ORDER', untilMs: null });
      expect(r.decision.reasons[0]).toContain('pending order');
      expect(r.blocked?.plan?.orderType).toEqual(expect.any(String));
      expect(r.blocked?.score).toEqual(expect.any(Number));
      expect(authorizedAt(ps, x.id)).toEqual([]);
    }
  });
  it('an already-evaluated alert is never authorized once another alert of the ticker is PENDING (either direction)', () => {
    const a = L(0), b = S(2);
    const ps = runApp([a, b], poll(0.1, 9, 100.5), { before: setStatus(a.id, 'PENDING', 3) });
    expect(authorizedAt(ps.filter((p) => p.now >= atMin(3)), b.id)).toEqual([]);
    expect(authorizedAt(ps.filter((p) => p.now >= atMin(3)), a.id)).toEqual([]);
  });
  it('a FILLED position blocks any later alert of the ticker with the open-position reason (never reverse, never add)', () => {
    const a = L(0), b = S(30);
    const ps = runApp([a, b], poll(0.1, 31, 100.95), { before: setStatus(a.id, 'FILLED', 1) });
    const r = firstRelease(ps, b.id)!.row(b.id)!;
    expect(r.blocked?.block).toMatchObject({ id: a.id, kind: 'OPEN_POSITION' });
    expect(r.decision.reasons[0]).toContain('open position');
  });
  it('an open manual / broker position in the ticker blocks a new alert of either direction', () => {
    const pos = { id: 'pos-AAA', ticker: 'AAA', direction: 'LONG', sector: 'Sector-AAA', industry: 'Industry-AAA', theme: '', positionValue: 10000, plannedRisk: 50, entry: 100, stop: 99, target: 102, status: 'OPEN' } as ManualPosition;
    for (const x of [L(0), S(0)]) {
      const ps = runApp([x], poll(0.1, 3, 100.5), { positions: [pos] });
      expect(authorizedAt(ps, x.id)).toEqual([]);
    }
  });
  it('a verified broker working entry order in the ticker (not marked in RB) blocks a new alert of either direction', () => {
    const entry: BrokerWorkingEntry = { key: 'AAA|LONG', ticker: 'AAA', direction: 'LONG', orderIds: ['o-1'], qty: 10, notional: 1010, plannedRisk: 10, riskBasis: 'BRACKET_STOP', flags: [], submittedAt: atMin(0) } as BrokerWorkingEntry;
    for (const x of [L(0), S(0)]) {
      let candidates: Candidate[] = [];
      for (const m of [0.2, 0.7, 1.2]) {
        const q = buildQueue({ records: [x], candidates, positions: [], quotes: { AAA: synthQuote(100.5, atMin(m)) }, now: atMin(m), cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: RK, classify, parity: {}, strategyVersion: 'RB v1.1', frozen: {}, terminal: {}, knownBrokerEntries: [entry] });
        candidates = q.candidates;
        expect(queueAuthorizes(q.rows.find((r) => r.record.id === x.id))).toBe(false);
      }
    }
  });
  it('missing / stale broker verification withholds every ticket and records no reservation', () => {
    const a = L(0), b = L(3);
    const ps = runApp([a, b], poll(0.1, 7, 100.95), { portfolioGate: 'Broker data unavailable' });
    expect([...authorizedAt(ps, a.id), ...authorizedAt(ps, b.id)]).toEqual([]);
    expect(ps[ps.length - 1].state.terminal[authorizedKey(a.id)]).toBeUndefined();
  });
});

describe('Blocks frozen at alert time are never revived (reload / earlier builds)', () => {
  const a = L(0), b = L(5);
  const pendingFirst = () => runApp([a, b], poll(0.1, 6, 100.95), { before: setStatus(a.id, 'PENDING', 1) });
  it('reload keeps a PENDING-blocked alert blocked with the identical frozen diagnostic', () => {
    const pre = pendingFirst();
    const st = JSON.parse(JSON.stringify(pre[pre.length - 1].state)) as State;
    const post = runApp([a, b], poll(6.5, 25, 100.95), { start: st });
    for (const p of post) expect(p.row(b.id)?.blocked?.score).toBe(st.frozen[b.id].blocked!.score);
    expect(post.some((p) => p.state.candidates.some((c) => c.id === b.id))).toBe(false);
    expect(authorizedAt(post, b.id)).toEqual([]);
  });
  it('a snapshot recorded by an earlier build (DUPLICATE, no diagnostic field) stays blocked after the blocker is gone', () => {
    const pre = pendingFirst();
    const st = JSON.parse(JSON.stringify(pre[pre.length - 1].state)) as State;
    const legacy = { ...st.frozen[b.id] } as Record<string, unknown>;
    delete legacy.blocked;
    st.frozen[b.id] = legacy as never;
    st.candidates = st.candidates.map((c) => (c.id === a.id ? { ...c, status: 'SKIPPED' as const } : c));
    const post = runApp([a, b], poll(6.5, 12, 100.95), { start: st });
    for (const p of post) expect(p.row(b.id)?.decision.detail).toBe('DUPLICATE / EXISTING CANDIDATE');
    expect(authorizedAt(post, b.id)).toEqual([]);
  });
  it('a block frozen by step 1 (26a0731: LIVE_CANDIDATE) stays blocked — this build never revives it', () => {
    const pre = pendingFirst();
    const st = JSON.parse(JSON.stringify(pre[pre.length - 1].state)) as State;
    st.frozen[b.id] = { ...st.frozen[b.id], blocked: { ...st.frozen[b.id].blocked!, block: { ...st.frozen[b.id].blocked!.block, kind: 'LIVE_CANDIDATE', status: 'NEW' } } };
    st.candidates = st.candidates.map((c) => (c.id === a.id ? { ...c, status: 'NEW' as const } : c));
    const post = runApp([a, b], poll(6.5, 12, 100.95), { start: st });
    for (const p of post) expect(p.row(b.id)?.blocked?.block.kind).toBe('LIVE_CANDIDATE');
    expect(authorizedAt(post, b.id)).toEqual([]);
  });
  it('the same alert delivered twice is one record and one candidate, and never blocks or holds itself', () => {
    const ps = runApp([a, a], poll(0.1, 3, 100.95));
    const last = ps[ps.length - 1];
    expect(last.state.candidates.filter((c) => c.id === a.id)).toHaveLength(1);
    expect(last.row(a.id)?.blocked ?? null).toBeNull();
    expect(last.row(a.id)?.lifecycle.heldBy ?? null).toBeNull();
  });
});

describe('C · score transitions across 85 (existing live eligibility; frozen alert-time score never rewritten)', () => {
  const a = L(0, { values: { rvol: 2.5 }, price: 100.2 });
  const ps = runApp([a], poll(0.1, 12, (m) => (m < 3 ? 100.2 : 100.95)));
  it('frozen initial score below 85 does not reserve and is not READY; the same alert becomes READY when its live score reaches ≥ 85 inside the window', () => {
    expect(ps[ps.length - 1].state.frozen[a.id].v11.total).toBeLessThan(85);
    expect(authorizedAt(ps.filter((p) => p.now < atMin(3)), a.id)).toEqual([]);
    expect(ps[ps.length - 1].state.terminal[authorizedKey(a.id)]?.observedAtMs).toBeGreaterThanOrEqual(atMin(3));
    expect(authorizedAt(ps, a.id).length).toBeGreaterThan(0);
  });
  it('the frozen alert-time score is never overwritten, and there is no authorization after the original window', () => {
    const v = ps.map((p) => p.state.frozen[a.id]?.v11.total).filter((x) => x !== undefined);
    expect(new Set(v).size).toBe(1);
    expect(inOwnWindow(ps, a)).toBe(true);
    expect(ps[ps.length - 1].row(a.id)!.lifecycle.executionState).toBe('EXPIRED — STALE');
  });
});

describe('D · confirmed missed trigger (crossing before any order) is terminal', () => {
  it('LONG: crossing at/through 101.02, then a pullback — never READY again (no revival), reason names the observation', () => {
    const a = L(0);
    const ps = runApp([a], poll(0.1, 9, (m) => (m < 2 ? 100.95 : m < 2.6 ? 101.05 : 100.95)));
    expect(authorizedAt(ps.filter((p) => p.now < atMin(2)), a.id).length).toBeGreaterThan(0);
    expect(ps[ps.length - 1].state.terminal[triggerKey(a.id)]).toMatchObject({ kind: 'TRIGGER_CROSSED', price: 101.05, entry: 101.02 });
    expect(authorizedAt(ps.filter((p) => p.now >= atMin(2)), a.id)).toEqual([]);
    const later = ps.find((p) => p.now >= atMin(3))!.row(a.id)!;
    expect(later.decision.ticket).not.toBeNull(); // the live RB v1.1 decision would offer the stop again …
    expect(later.lifecycle).toMatchObject({ executionState: 'MISSED — TRIGGER CROSSED', finalActionability: 'NO TRADE', terminal: true }); // … withheld
    expect(later.lifecycle.reason).toMatch(/101\.05/);
  });
  it('SHORT mirrors it (crossing at/through 99.98)', () => {
    const a = S(0);
    const ps = runApp([a], poll(0.1, 9, (m) => (m < 2 ? 100.5 : m < 2.6 ? 99.95 : 100.5)));
    expect(ps[ps.length - 1].state.terminal[triggerKey(a.id)]).toMatchObject({ kind: 'TRIGGER_CROSSED', price: 99.95 });
    expect(authorizedAt(ps.filter((p) => p.now >= atMin(2)), a.id)).toEqual([]);
  });
  it('a price exactly at the trigger is a crossing (the stop order would trigger); a price just short of it is not', () => {
    const a = L(0), b = L(0);
    const at = runApp([a], poll(0.1, 3, (m) => (m < 2 ? 100.95 : 101.02)));
    expect(at[at.length - 1].state.terminal[triggerKey(a.id)]).toBeDefined();
    const below = runApp([b], poll(0.1, 3, (m) => (m < 2 ? 100.95 : 101.01)));
    expect(below[below.length - 1].state.terminal[triggerKey(b.id)]).toBeUndefined();
  });
  it('stale data never latches: a crossing print older than the freshness limit is ignored', () => {
    const a = L(0);
    const ps = runApp([a], [...poll(0.1, 1.9, 100.95), ...poll(2, 2.5, 101.05, { tradeAgeMs: 90_000 }), ...poll(3, 3.5, 101.05, { ageMs: 8000 }), ...poll(4, 6, 100.95)]);
    expect(ps[ps.length - 1].state.terminal[triggerKey(a.id)]).toBeUndefined();
    expect(authorizedAt(ps.filter((p) => p.now >= atMin(4)), a.id).length).toBeGreaterThan(0);
  });
  it('a trade from before the alert never latches (no pre-alert evidence)', () => {
    const a = L(0);
    const ps = runApp([a], poll(0.1, 2, 101.05, { tradeAgeMs: 50_000 }).slice(0, 1));
    expect(ps[0].state.terminal[triggerKey(a.id)]).toBeUndefined();
  });
  it('a submitted order (PENDING) is never touched: the crossing is the fill path — SUBMITTED, no terminal relabel', () => {
    const a = L(0);
    const ps = runApp([a], poll(0.1, 5, (m) => (m < 2 ? 100.95 : 101.05)), { before: setStatus(a.id, 'PENDING', 1) });
    expect(ps[ps.length - 1].state.terminal[triggerKey(a.id)]).toBeUndefined();
    expect(ps[ps.length - 1].row(a.id)!.lifecycle.executionState).toBe('SUBMITTED');
  });
  it('reload (state restored from storage) keeps the alert MISSED — terminal permanence', () => {
    const a = L(0);
    const pre = runApp([a], poll(0.1, 3, (m) => (m < 2 ? 100.95 : 101.05)));
    const st = JSON.parse(JSON.stringify(pre[pre.length - 1].state)) as State;
    const post = runApp([a], poll(3.5, 9, 100.95), { start: st });
    for (const p of post) expect(queueAuthorizes(p.row(a.id))).toBe(false);
    expect(post[0].row(a.id)!.lifecycle.executionState).toBe('MISSED — TRIGGER CROSSED');
  });
  it('a missed trigger releases the ticker reservation; a later alert with its own valid setup may compete', () => {
    const a = L(0), b = L(4, { values: { high: 102, close: 102, open: 101, ema9: 101.7, ema20: 101.1, vwap: 101.3, close15m: 102, ema20_15m: 101 }, price: 101.9 });
    const ps = runApp([a, b], poll(0.1, 9, (m) => (m < 2 ? 100.95 : m < 4 ? 101.1 : 101.9)));
    expect(ps[ps.length - 1].state.terminal[triggerKey(a.id)]).toBeDefined();
    expect(authorizedAt(ps.filter((p) => p.now >= atMin(2)), a.id)).toEqual([]);
    expect(ps.some((p) => p.row(b.id)?.lifecycle.heldBy)).toBe(false);
    expect(onePerTicker(ps, [a.id, b.id])).toBe(true);
  });
});

describe('2026-11-04 NCLH historical fixture (repeated alerts, same ticker)', { timeout: 120_000 }, () => {
  const fx = loadFixture('nclh-1145');
  const ps = runApp(fx.records, fixtureSteps(fx).filter((_s, i) => i % 4 === 0), { observe: true });
  const nclh = fx.records.filter((r) => r.alert.symbol === 'NCLH');
  it('no NCLH alert is rejected as DUPLICATE (no NCLH order / position existed); each is evaluated with a score', () => {
    expect(nclh.filter((r) => ps.some((p) => p.row(r.id)?.decision.detail === 'DUPLICATE / EXISTING CANDIDATE'))).toEqual([]);
    const last = ps[ps.length - 1];
    for (const r of nclh) expect(last.state.frozen[r.id]?.v11.decision ?? 'NONE').not.toBe('NOT ELIGIBLE — DUPLICATE');
  });
  it('never two NCLH authorizations at the same instant', () => expect(onePerTicker(ps, nclh.map((r) => r.id))).toBe(true));
});
