/**
 * RVOL POLICY V1 — OBSERVATION release safety: failure isolation, bounds, throttle, flag default, malformed / out-of-order
 * data, high volume, and peer-pool / candidate-state independence of the authoritative queue.
 */
import { describe, expect, it, vi } from 'vitest';
import FX from './rvol-v1-observation-2026-11-06.json';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue, type QueueInput, type QueueRow } from '../liveQueue';
import { observeRvolPolicyV1, runRvolObservation, RVOL_V1_OBSERVATION_MAX_RECORDS } from '../rvolObservation';
import { shouldRecompute, RVOL_OBSERVATION_MIN_INTERVAL_MS } from '../../../lib/rvolObservationHook';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../settings';
import { KNOWN_CLASSIFICATIONS } from '../../ranker/correlationRules';

const ALL = FX.records as unknown as AutoAlertRecord[];
const clone = (p: string) => structuredClone(ALL.find((r) => r.id.startsWith(p))!) as AutoAlertRecord;
const classify = (s: string) => KNOWN_CLASSIFICATIONS[s] ?? { sector: `Sector-${s}`, industry: `Industry-${s}`, theme: '' };
function input(records: AutoAlertRecord[], now?: number, candidates: QueueInput['candidates'] = []): QueueInput {
  const t = now ?? Math.max(...records.map((r) => Date.parse(r.processedIso ?? r.receivedIso))) + 4_000;
  const quotes: Record<string, LiveQuote> = {};
  for (const r of records) if (r.initialQuote) quotes[r.alert.symbol] = { ...r.initialQuote, tradeIso: new Date(t - 1500).toISOString(), fetchedIso: new Date(t - 500).toISOString(), receivedMs: t - 500 };
  return { records, candidates, positions: [], quotes, now: t, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify, parity: {}, strategyVersion: 'RB v1.1', frozen: {}, terminal: {}, knownBrokerEntries: [], knownBrokerPositions: [], observation: {} };
}
const key = (rows: QueueRow[]) => JSON.stringify(rows.map((r) => [r.record.id, r.decision, r.ranked, r.candidate, r.live, r.shadow, r.lifecycle, r.blocked ?? null]));
const snap = (q: QueueInput) => JSON.stringify({ ...q, classify: undefined });

