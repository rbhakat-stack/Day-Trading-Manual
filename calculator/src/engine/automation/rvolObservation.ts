/**
 * RVOL POLICY V1 — OBSERVATION ONLY. Enabled only by the server flag RB_RVOL_V1_OBSERVATION_ENABLED (rb-health
 * config.rvolV1ObservationEnabled); absent / unknown / health failure = OFF. Display-only even when ON.
 *
 * Computes, SEPARATELY from production, what RB v1.1 would decide if RVOL policy V1 (rvolPolicyV1.ts) were active.
 * Isolation guarantees:
 *   • The authoritative production QueueOutput is never touched. The V1 run uses deep COPIES of every data input
 *     (records, candidates, positions, quotes, frozen snapshots, terminal events, broker facts) and its own buildQueue
 *     pass; its candidates, reservations, peer pool, allocations and tickets are discarded after comparison.
 *   • Nothing here writes storage, the Journal, the broker or any candidate state; results are deep-frozen objects.
 *   • No market-data or broker call: it uses only the inputs the production queue already holds.
 *   • Independent of v1.2 SHADOW (which is computed inside each run and simply compared, never altered).
 */
import type { AutoAlertRecord } from './alertDecision';
import { buildQueue, type QueueInput, type QueueOutput, type QueueRow } from './liveQueue';
import { applyRvolPolicyV1, evaluateRvolPolicyV1, type RvolV1Verdict } from './rvolPolicyV1';

/** Default when the server flag is absent or unknown: OFF. Observation is display-only even when ON. */
export const RVOL_V1_OBSERVATION_DEFAULT = false;
/** Bound: above this many records the observation is skipped (status SKIPPED_BOUND), never truncated silently. */
export const RVOL_V1_OBSERVATION_MAX_RECORDS = 600;
export const RVOL_V1_OBSERVATION_LABEL = 'RVOL POLICY V1 — OBSERVATION ONLY';

export interface RvolV1Side { decision: string; detail: string; score: number | null; tier: string | null; rvolPoints: number | null; ticket: boolean; plannedRisk: number | null }
export interface RvolV1Observation {
  recordId: string;
  label: typeof RVOL_V1_OBSERVATION_LABEL;
  verdict: RvolV1Verdict;
  production: RvolV1Side;
  v1: RvolV1Side;
  /** RVOL SOURCE DIFFERENCE: TrendSpider qualified RVOL > 1.5, RB SIP RVOL did not, and V1 accepted the qualification. */
  rvolSourceDifference: boolean;
  wouldCreateTicket: boolean;
  wouldRemoveTicket: boolean;
  /** Score moved without RVOL acceptance (relative capital-efficiency peer effect of other accepted alerts). */
  peerEffectOnly: boolean;
}

const side = (r: QueueRow | undefined): RvolV1Side => ({
  decision: r?.decision.decision ?? 'NOT IN QUEUE',
  detail: r?.decision.detail ?? '',
  score: r?.ranked?.total ?? r?.blocked?.score ?? null,
  tier: r?.ranked?.tier ?? r?.blocked?.tier ?? null,
  rvolPoints: r?.ranked?.components.find((k) => k.key === 'rvol')?.points ?? null,
  ticket: !!r?.decision.ticket,
  plannedRisk: r?.candidate?.plannedRisk ?? null,
});

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

/** Deep copies of every data input (functions such as `classify` are shared; they are pure lookups). */
function isolatedInput(q: QueueInput, records: AutoAlertRecord[]): QueueInput {
  const c = <T,>(x: T): T => (x === undefined ? x : structuredClone(x));
  return {
    ...q,
    records,
    candidates: c(q.candidates),
    positions: c(q.positions),
    quotes: c(q.quotes),
    parity: c(q.parity),
    frozen: c(q.frozen),
    terminal: c(q.terminal),
    broker: c(q.broker),
    releasedExposure: c(q.releasedExposure),
    knownBrokerEntries: c(q.knownBrokerEntries),
    knownBrokerPositions: c(q.knownBrokerPositions),
    observation: c(q.observation),
    cfg: c(q.cfg),
    rb: c(q.rb),
    rk: c(q.rk),
  };
}

/**
 * Observation for every record whose V1 view differs from production (accepted RVOL or a peer-pool effect).
 * `production` must be the QueueOutput the app already computed from `q`; it is only read.
 */
export function observeRvolPolicyV1(q: QueueInput, production: QueueOutput, extra?: Parameters<typeof evaluateRvolPolicyV1>[1], opts: { includePeerEffects?: boolean } = { includePeerEffects: true }): readonly RvolV1Observation[] {
  const verdicts = new Map<string, RvolV1Verdict>();
  const v1Records = q.records.map((r) => {
    const v = evaluateRvolPolicyV1(r, extra);
    verdicts.set(r.id, v);
    return applyRvolPolicyV1(structuredClone(r), v);
  });
  if (![...verdicts.values()].some((v) => v.accepted)) return deepFreeze([]);
  const v1Out = buildQueue(isolatedInput(q, v1Records)); // discarded after comparison — never fed back
  const prodById = new Map(production.rows.map((r) => [r.record.id, r]));
  const out: RvolV1Observation[] = [];
  for (const row of v1Out.rows) {
    const p = side(prodById.get(row.record.id));
    const n = side(row);
    const verdict = verdicts.get(row.record.id)!;
    const changed = p.decision !== n.decision || p.score !== n.score || p.tier !== n.tier || p.ticket !== n.ticket;
    if (!verdict.accepted && !changed) continue;
    if (!verdict.accepted && opts.includePeerEffects === false) continue; // live panel: RVOL-accepted alerts only
    out.push({
      recordId: row.record.id, label: RVOL_V1_OBSERVATION_LABEL, verdict, production: p, v1: n,
      rvolSourceDifference: verdict.accepted,
      wouldCreateTicket: !p.ticket && n.ticket,
      wouldRemoveTicket: p.ticket && !n.ticket,
      peerEffectOnly: !verdict.accepted && changed,
    });
  }
  return deepFreeze(out);
}

export interface RvolObservationRun {
  status: 'DISABLED' | 'OK' | 'SKIPPED_BOUND' | 'ERROR';
  observations: readonly RvolV1Observation[];
  ms: number;
  records: number;
  error: string | null;
  computedAtMs: number;
}

/**
 * Failure-isolated, bounded runner used by the app AFTER the authoritative queue has been computed and rendered.
 * Never throws: any error becomes status ERROR with no observations. Disabled → no computation at all.
 */
export function runRvolObservation(enabled: boolean, q: QueueInput | null, production: QueueOutput | null, now: () => number = () => Date.now(), observe: typeof observeRvolPolicyV1 = observeRvolPolicyV1): RvolObservationRun {
  const t0 = now();
  const base = { observations: deepFreeze([] as RvolV1Observation[]), ms: 0, records: q?.records.length ?? 0, error: null, computedAtMs: t0 };
  if (!enabled || !q || !production) return deepFreeze({ ...base, status: 'DISABLED' as const });
  if (q.records.length > RVOL_V1_OBSERVATION_MAX_RECORDS) return deepFreeze({ ...base, status: 'SKIPPED_BOUND' as const });
  try {
    const observations = observe(q, production, undefined, { includePeerEffects: false });
    return deepFreeze({ ...base, status: 'OK' as const, observations, ms: now() - t0 });
  } catch (e) {
    return deepFreeze({ ...base, status: 'ERROR' as const, ms: now() - t0, error: e instanceof Error ? e.message.slice(0, 200) : 'observation failed' });
  }
}
