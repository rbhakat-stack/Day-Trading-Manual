/**
 * S2a.2 — observation continuity and time integrity for new-entry authorization (in-memory, per browser tab).
 *
 * A new-entry ticket is offered only when this tab has observed the alert's market data WITHOUT A GAP from the server's
 * own first observation of the alert to the current decision — measured entirely in SERVER time:
 *   • start: the alert record's initialQuote.fetchedIso (stamped by the server when it processed the webhook);
 *   • then every price poll's quote.fetchedIso (stamped by the server at its Alpaca fetch).
 * The state lives only in memory: a reload, a second tab, a late opening, a suspended tab, an offline period or missed
 * polls all show up as a gap and are never "healed" for that alert. Nothing is persisted; nothing claims that an
 * unobserved chase happened — the evidence is simply missing, so authorization is withheld (fail closed).
 *
 * Limits come from the existing configuration and the existing data-age tolerance (validated against production
 * timing in S1_SAFETY_SPEC.md §9):
 *   first observation ≤ pollMs + maxDataAgeSec     (alert poll, then an immediate price fetch)
 *   between observations ≤ quotePollMs + maxDataAgeSec
 *   |server time − client time| ≤ maxDataAgeSec    (otherwise the client clock cannot be trusted for the lifecycle)
 */
import type { AutomationConfig, AutoAlertRecord, LiveQuote } from '../alertDecision';
import { etParts } from '../etTime';
import { RB_V1_DEFAULTS } from '../../settings';

export interface ObservationState {
  /** Server time of the latest observation counted for this alert. */
  lastServerMs: number;
  /** At least one client observation after the server's first one. */
  observed: boolean;
  /** Why continuity can no longer be established for this alert in this tab (null = continuous so far). */
  broken: string | null;
}
export type ObservationMap = Record<string, ObservationState>;

type Limits = Pick<AutomationConfig, 'pollMs' | 'quotePollMs' | 'maxDataAgeSec'>;
export const continuityLimits = (cfg: Limits) => ({ firstMs: cfg.pollMs + cfg.maxDataAgeSec * 1000, gapMs: cfg.quotePollMs + cfg.maxDataAgeSec * 1000, clockMs: cfg.maxDataAgeSec * 1000 });

const WINDOW_MS = RB_V1_DEFAULTS.alertWindowMinutes * 60_000;
const s = (ms: number) => (ms / 1000).toFixed(1);

/** Fold the current quotes into the per-alert observation state. Idempotent: the same quote is never counted twice. */
export function observeContinuity(prev: ObservationMap, records: AutoAlertRecord[], quotes: Record<string, LiveQuote>, cfg: Limits): ObservationMap {
  const lim = continuityLimits(cfg);
  let out = prev;
  for (const rec of records) {
    if (rec.status !== 'OK') continue;
    const cur = prev[rec.id];
    let st: ObservationState;
    if (!cur) {
      const init = rec.initialQuote ? Date.parse(rec.initialQuote.fetchedIso) : NaN;
      st = Number.isFinite(init) ? { lastServerMs: init, observed: false, broken: null } : { lastServerMs: NaN, observed: false, broken: 'no server observation at alert time' };
    } else st = cur;
    const q = quotes[rec.alert.symbol];
    const f = q ? Date.parse(q.fetchedIso) : NaN;
    if (!st.broken && Number.isFinite(f) && f > st.lastServerMs && f - rec.alert.alertTimeMs <= WINDOW_MS + lim.gapMs) {
      const gap = f - st.lastServerMs;
      const limit = st.observed ? lim.gapMs : lim.firstMs;
      st = gap > limit
        ? { lastServerMs: f, observed: true, broken: `market data not observed continuously in this browser — ${s(gap)} s without an observation (limit ${s(limit)} s) before ${etParts(f).hhmmss} ET` }
        : { lastServerMs: f, observed: true, broken: null };
    }
    if (st !== cur) {
      if (out === prev) out = { ...prev };
      out[rec.id] = st;
    }
  }
  return out;
}

/**
 * Why this alert's ticket must be withheld for missing observation or time evidence (null = evidence complete).
 * `obs` undefined = the caller does not track continuity (legacy engine callers and tests); the App always tracks it.
 */
export function observationRefusal(rec: AutoAlertRecord, quote: LiveQuote | null, obs: ObservationMap | undefined, cfg: Limits): string | null {
  // Step 3 · A — a snapshot completed late must come with server evidence that the entry trigger was not reached while
  // RB waited; without it (UNVERIFIED) or with a crossing, no ticket is ever offered for this alert (fail closed).
  const gap = rec.delayedReconstruction?.gap;
  if (gap && gap.status !== 'NOT_CROSSED') return gap.status === 'CROSSED' ? `entry trigger reached during the delayed reconstruction — ${gap.reason}` : `trigger continuity during the delayed reconstruction is unverified — ${gap.reason}`;
  if (!obs) return null;
  const st = obs[rec.id];
  if (!st) return 'market data not yet observed in this browser';
  if (st.broken) return st.broken;
  if (!st.observed) return 'market data not yet observed in this browser';
  if (!quote) return 'no current server observation';
  const skew = Date.parse(quote.fetchedIso) - quote.receivedMs; // server − client (≈ −response latency when clocks agree)
  const lim = continuityLimits(cfg).clockMs;
  if (!Number.isFinite(skew) || Math.abs(skew) > lim) return `this computer's clock differs from server time by ${s(Math.abs(skew))} s (limit ${s(lim)} s) — the alert lifecycle cannot be timed reliably`;
  return null;
}
