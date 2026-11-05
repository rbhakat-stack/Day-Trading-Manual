/**
 * Step 3 · A — the signal candle must be FINAL before it is used, and a reconstruction that completes late must prove
 * the entry trigger was not crossed while RB was waiting.
 *
 * 2026-11-05 10:05–10:15 ET: Alpaca returned the 10:00–10:05 (and 10:05, 10:10) 5-minute bars while they still held only
 * 3–4 of their 5 minutes (volume = exact sum of the first three 1-minute bars, close = the 10:02 close). RB treated the
 * bar as complete because its start time was in the past. Every final signal candle of 2026-11-04 (83) and 2026-11-05
 * (51) equals the exact aggregate of its five 1-minute bars, with the final minute present — the check below.
 *
 * verifySignalCandle — COMPLETE only when, for the exact regular-session candle [start, start + 5 min):
 *   • the 5-minute bar exists at exactly `start`;
 *   • every 1-minute bar inside the window is on a minute boundary, and the FINAL minute (start + 4 min) is present;
 *   • the 5-minute OHLCV equals the aggregate of those 1-minute bars (first open, max high, min low, last close, Σ volume).
 * Anything else — a missing final minute, a lagging 5-minute or 1-minute series, a missing bar — is INCOMPLETE (fail
 * closed; the record is retried, never accepted).
 *
 * delayedTriggerEvidence — for a reconstruction completed on a retry: was the frozen entry reached between the signal
 * close and the reconstruction? CROSSED when a complete 1-minute bar, or any trigger-evidence print (eligible or odd lot,
 * tradeEligibility.isTriggerEvidence), is at/through the entry. NOT_CROSSED only from the COMPLETE trade record of the
 * delay; when the trades cannot be retrieved completely the answer is UNVERIFIED (fail closed — never "not crossed").
 * LONG crossed at price ≥ entry; SHORT at price ≤ entry (stop-order trigger semantics).
 */
import type { Bar } from './indicators';
import { etParts, etToEpoch } from './etTime';
import { isEligibleTrade, isTriggerEvidence, type ConditionedTrade } from './tradeEligibility';

const MIN = 60_000;
const FIVE = 5 * MIN;
const EPS = 1e-9;

export type CompletenessStatus = 'COMPLETE' | 'INCOMPLETE';
export interface CandleCompleteness {
  status: CompletenessStatus;
  startMs: number;
  endMs: number;
  label: string;
  reason: string | null;
  /** Provisional values seen (never used for a decision): the 5-minute bar as served and the 1-minute minutes present. */
  provisional: { bar5: Bar | null; minutes: string[]; agg1: { o: number; h: number; l: number; c: number; v: number } | null };
}

/** The signal candle the snapshot maps to (same rule as buildAlertSnapshot: the 5m candle completed most recently). */
export function signalWindow(alertMs: number): { startMs: number; endMs: number; label: string } | null {
  const ap = etParts(alertMs);
  const open = etToEpoch(ap.date, '09:30');
  const slotsDone = Math.floor((alertMs - open) / FIVE);
  if (slotsDone < 1) return null;
  const startMs = open + (slotsDone - 1) * FIVE;
  return { startMs, endMs: startMs + FIVE, label: `${etParts(startMs).hhmm}–${etParts(startMs + FIVE).hhmm}` };
}

export function verifySignalCandle(bars5: Bar[], bars1: Bar[], alertMs: number): CandleCompleteness {
  const w = signalWindow(alertMs);
  if (!w) return { status: 'INCOMPLETE', startMs: NaN, endMs: NaN, label: '—', reason: 'No regular-session 5-minute candle had completed.', provisional: { bar5: null, minutes: [], agg1: null } };
  const hhmm = (ms: number) => etParts(ms).hhmm;
  const bar5 = bars5.find((b) => b.t === w.startMs) ?? null;
  const inWin = bars1.filter((b) => b.t >= w.startMs && b.t < w.endMs).sort((a, b) => a.t - b.t);
  const minutes = inWin.map((b) => hhmm(b.t));
  const agg1 = inWin.length ? { o: inWin[0].o, h: Math.max(...inWin.map((b) => b.h)), l: Math.min(...inWin.map((b) => b.l)), c: inWin[inWin.length - 1].c, v: inWin.reduce((a, b) => a + b.v, 0) } : null;
  const out = (reason: string | null): CandleCompleteness => ({ status: reason ? 'INCOMPLETE' : 'COMPLETE', ...w, reason, provisional: { bar5, minutes, agg1 } });
  if (!bar5) return out(`The ${w.label} ET 5-minute candle is not yet in the market data.`);
  if (inWin.some((b) => (b.t - w.startMs) % MIN !== 0)) return out(`The ${w.label} ET 1-minute bars are not on minute boundaries.`);
  if (!inWin.some((b) => b.t === w.endMs - MIN)) return out(`The final minute (${hhmm(w.endMs - MIN)} ET) of the ${w.label} ET candle is not yet in the 1-minute data — the provider has not finished the candle (${minutes.length} of 5 minutes: ${minutes.join(', ') || 'none'}).`);
  const a = agg1!;
  const same = Math.abs(a.o - bar5.o) < EPS && Math.abs(a.h - bar5.h) < EPS && Math.abs(a.l - bar5.l) < EPS && Math.abs(a.c - bar5.c) < EPS && a.v === bar5.v;
  if (!same) return out(`The ${w.label} ET 5-minute bar (O ${bar5.o} H ${bar5.h} L ${bar5.l} C ${bar5.c} V ${bar5.v}) does not equal its 1-minute aggregate (O ${a.o} H ${a.h} L ${a.l} C ${a.c} V ${a.v}) — the provider is still updating the candle.`);
  return out(null);
}

