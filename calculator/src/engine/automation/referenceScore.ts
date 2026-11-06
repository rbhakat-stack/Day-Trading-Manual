/**
 * PHASE C — reference-only opportunity scores and indicator mismatch diagnostics. DISPLAY ONLY.
 * Server flag RB_REFERENCE_SCORES_ENABLED (rb-health config.referenceScoresEnabled); absent / unknown = OFF.
 *
 * Why alerts show NOT SCORED today: the ranker (candidateRanker.rankCandidates) computes every score component for
 * every candidate — applying its documented hard-fail N/A rule ("no points are assigned to a hard-failed value",
 * hardFailNA/applyNA) — but sets total = null whenever ANY strategy hard rule failed (canScore requires no strategy
 * fail and no missing input). This module only DERIVES a reference total from those already-computed components with
 * the ranker's exact arithmetic: setup = min(70, round1(Σ setup components)), fit = min(30, round1(Σ fit components)),
 * total = min(100, round1(setup + fit)). It never calls the ranker, never adds points, never changes a component,
 * never enters a peer pool (capital efficiency is the value the ranker already computed against the authoritative pool
 * plus the candidate itself — hard-failed candidates are never peers), and is never used for any decision.
 *
 * A score is UNAVAILABLE (never invented) when there is no candidate, a required input is missing, or a component is
 * flagged missing — the exact reasons are listed.
 */
import type { AutoAlertRecordV12 } from './v12/audit';
import type { QueueRow } from './liveQueue';
import { FIT_KEYS, SETUP_KEYS, type ComponentKey, type ComponentScore, type QualityTier } from '../ranker/opportunityTypes';
import { classifyScore } from '../ranker/candidateRanker';
import type { RankerSettings } from '../ranker/rankerSettings';

export const REFERENCE_LABEL = 'REFERENCE ONLY — NOT ELIGIBLE FOR EXECUTION';

export type ScoreView =
  | { kind: 'SCORED'; total: number }
  | { kind: 'REFERENCE'; total: number; setup: number; fit: number; components: readonly ComponentScore[]; hardFails: string[] }
  | { kind: 'UNAVAILABLE'; reasons: string[] }
  | { kind: 'PENDING'; reasons: string[] };

const round1 = (x: number) => Math.round(x * 10) / 10; // identical to candidateRanker
const sumKeys = (cs: readonly ComponentScore[], keys: ComponentKey[]) => round1(cs.filter((x) => keys.includes(x.key)).reduce((a, x) => a + x.points, 0));

/** The ranker's total arithmetic on given components (exported for the identity test against scored candidates). */
export function totalFromComponents(cs: readonly ComponentScore[]): { setup: number; fit: number; total: number } {
  const setup = Math.min(70, sumKeys(cs, SETUP_KEYS));
  const fit = Math.min(30, sumKeys(cs, FIT_KEYS));
  return { setup, fit, total: Math.min(100, round1(setup + fit)) };
}

/** Pure. Reads the authoritative row only. */
export function scoreView(r: QueueRow): ScoreView {
  const rec = r.record;
  if (r.decision.decision === 'SCORING' || rec.status === 'RECEIVED' || rec.status === 'ENRICHING') return { kind: 'PENDING', reasons: ['Alert still being processed.'] };
  const k = r.ranked;
  if (k && k.total !== null) return { kind: 'SCORED', total: k.total };
  if (rec.status === 'DATA_ERROR') return { kind: 'UNAVAILABLE', reasons: rec.errors.length ? rec.errors : ['Market data could not be retrieved.'] };
  const snap = rec.snapshot;
  if (!snap?.values) return { kind: 'UNAVAILABLE', reasons: snap?.issues.length ? snap.issues.map((i) => `${i.code}: ${i.message}`) : ['No complete alert-time snapshot.'] };
  if (!k) return { kind: 'UNAVAILABLE', reasons: r.candidate ? ['Candidate not ranked.'] : ['No trade candidate (no current price or calculator plan).'] };
  if (k.missing.length) return { kind: 'UNAVAILABLE', reasons: k.missing.map((m) => `Missing input: ${m}`) };
  const missingComp = k.components.filter((c) => c.missing).map((c) => `Missing component: ${c.label}`);
  if (missingComp.length) return { kind: 'UNAVAILABLE', reasons: missingComp };
  const t = totalFromComponents(k.components);
  return { kind: 'REFERENCE', ...t, components: k.components, hardFails: [...new Set(k.hardFails.filter((f) => !['NO_POSITION_SLOT', 'CAPITAL_LIMIT', 'PORTFOLIO_HEAT_LIMIT', 'CORRELATION_LIMIT'].includes(f.code)).map((f) => f.code))] };
}

/**
 * DISPLAY-ONLY tier for a REFERENCE score: the production classifier (classifyScore, the Ranker's current grades) applied
 * to the reference total. Never stored, never fed to any decision, ranking or ticket. Only called for a REFERENCE view —
 * an UNAVAILABLE score never gets a tier (shown as N/A).
 */
export function referenceTier(total: number, grades: RankerSettings['grades']): QualityTier {
  return classifyScore(total, { grades } as RankerSettings);
}

/* ───────────────────────── indicator mismatch diagnostics ───────────────────────── */

export type CheckStatus = 'PASS' | 'FAILED' | 'NOT VERIFIED' | 'SOURCE DIFFERENCE';
export interface IndicatorCheck {
  indicator: string;
  required: string;
  rbValue: string;
  trendspiderActual: 'NOT CAPTURED';
  status: CheckStatus;
  blocks: string;
  reason: string;
}

