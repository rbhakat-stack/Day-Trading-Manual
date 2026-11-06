/**
 * RVOL POLICY V1 — OBSERVATION ONLY (display component). NOT MOUNTED anywhere; gated by RVOL_V1_OBSERVATION_ENABLED
 * (default false). Read-only: renders immutable observation results; it has no actions and writes nothing.
 * Uses only class names already present in the app so the production CSS is unchanged.
 */
import { RVOL_V1_OBSERVATION_ENABLED, RVOL_V1_OBSERVATION_LABEL, type RvolV1Observation } from '../../engine/automation/rvolObservation';

const f = (x: number | null, d = 2) => (x === null || !Number.isFinite(x) ? '—' : x.toFixed(d));

export function RvolObservationPanel({ observations, enabled = RVOL_V1_OBSERVATION_ENABLED }: { observations: readonly RvolV1Observation[]; enabled?: boolean }) {
  if (!enabled || !observations.length) return null;
  return (
    <details className="rounded-lg border border-ink-700 bg-ink-850 p-2.5 text-[12.5px]">
      <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-ink-400">{RVOL_V1_OBSERVATION_LABEL} — never affects decisions, tickets or capital</summary>
      <div className="mt-3 space-y-3">
        {observations.map((o) => (
          <div key={o.recordId} className="rounded-lg border border-ink-700 bg-ink-850 p-2.5 text-[12.5px]">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">{o.recordId}</p>
            <p>Production (authoritative): {o.production.decision} — {o.production.detail} · score {f(o.production.score, 0)} {o.production.tier ?? ''} · RVOL points {f(o.production.rvolPoints, 0)}</p>
            <p>V1 (observation only): {o.v1.decision} — {o.v1.detail} · score {f(o.v1.score, 0)} {o.v1.tier ?? ''} · RVOL points {f(o.v1.rvolPoints, 0)}</p>
            <p>RB RVOL {f(o.verdict.rbRvol)} · TrendSpider formula on Alpaca SIP {f(o.verdict.tsFormulaSipRvol)} · TrendSpider actual NOT CAPTURED</p>
            {o.rvolSourceDifference && <p className="text-warn">RVOL SOURCE DIFFERENCE</p>}
            {o.peerEffectOnly && <p className="text-ink-400">Score changed only through the relative capital-efficiency peer pool.</p>}
            {(o.wouldCreateTicket || o.wouldRemoveTicket) && <p className="text-warn">{o.wouldCreateTicket ? 'V1 WOULD CREATE an actionable ticket (observation only — none created)' : 'V1 WOULD REMOVE the actionable ticket (observation only)'}</p>}
            <p className="text-ink-400">Prerequisites: {o.verdict.checks.map((c) => `${c.pass ? '✓' : '✗'} ${c.code}`).join(' · ') || '—'}</p>
          </div>
        ))}
      </div>
    </details>
  );
}
