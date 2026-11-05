/**
 * D3 (approved) — capital efficiency is frozen at the candidate's first valid scoring evaluation, against the
 * contemporaneous eligible peer pool (competing candidates still inside their own alert window; untrusted-data and
 * terminally latched candidates excluded). The existing formula is unchanged: percentile among ≥ 3 candidates
 * (ROUND(2 + 8p)), else neutral 6. Only this component is frozen; every other component stays live; 85 is unchanged.
 *
 * Synthetic records (clearly not market observations). Same bar geometry on every ticker, shifted by a price offset, so the
 * planned reward per $ deployed (efficiency) is higher for a lower-priced ticker: LOW (≈ 51) > AAA (≈ 101) > HI1 > HI2 > HI3.
 */
import { describe, expect, it } from 'vitest';
import type { AutoAlertRecord } from '../../engine/automation/alertDecision';
import { recordWith } from '../../engine/automation/__tests__/fixtures';
import { triggerKey } from '../../engine/automation/lifecycle/terminalEvents';
import type { Candidate } from '../../engine/ranker/opportunityTypes';
import { comps, fixtureSteps, loadFixture, runApp, synthQuote, type Pass, type State, type Step } from './harness';
import { T0, withV12 } from './synthetic';

const OFF: Record<string, number> = { AAA: 0, LOW: -50, HI1: 100, HI2: 200, HI3: 300 };
const atMin = (m: number) => T0 + m * 60_000;
const vals = (d: number) => ({ open: 100 + d, high: 101 + d, low: 100 + d, close: 101 + d, ema9: 100.7 + d, ema20: 100.1 + d, vwap: 100.3 + d, close15m: 101 + d, ema20_15m: 100 + d });
const rec = (sym: string, min: number, o: Partial<Parameters<typeof recordWith>[0]> = {}): AutoAlertRecord =>
  withV12(recordWith({ symbol: sym, direction: 'LONG', alertIso: new Date(atMin(min)).toISOString(), price: 100.95 + OFF[sym], values: vals(OFF[sym]), ...o }));
/** Fresh quotes every 30 s for every symbol (price = 100.95 + offset, just below each entry) unless overridden. */
const poll = (from: number, to: number, over: (sym: string, m: number) => number | undefined = () => undefined): Step[] => {
  const out: Step[] = [];
  for (let m = from; m <= to + 1e-9; m += 0.5) {
    const now = atMin(m);
    out.push({ now, quotes: Object.fromEntries(Object.keys(OFF).map((s) => [s, synthQuote(over(s, m) ?? 100.95 + OFF[s], now)])) });
  }
  return out;
};
const ce = (p: Pass, id: string) => p.row(id)?.ranked?.components.find((k) => k.key === 'capitalEfficiency');
const fz = (p: Pass, id: string) => p.state.candidates.find((c) => c.id === id)?.frozenCapitalEfficiency;

describe('D3 · frozen at the first valid scoring; unrelated candidates entering or leaving never move it', () => {
  const a = rec('AAA', 0), b = rec('HI1', 1), c = rec('HI2', 1.5), d = rec('HI3', 2);
  const ps = runApp([a, b, c, d], poll(0.1, 16));
  it('AAA scored alone first → neutral 6/10, frozen with provenance (instant, no peers, NEUTRAL)', () => {
    const f = fz(ps[ps.length - 1], a.id)!;
    expect(f).toMatchObject({ base: 6, points: 6, peerCount: 1, peers: [], method: 'NEUTRAL', late: false });
    expect(f.atMs).toBe(ps.find((p) => p.row(a.id)?.ranked?.total != null)!.now);
    expect(f.calc.join(' ')).toMatch(/Only 1 candidate/);
  });
  it('three peers arrive (4 in the pool): AAA keeps 6/10 and its total does not move — FROZEN noted in the calculation', () => {
    const later = ps.filter((p) => p.now >= atMin(2.5) && p.now < atMin(10));
    for (const p of later) expect(ce(p, a.id)!.points).toBe(6);
    expect(new Set(later.map((p) => p.row(a.id)!.ranked!.total)).size).toBe(1);
    expect(ce(later[0], a.id)!.calc.join(' ')).toMatch(/FROZEN at the first valid scoring/);
  });
  it('the 4th candidate (HI3) is first scored against the contemporaneous pool of 4 → percentile (lowest efficiency → 2/10)', () => {
    const f = fz(ps[ps.length - 1], d.id)!;
    expect(f).toMatchObject({ method: 'PERCENTILE', peerCount: 4, base: 2 });
    expect([...f.peers].sort()).toEqual([a.id, b.id, c.id].sort());
  });
  it('peers leaving the pool (their windows expire) do not change a frozen component', () => {
    const last = ps.filter((p) => p.now >= atMin(10.5) && p.now < atMin(12));
    expect(last.length).toBeGreaterThan(0);
    for (const p of last) expect(ce(p, d.id)!.points).toBe(2);
  });
  it('the Ranker surface reads the same frozen component: equal totals on both surfaces at every instant', () => {
    for (const p of ps) for (const id of [a.id, b.id, c.id, d.id]) {
      const q = p.row(id)?.ranked, r = p.ranked(id);
      if (q?.total != null && r?.total != null && p.state.candidates.find((x) => x.id === id)?.frozenCapitalEfficiency) expect([id, comps(r).capitalEfficiency]).toEqual([id, comps(q).capitalEfficiency]);
    }
  });
  it('reload (state restored from storage): identical frozen component and identical totals', () => {
    const mid = ps.findIndex((p) => p.now >= atMin(4));
    const st = JSON.parse(JSON.stringify(ps[mid].state)) as State;
    const post = runApp([a, b, c, d], poll(ps[mid + 1].now / 60_000 - T0 / 60_000, 8.1), { start: st }); // same time grid
    const sec = (ms: number) => Math.round(ms / 1000);
    const ref = new Map(ps.map((p) => [sec(p.now), p]));
    for (const id of [a.id, b.id, c.id, d.id]) {
      expect(fz(post[post.length - 1], id)).toEqual(fz(ps[mid], id));
      for (const p of post) expect([sec(p.now), p.row(id)!.ranked?.total]).toEqual([sec(p.now), ref.get(sec(p.now))!.row(id)!.ranked?.total]);
    }
  });
});