const RULE_OF: [RegExp, string, string][] = [
  [/^5m Close [<>] VWAP/, 'CLOSE_VS_VWAP', 'VWAP'],
  [/^EMA9 [<>] EMA20/, 'EMA9_VS_EMA20', 'EMA9 vs EMA20'],
  [/^RSI14/, 'RSI', 'RSI(14)'],
  [/^RVOL20/, 'RVOL', 'RVOL(20)'],
  [/^Close [<>] Open/, 'CANDLE_DIRECTION', '5-minute candle direction'],
  [/^15m Close/, 'CONFIRM_15M', '15-minute confirmation'],
];
const f = (x: number | undefined | null, d = 2) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : '—');

/** Per-condition diagnostics from the frozen alert-time snapshot (and its v1.2 SIP tolerances where present). Pure. */
export function indicatorChecks(r: QueueRow): IndicatorCheck[] {
  const s = r.record.snapshot;
  const v = s?.values;
  const diag = new Map<string, { class: string; tolerance: number | null; margin: number | null }>(((r.record as AutoAlertRecordV12).v12?.conditionDiagnostics ?? []).map((d) => [d.rule as string, d]));
  const hard = new Set((r.ranked?.hardFails ?? []).map((h) => h.code));
  const out: IndicatorCheck[] = [];
  for (const c of s?.alertConditions ?? []) {
    const m = RULE_OF.find(([re]) => re.test(c.label));
    const rule = m?.[1] ?? '';
    const name = m?.[2] ?? c.label;
    const d = diag.get(rule);
    const rbValue = !v ? '—'
      : rule === 'CLOSE_VS_VWAP' ? `Close ${f(v.close)} · VWAP ${f(v.vwap, 3)}`
        : rule === 'EMA9_VS_EMA20' ? `EMA9 ${f(v.ema9, 3)} · EMA20 ${f(v.ema20, 3)}`
          : rule === 'RSI' ? f(v.rsi, 1)
            : rule === 'RVOL' ? `${f(v.rvol)} (current RB formula; the TrendSpider-formula SIP value is shown in the RVOL diagnostic rows)`
              : rule === 'CANDLE_DIRECTION' ? `Open ${f(v.open)} · Close ${f(v.close)}`
                : rule === 'CONFIRM_15M' ? `15m Close ${f(v.close15m)} · EMA20 ${f(v.ema20_15m, 3)}` : '—';
    let status: CheckStatus;
    let reason: string;
    if (c.pass) { status = 'PASS'; reason = 'Reproduced by RB on Alpaca SIP data.'; }
    else if (rule === 'RVOL') { status = 'SOURCE DIFFERENCE'; reason = 'TrendSpider fired under a rule set that includes RVOL > 1.5 (label only — configuration not independently verified); RB’s Alpaca SIP RVOL is ≤ 1.5. TrendSpider’s actual RVOL is not captured.'; }
    else if (d?.class === 'KNIFE_EDGE') { status = 'NOT VERIFIED'; reason = `Within RB’s parity tolerance (±${f(d.tolerance, 3)}) — too close to call on SIP data.`; }
    else if (!v) { status = 'NOT VERIFIED'; reason = 'Required values unavailable.'; }
    else { status = 'FAILED'; reason = `RB’s valid SIP data shows the condition is false${d?.margin != null ? ` (margin ${f(d.margin, 3)} beyond tolerance ±${f(d.tolerance, 3)})` : ''}.`; }
    const hardCode = rule === 'CANDLE_DIRECTION' ? 'INVALID_CANDLE_DIRECTION' : rule === 'CONFIRM_15M' ? 'HTF_CONFIRMATION_FAILED' : null;
    const blocks = c.pass ? 'No' : hardCode && hard.has(hardCode) ? `Yes — hard rule ${hardCode} and DATA REVIEW` : 'Yes — DATA REVIEW (not reproduced)';
    out.push({ indicator: name, required: c.label, rbValue, trendspiderActual: 'NOT CAPTURED', status, blocks, reason });
  }
  for (const i of s?.issues ?? []) {
    if (i.kind !== 'INCOMPLETE') continue;
    out.push({ indicator: 'Data completeness', required: 'Complete alert-time data', rbValue: i.code, trendspiderActual: 'NOT CAPTURED', status: 'NOT VERIFIED', blocks: 'Yes — DATA INCOMPLETE', reason: i.message });
  }
  if (r.record.status === 'DATA_ERROR') out.push({ indicator: 'Market data', required: 'Verified market data', rbValue: r.record.errorCode ?? 'DATA_ERROR', trendspiderActual: 'NOT CAPTURED', status: 'NOT VERIFIED', blocks: 'Yes — DATA REVIEW', reason: r.record.errors.join(' · ') || 'Market data could not be retrieved.' });
  return out;
}

export interface MismatchSummary { count: number; label: string | null; headline: string | null; checks: IndicatorCheck[] }
export function mismatchSummary(r: QueueRow): MismatchSummary {
  const checks = indicatorChecks(r);
  const bad = checks.filter((c) => c.status !== 'PASS');
  const count = bad.length;
  return {
    count,
    checks,
    label: count === 0 ? null : count === 1 ? `1 MISMATCH (${bad[0].status})` : `${count} MISMATCHES`,
    headline: count >= 2 ? `${r.decision.decision} — MULTIPLE INDICATOR DISCREPANCIES` : count === 1 ? `${r.decision.decision} — ${bad[0].indicator}: ${bad[0].status}` : null,
  };
}