describe('failure isolation and bounds', () => {
  const q = input([clone('FTNT-S-1030'), clone('CARR'), clone('CTVA')]);
  const prod = buildQueue(q);
  it('flag OFF → nothing is computed (observe never called)', () => {
    const spy = vi.fn();
    const r = runRvolObservation(false, q, prod, Date.now, spy as never);
    expect(r.status).toBe('DISABLED');
    expect(spy).not.toHaveBeenCalled();
  });
  it('an exception inside observation becomes status ERROR — never thrown, authoritative output untouched', () => {
    const before = key(prod.rows);
    const r = runRvolObservation(true, q, prod, Date.now, (() => { throw new Error('boom'); }) as never);
    expect(r).toMatchObject({ status: 'ERROR', error: 'boom' });
    expect(r.observations).toEqual([]);
    expect(key(prod.rows)).toBe(before);
  });
  it('bounded: more than the maximum records → SKIPPED_BOUND, no computation', () => {
    const many = { ...q, records: Array.from({ length: RVOL_V1_OBSERVATION_MAX_RECORDS + 1 }, () => q.records[0]) };
    const spy = vi.fn();
    expect(runRvolObservation(true, many, prod, Date.now, spy as never).status).toBe('SKIPPED_BOUND');
    expect(spy).not.toHaveBeenCalled();
  });
  it('live panel mode lists RVOL-accepted alerts only (no peer-effect rows); results are frozen', () => {
    const r = runRvolObservation(true, q, prod);
    expect(r.status).toBe('OK');
    expect(r.observations.every((o) => o.verdict.accepted)).toBe(true);
    expect(Object.isFrozen(r)).toBe(true);
  });
  it('throttle: recompute on a new alert id or after the interval, never while disabled', () => {
    expect(shouldRecompute(false, 0, '', 'a', 1e12)).toBe(false);
    expect(shouldRecompute(true, 1000, 'a', 'a,b', 1001)).toBe(true);
    expect(shouldRecompute(true, 1000, 'a', 'a', 1000 + RVOL_OBSERVATION_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(shouldRecompute(true, 1000, 'a', 'a', 1000 + RVOL_OBSERVATION_MIN_INTERVAL_MS)).toBe(true);
  });
});

describe('authoritative independence (peer pool, candidate state, inputs)', () => {
  it('production computed before and after an observation run is identical — inputs (incl. candidates with frozen capital efficiency, continuity map, broker positions) are never mutated', () => {
    // a realistic session: earlier candidates exist (frozen capital efficiency set by the first pass)
    const recs = [clone('FTNT-S-1030'), clone('CARR'), clone('CTVA'), clone('Q-L')];
    const first = buildQueue(input(recs.slice(0, 3)));
    const q = input(recs, undefined, first.candidates);
    const before = snap(q);
    const prod1 = buildQueue(q);
    const r = runRvolObservation(true, q, prod1);
    expect(r.status).toBe('OK');
    expect(snap(q)).toBe(before);
    const prod2 = buildQueue(q);
    expect(key(prod2.rows)).toBe(key(prod1.rows));
    expect(JSON.stringify(prod2.candidates)).toBe(JSON.stringify(prod1.candidates)); // no reservation, no peer-pool entry
  });
  it('malformed data never throws and never changes production: missing snapshot values, NaN indicators, junk payload', () => {
    const a = clone('FTNT-S-1030'); a.snapshot = null;
    const b = clone('CARR'); b.snapshot!.values!.rvol = Number.NaN; b.snapshot!.values!.ema9 = Number.NaN;
    const c = clone('CTVA'); (c as unknown as { payload: unknown }).payload = { rule_set: 42, junk: { deep: [1, 2] } };
    const q = input([a, b, c]);
    const prod = buildQueue(q);
    const before = key(prod.rows);
    const r = runRvolObservation(true, q, prod);
    expect(['OK', 'ERROR']).toContain(r.status);
    expect(key(buildQueue(q).rows)).toBe(before);
  });
  it('out-of-order and duplicate-arrival input: production and observation are order-independent', () => {
    const recs = [clone('CTVA'), clone('FTNT-S-1030'), clone('Q-L'), clone('CARR')];
    const now = Math.max(...recs.map((r) => Date.parse(r.processedIso!))) + 4000;
    const qa = input(recs, now), qb = input([...recs].reverse(), now);
    const pa = buildQueue(qa), pb = buildQueue(qb);
    const ids = (rows: QueueRow[]) => JSON.stringify([...rows].sort((x, y) => x.record.id.localeCompare(y.record.id)).map((r) => [r.record.id, r.decision.decision, r.ranked?.total ?? null]));
    expect(ids(pb.rows)).toBe(ids(pa.rows));
    const oa = runRvolObservation(true, qa, pa).observations.map((o) => o.recordId).sort();
    const ob = runRvolObservation(true, qb, pb).observations.map((o) => o.recordId).sort();
    expect(ob).toEqual(oa);
  });
  it('browser refresh / restart: observation is recomputed from the same inputs (no stored state) and is deterministic', () => {
    const q = input([clone('FTNT-S-1030'), clone('CARR')]);
    const p = buildQueue(q);
    const r1 = runRvolObservation(true, q, p, () => 0);
    const fresh: QueueInput = { ...q, records: structuredClone(q.records), candidates: structuredClone(q.candidates) }; // as after a reload
    const r2 = runRvolObservation(true, fresh, buildQueue(fresh), () => 0);
    expect(JSON.stringify(r2.observations)).toBe(JSON.stringify(r1.observations));
  });
  it('high volume (300 alerts, rapid repeats across 40 tickers): completes, bounded, production unchanged', () => {
    const base = clone('FTNT-S-1030');
    const syms = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH', 'III', 'JJJ'].flatMap((x) => [x, x + 'X', x + 'Y', x + 'Z']);
    const recs = Array.from({ length: 300 }, (_, i) => {
      const r = structuredClone(base);
      r.id = `${syms[i % syms.length]}-S-${i}`; r.dedupeKey = r.id; r.alert.symbol = syms[i % syms.length];
      r.receivedMs = base.receivedMs + Math.floor(i / 40) * 2000; r.alert.alertTimeMs = r.receivedMs; r.processedIso = new Date(r.receivedMs + 900).toISOString();
      return r;
    });
    const q = input(recs);
    const t0 = performance.now();
    const prod = buildQueue(q);
    const tProd = performance.now() - t0;
    const before = key(prod.rows);
    const t1 = performance.now();
    const r = runRvolObservation(true, q, prod);
    const tObs = performance.now() - t1;
    expect(r.status).toBe('OK');
    expect(key(prod.rows)).toBe(before);
    expect(tObs).toBeLessThan(Math.max(10_000, tProd * 8)); // generous bound; real numbers are reported separately
  });
});

describe('peer-pool counterfactual is never authoritative', () => {
  it('peer-effect rows exist only in the full (tool) mode; the live mode never shows them', () => {
    const q = input([clone('FTNT-S-1030'), clone('CARR'), clone('CTVA'), clone('Q-L')]);
    const p = buildQueue(q);
    const full = observeRvolPolicyV1(q, p);
    const live = observeRvolPolicyV1(q, p, undefined, { includePeerEffects: false });
    expect(live.every((o) => !o.peerEffectOnly)).toBe(true);
    expect(live.length).toBeLessThanOrEqual(full.length);
  });
});
