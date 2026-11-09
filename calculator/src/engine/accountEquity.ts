/**
 * Defect 1 — ONE authoritative account equity.
 *
 * Root cause: account equity was stored twice and edited independently — Settings → "Default account equity"
 * (`rbv1.settings.v1` → `accountEquity`, used for trade SIZING: max dollar risk → quantity) and Ranker → Portfolio policy
 * → "Account equity $" (`rbv1.ranker.settings.v1` → `portfolio.accountEquity`, used for ALLOCATION: usable capital,
 * heat limit, per-trade risk limit, conservative broker-only risk). Equity is not part of the frozen strategy
 * fingerprint, so both copies stayed editable under RB v1.1 and could diverge silently.
 *
 * Model (no new storage key, no Supabase):
 *   • One effective value, produced only by `effectiveAccountEquity`. Every calculation reads it through
 *     `withEffectiveEquity` — never one of the stored copies directly.
 *   • Writes go through `syncAccountEquity`: an equity edit on EITHER screen writes the same value to both stored
 *     fields at once, so neither is independently writable any more. The Ranker field is kept only as a
 *     write-through mirror (backward compatibility: a rolled-back build still reads the same value).
 *   • Existing conflicting values are preserved as stored and shown to the user (`conflict`). Until the user chooses,
 *     the effective value is the LOWER of the two: every calculation then uses an equity no higher than the one it used
 *     before (sizing ≤ before, usable capital / heat limit / per-trade limit ≤ before) — never a silent risk increase.
 *   • Deterministic and refresh-safe: the conflict is re-derived from the two stored values on every load until it is
 *     resolved; resolution writes both copies together.
 *   • Historical candidates, alert-time snapshots and Journal records store their own sizes and scores; nothing here
 *     re-sizes or re-scores them. Only new calculations use the effective value.
 */
import type { RbSettings } from './settings';
import type { RankerSettings } from './ranker/rankerSettings';

export type EquitySource = 'SINGLE' | 'CONFLICT_LOWER_USED';

export interface EffectiveEquity {
  /** The one account equity every calculation uses. */
  value: number;
  source: EquitySource;
  /** The two stored values when they disagree (null when they agree). Shown to the user until resolved. */
  conflict: { settings: number; ranker: number } | null;
}

const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** The single effective equity from the two stored copies. Pure and deterministic. */
export function effectiveAccountEquity(rb: Pick<RbSettings, 'accountEquity'>, rk: Pick<RankerSettings, 'portfolio'>): EffectiveEquity {
  const s = rb.accountEquity;
  const r = rk.portfolio.accountEquity;
  if (s === r || !valid(r)) return { value: s, source: 'SINGLE', conflict: null };
  if (!valid(s)) return { value: r, source: 'SINGLE', conflict: null };
  return { value: Math.min(s, r), source: 'CONFLICT_LOWER_USED', conflict: { settings: s, ranker: r } };
}

/**
 * Calculation views of both settings objects carrying the effective equity. Returns the SAME objects when no change
 * is needed (no conflict) so memoised consumers and outputs are unchanged.
 */
export function withEffectiveEquity(rb: RbSettings, rk: RankerSettings, eq: EffectiveEquity = effectiveAccountEquity(rb, rk)): { rb: RbSettings; rk: RankerSettings } {
  return {
    rb: rb.accountEquity === eq.value ? rb : { ...rb, accountEquity: eq.value },
    rk: rk.portfolio.accountEquity === eq.value ? rk : { ...rk, portfolio: { ...rk.portfolio, accountEquity: eq.value } },
  };
}

/**
 * The write rule. Given the current stored pair and a proposed pair from one editor, an equity change on either side
 * is written to BOTH. No equity change → the proposal is returned untouched (an existing conflict stays visible —
 * editing another field never resolves it silently). If both sides changed to different values (not produced by the
 * UI), the lower is written.
 */
export function syncAccountEquity(current: [RbSettings, RankerSettings], next: [RbSettings, RankerSettings]): [RbSettings, RankerSettings] {
  const [rb0, rk0] = current;
  const [rb, rk] = next;
  const sChanged = rb.accountEquity !== rb0.accountEquity;
  const rChanged = rk.portfolio.accountEquity !== rk0.portfolio.accountEquity;
  if (!sChanged && !rChanged) return next;
  const v = sChanged && rChanged ? Math.min(rb.accountEquity, rk.portfolio.accountEquity) : sChanged ? rb.accountEquity : rk.portfolio.accountEquity;
  return [{ ...rb, accountEquity: v }, { ...rk, portfolio: { ...rk.portfolio, accountEquity: v } }];
}

export function equityConflictText(c: NonNullable<EffectiveEquity['conflict']>): string {
  const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `Account equity conflict: Settings has ${usd(c.settings)} but Ranker → Portfolio policy has ${usd(c.ranker)}. Until you choose, every calculation (trade sizing, available capital, heat limit, per-trade risk limit) uses the lower value, ${usd(Math.min(c.settings, c.ranker))}.`;
}
