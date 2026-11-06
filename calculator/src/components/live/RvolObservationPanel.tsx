/**
 * RVOL POLICY V1 — OBSERVATION ONLY (display components). Rendered only while the server flag
 * RB_RVOL_V1_OBSERVATION_ENABLED is ON. Read-only: no actions, no storage, no state shared with the authoritative queue.
 * Uses only class names already present in the app so the production CSS is unchanged.
 */
import { RVOL_V1_OBSERVATION_LABEL, type RvolObservationRun, type RvolV1Observation } from '../../engine/automation/rvolObservation';

const f = (x: number | null, d = 2) => (x === null || !Number.isFinite(x) ? '—' : x.toFixed(d));
export const OBSERVATION_WARNING = 'Observation results are simulated and CANNOT authorize execution. The RB v1.1 decision above is the only authority.';

/** Page-level banner (shown only when the flag is ON). */
export function RvolObservationBanner({ run }: { run: RvolObservationRun }) {
  if (run.status === 'DISABLED') return null;
  const state = run.status === 'OK' ? `${run.observations.length} alert(s) would be scored differently · computed in ${run.ms} ms` : run.status === 'SKIPPED_BOUND' ? `skipped — ${run.records} alerts exceed the observation bound` : `unavailable — ${run.error ?? 'error'} (authoritative decisions unaffected)`;
  return (
    <p className="rounded-lg border border-ink-700 bg-ink-850 p-2.5 text-[12.5px] text-warn">
      <b>{RVOL_V1_OBSERVATION_LABEL}</b> — {state}. {OBSERVATION_WARNING}
    </p>
  );
}

/** Per-alert comparison inside the alert details (only when an observation exists for that alert). */
export function RvolObservationPanel({ o }: { o: RvolV1Observation | null | undefined }) {
  if (!o) return null;
  const changed = o.production.decision !== o.v1.decision;
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-850 p-2.5 text-[12.5px]">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">{RVOL_V1_OBSERVATION_LABEL}</p>
      <p className="text-warn">{OBSERVATION_WARNING}</p>
      <p>Current RB v1.1 decision (authoritative): <b>{o.production.decision}</b> — {o.production.detail} · score {f(o.production.score, 0)} {o.production.tier ?? ''} · RVOL points {f(o.production.rvolPoints, 0)}</p>
      <p>Proposed V1 decision (simulated): <b>{o.v1.decision}</b> — {o.v1.detail} · score {f(o.v1.score, 0)} {o.v1.tier ?? ''} · RVOL points {f(o.v1.rvolPoints, 0)}</p>
      {changed && o.production.decision === 'DATA REVIEW REQUIRED' && <p>Under V1 this RVOL-only DATA REVIEW would become normal scoring.</p>}
      {o.rvolSourceDifference && <p className="text-warn">RVOL SOURCE DIFFERENCE — TrendSpider qualified RVOL20 &gt; 1.5; RB Alpaca SIP RVOL {f(o.verdict.rbRvol)} (TrendSpider formula on SIP {f(o.verdict.tsFormulaSipRvol)}; TrendSpider actual NOT CAPTURED). RVOL score points stay RB's own.</p>}
      {(o.wouldCreateTicket || o.wouldRemoveTicket) && <p className="text-warn">{o.wouldCreateTicket ? 'V1 WOULD create an actionable ticket — not created (observation only).' : 'V1 WOULD remove the actionable ticket — not removed (observation only).'}</p>}
      <p className="text-ink-400">Prerequisites: {o.verdict.checks.map((c) => `${c.pass ? '✓' : '✗'} ${c.code}`).join(' · ') || '—'}</p>
      <p className="text-ink-400">Simulated score: same engine, current in-memory inputs; portfolio and broker state as currently known; never ranked, allocated or reserved.</p>
    </div>
  );
}