export type GapStatus = 'NOT_CROSSED' | 'CROSSED' | 'UNVERIFIED';
export interface DelayedTriggerEvidence {
  status: GapStatus;
  direction: 'LONG' | 'SHORT';
  entry: number;
  fromIso: string;
  toIso: string;
  /** Most extreme eligible price seen toward the trigger (max for LONG, min for SHORT). */
  extreme: number | null;
  /** First evidence at / through the entry (null unless CROSSED). */
  crossedAtIso: string | null;
  crossedPrice: number | null;
  /** How the crossing was established (provenance only; null unless CROSSED). */
  crossedVia?: 'MINUTE_BAR' | 'ELIGIBLE_TRADE' | 'ODD_LOT_TRADE' | null;
  crossedConditions?: string[] | null;
  crossedTape?: string | null;
  reason: string;
}

/** "[regular F I]" — trade conditions as text (" " / "@" are a regular sale). */
export const conditionText = (c: string[] | null | undefined): string => (c?.length ? ` [${c.map((x) => (x === ' ' || x === '@' || x === '' ? 'regular' : x)).join(' ')}]` : '');

export function delayedTriggerEvidence(o: {
  direction: 'LONG' | 'SHORT';
  entry: number;
  signalEndMs: number;
  fetchedMs: number;
  bars1: Bar[];
  /** Every trade print in [signal end, fetched] as returned by the provider, or null when not retrieved completely. */
  trades: (ConditionedTrade & { t: string; p: number })[] | null;
}): DelayedTriggerEvidence {
  const L = o.direction === 'LONG';
  const base = { direction: o.direction, entry: o.entry, fromIso: new Date(o.signalEndMs).toISOString(), toIso: new Date(o.fetchedMs).toISOString() };
  const at = (p: number) => (L ? p >= o.entry : p <= o.entry);
  let extreme: number | null = null;
  const seen = (p: number) => { extreme = extreme === null ? p : L ? Math.max(extreme, p) : Math.min(extreme, p); };
  // 1) a COMPLETE 1-minute bar at/through the entry proves a crossing (minute high/low come from eligible prints)
  let barHit: { at: number; p: number } | null = null;
  for (const b of o.bars1.filter((x) => x.t >= o.signalEndMs && x.t + MIN <= o.fetchedMs).sort((x, y) => x.t - y.t)) {
    const p = L ? b.h : b.l;
    seen(p);
    if (at(p)) { barHit = { at: b.t, p }; break; }
  }
  // 2) every trade print of the delay: eligible or odd-lot prints at/through the entry are trigger evidence
  //    (tradeEligibility.isTriggerEvidence); proving NOT crossed needs the COMPLETE trade record of the delay.
  let tradeHit: { at: number; iso: string; p: number; c: string[] | null; z: string | null; eligible: boolean } | null = null;
  if (o.trades) {
    for (const t of o.trades.filter((x) => isTriggerEvidence(x) && Date.parse(x.t) >= o.signalEndMs && Date.parse(x.t) <= o.fetchedMs).sort((x, y) => Date.parse(x.t) - Date.parse(y.t))) {
      seen(t.p);
      if (at(t.p)) { tradeHit = { at: Date.parse(t.t), iso: t.t, p: t.p, c: t.c ?? null, z: t.z ?? null, eligible: isEligibleTrade(t) }; break; }
    }
  }
  const side = L ? 'high' : 'low';
  const hit = barHit && (!tradeHit || barHit.at <= tradeHit.at)
    ? { iso: new Date(barHit.at).toISOString(), p: barHit.p, via: 'MINUTE_BAR' as const, c: null, z: null, how: `the 1-minute bar ${etParts(barHit.at).hhmm}–${etParts(barHit.at + MIN).hhmm} ET reached ${barHit.p} (its ${side})` }
    : tradeHit
      ? { iso: tradeHit.iso, p: tradeHit.p, via: tradeHit.eligible ? 'ELIGIBLE_TRADE' as const : 'ODD_LOT_TRADE' as const, c: tradeHit.c, z: tradeHit.z, how: `${tradeHit.eligible ? 'an eligible trade' : 'an odd-lot trade'} at ${tradeHit.p}${conditionText(tradeHit.c)} printed at ${etParts(tradeHit.at).hhmmss} ET` }
      : null;
  if (hit) return { status: 'CROSSED', ...base, extreme, crossedAtIso: hit.iso, crossedPrice: hit.p, crossedVia: hit.via, crossedConditions: hit.c, crossedTape: hit.z, reason: `${hit.how}, at or through the ${o.entry} entry, during the delayed reconstruction.` };
  if (!o.trades) return { status: 'UNVERIFIED', ...base, extreme, crossedAtIso: null, crossedPrice: null, reason: `The trades between ${etParts(o.signalEndMs).hhmmss} and ${etParts(o.fetchedMs).hhmmss} ET could not be retrieved completely — whether the ${o.entry} trigger was reached during the delay cannot be proven.` };
  return { status: 'NOT_CROSSED', ...base, extreme, crossedAtIso: null, crossedPrice: null, reason: `The ${o.entry} entry was not reached between ${etParts(o.signalEndMs).hhmmss} and ${etParts(o.fetchedMs).hhmmss} ET (every trade print of the delay checked, odd lots included).` };
}
