/**
 * RVOL transparency (diagnostic only — never used for eligibility, scoring, tickets or authorization).
 *
 * TrendSpider support confirmed RVOL(20, SMA, 1) = volume / shift(sma(volume, 20), 1): the denominator is the SMA20 of
 * the 20 completed candles BEFORE the signal candle ("Base 1" is visual only; 5-minute candles are labelled by start).
 * RB v1.1's live RVOL (indicators.ts rvol(), used by the RVOL20 > 1.5 condition and the ranker) still includes the
 * signal candle in its own average and is NOT changed here.
 *
 * This module records, at alert time and from the SAME completed regular-session bars the snapshot used, the value the
 * confirmed TrendSpider formula gives on Alpaca SIP volume. It is labelled as such — it is NOT TrendSpider's actual
 * RVOL (TrendSpider's volume series differs). TrendSpider's actual value is NOT CAPTURED unless an authorised source
 * supplies it; nothing here ever infers it.
 */
import { regularSessionBars, type SnapshotResult } from './alertSnapshot';
import type { Bar } from './indicators';

/**
 * TrendSpider-confirmed formula on the given bars: volume / SMA20 of the 20 completed regular-session candles before the
 * signal candle (shift(sma(volume, 20), 1)). Self-contained on purpose: live modules must not import the Historical SIP
 * diagnostic module (CR-001 isolation guard). Its equality with historicalParityRvol() is asserted in the tests.
 * Fails closed (null) with fewer than 20 previous candles or a zero baseline.
 */
export function tsFormulaRvol(bars5: Bar[], signalStartMs: number, signalVolume: number): { value: number | null; baseline: number | null; baselineBars: { t: number; v: number }[] } {
  const prior = regularSessionBars(bars5).filter((b) => b.t + 5 * 60_000 <= signalStartMs).slice(-20);
  const baseline = prior.length === 20 ? prior.reduce((a, b) => a + b.v, 0) / 20 : null;
  const value = baseline !== null && baseline > 0 && Number.isFinite(signalVolume) ? signalVolume / baseline : null;
  return { value, baseline, baselineBars: prior.map((b) => ({ t: b.t, v: b.v })) };
}

export const RB_RVOL_LABEL = 'RB current RVOL20 (signal candle included in its own SMA20) — used for eligibility';
export const TS_FORMULA_SIP_LABEL = 'TrendSpider-formula RVOL on Alpaca SIP data (volume ÷ SMA20 of the previous 20 candles) — diagnostic only';
export const TS_ACTUAL_LABEL = 'TrendSpider actual RVOL';
export const TS_ACTUAL_NOT_CAPTURED = 'NOT CAPTURED';
export const RVOL_CONDITION_LABEL = 'RVOL20 > 1.5';

export interface RvolDiagnostics {
  schema: 1;
  /** RB v1.1 live value (snapshot.values.rvol) — the value the RVOL20 > 1.5 condition used. */
  rbRvol: number | null;
  /** volume / SMA20 of the 20 completed regular-session candles before the signal candle, on Alpaca SIP data. */
  tsFormulaSipRvol: number | null;
  /** SMA20 of the 20 previous completed candles (the TrendSpider-formula denominator, on SIP data). */
  baseline: number | null;
  baselineBars: { t: number; v: number }[];
  signalVolume: number | null;
  source: 'ALPACA_SIP';
  /** Server time the diagnostic was computed (alert time; never recomputed later). */
  computedAtIso: string;
  /** TrendSpider's own RVOL: never inferred — null unless an authorised source supplied it. */
  trendspiderActual: number | null;
  trendspiderActualSource: 'NOT_CAPTURED';
}

/**
 * Alert-time RVOL diagnostics from the bars the snapshot used. Pure. Returns null when the snapshot has no values or
 * no signal candle; `tsFormulaSipRvol` is null (fail closed, never estimated) when fewer than 20 previous bars exist.
 */
export function buildRvolDiagnostics(bars5: Bar[], snapshot: SnapshotResult | null, nowIso: string): RvolDiagnostics | null {
  const v = snapshot?.values;
  const sig = snapshot?.signal;
  if (!v || !sig) return null;
  const startMs = Date.parse(sig.startIso);
  const volume = Number.isFinite(v.volume) ? v.volume : null;
  const p = volume === null ? null : tsFormulaRvol(bars5, startMs, volume);
  return {
    schema: 1,
    rbRvol: Number.isFinite(v.rvol) ? v.rvol : null,
    tsFormulaSipRvol: p?.value ?? null,
    baseline: p?.baseline ?? null,
    baselineBars: p?.baselineBars ?? [],
    signalVolume: volume,
    source: 'ALPACA_SIP',
    computedAtIso: nowIso,
    trendspiderActual: null,
    trendspiderActualSource: 'NOT_CAPTURED',
  };
}

/** True when the ONLY alert condition RB could not reproduce is RVOL20 > 1.5 (every other condition passed). */
export function isRvolOnlyMismatch(snapshot: SnapshotResult | null): boolean {
  const failed = (snapshot?.alertConditions ?? []).filter((c) => !c.pass).map((c) => c.label);
  return failed.length === 1 && failed[0] === RVOL_CONDITION_LABEL;
}

const f2 = (x: number | null | undefined) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(2) : 'not recorded');

/**
 * Explanation for an RVOL-only DATA REVIEW (text only; the decision stays DATA REVIEW REQUIRED, no ticket).
 * Values are the alert-time ones; a record processed before this diagnostic existed says "not recorded at alert time"
 * rather than being recomputed from later data.
 */
export function rvolOnlyExplanation(snapshot: SnapshotResult | null, diag: RvolDiagnostics | null | undefined, direction: string): string {
  const rb = f2(snapshot?.values?.rvol);
  const ts = diag ? f2(diag.tsFormulaSipRvol) : 'not recorded at alert time';
  return `RVOL NOT VERIFIED — TrendSpider fired the ${direction} alert (its rule set includes RVOL20 > 1.5), and every other alert condition was reproduced, but RB could not confirm RVOL20 > 1.5 on Alpaca SIP data: RB current RVOL ${rb}; TrendSpider-formula RVOL on Alpaca SIP ${ts} (diagnostic only); TrendSpider actual RVOL ${TS_ACTUAL_NOT_CAPTURED}. TrendSpider's volume data differs from Alpaca SIP, so this cannot be settled automatically — manual review; no ticket.`;
}