describe('D3 · the peer pool excludes expired, untrusted-data and terminal candidates', () => {
  it('a candidate older than its own 10-minute window is not a peer', () => {
    const old = rec('HI1', 0), x = rec('HI2', 11), y = rec('HI3', 11.2), z = rec('LOW', 11.4);
    const ps = runApp([old, x, y, z], poll(0.1, 12.5));
    for (const id of [x.id, y.id, z.id]) expect(fz(ps[ps.length - 1], id)!.peers).not.toContain(old.id);
  });
  it('a DATA REVIEW candidate is not a peer', () => {
    const bad = rec('HI1', 0, { issues: [{ kind: 'REVIEW', code: 'ALERT_NOT_REPRODUCED', message: 'not reproduced' }] }), x = rec('HI2', 0.3), y = rec('HI3', 0.6);
    const ps = runApp([bad, x, y], poll(0.1, 2));
    expect(fz(ps[ps.length - 1], y.id)!.peers).not.toContain(bad.id);
  });
  it('a candidate with a confirmed missed trigger (terminal) is not a peer', () => {
    const gone = rec('HI1', 0), x = rec('HI2', 2), y = rec('HI3', 2.2);
    const ps = runApp([gone, x, y], poll(0.1, 3, (s, m) => (s === 'HI1' && m >= 1 && m < 1.6 ? 201.05 : undefined)));
    expect(ps[ps.length - 1].state.terminal[triggerKey(gone.id)]).toBeDefined();
    expect(fz(ps[ps.length - 1], y.id)!.peers).not.toContain(gone.id);
  });
});

describe('D3 · blocked-alert diagnostics use the same contemporaneous peer methodology (never allocated, never reserving)', () => {
  it('a PENDING-blocked AAA alert with three fresh higher-priced peers gets the percentile (9/10), not the scored-alone neutral 6', () => {
    const first = rec('AAA', 0), p1 = rec('HI1', 1), p2 = rec('HI2', 1.2), p3 = rec('HI3', 1.4), blocked = rec('AAA', 2);
    const before = (now: number, cs: Candidate[]) => (now >= atMin(0.5) ? cs.map((c) => (c.id === first.id ? { ...c, status: 'PENDING' as const } : c)) : cs);
    const ps = runApp([first, p1, p2, p3, blocked], poll(0.1, 3), { before });
    const diag = ps.find((p) => p.row(blocked.id)?.blocked?.score != null)!.row(blocked.id)!.blocked!;
    expect(diag.block.kind).toBe('PENDING_ORDER');
    const alone = runApp([blocked], poll(2.05, 3)).find((p) => p.row(blocked.id)?.ranked?.total != null)!.row(blocked.id)!.ranked!;
    expect(comps(alone).capitalEfficiency).toBe(6); // alone: 1 candidate → neutral
    // with the contemporaneous pool (existing formula, PENDING orders count as peers): the PENDING AAA order (equal
    // efficiency) and HI1–HI3 (lower) → p = (3 + 0.5 × 1) ÷ 4 = 0.875 → ROUND(2 + 8 × 0.875) = 9
    expect(diag.score).toBe(alone.total! + 3);
    expect(ps.some((p) => p.state.candidates.some((c) => c.id === blocked.id))).toBe(false); // never a candidate / allocation
  });
});

describe('D3 · BSX historical fixtures (2026-11-04)', { timeout: 120_000 }, () => {
  it('BSX LONG 12:20:06: Queue and Ranker now report the same capital efficiency and total at every instant (frozen at first scoring)', () => {
    const FX = loadFixture('bsx-1220-peers');
    const ID = 'BSX-L-122006-77deee';
    const ps = runApp(FX.records, fixtureSteps(FX));
    const f = fz(ps[ps.length - 1], ID)!;
    expect(f).toBeDefined();
    for (const p of ps) { const q = p.row(ID)?.ranked, r = p.ranked(ID); if (q?.total != null && r?.total != null) expect(r.total).toBe(q.total); }
  });
  it('BSX LONG 13:00:15: capital efficiency frozen at first scoring (6/10, fewer than 3 contemporaneous candidates) and never recomputed', () => {
    const FX = loadFixture('bsx-1300');
    const ID = 'BSX-L-130015-7a1518';
    const ps = runApp(FX.records, fixtureSteps(FX));
    const f = fz(ps[ps.length - 1], ID)!;
    expect(f).toMatchObject({ base: 6, method: 'NEUTRAL' });
    for (const p of ps) { const k = ce(p, ID); if (k && p.row(ID)!.ranked!.total != null) expect(k.points).toBe(6); }
  });
});
