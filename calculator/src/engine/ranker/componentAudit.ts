/**
 * CR-14 — label consistency and the Location/Extension audit, as a DISPLAY layer over the RB v1.1 scorer.
 *
 * The RB v1.1 ranker output is golden (byte-for-byte unchanged), so its component `summary` strings are not edited.
 * Instead the UI shows `displaySummary()`, which names the band that actually produced the points (e.g. RSI 9/10 is
 * "Strong momentum", never "Moderate momentum"), and `locationAudit()`, which exposes every value behind the
 * Location/Extension points. Points are never computed for scoring here: `locationAudit().points` is only a cross-check
 * and a test asserts it equals the scorer's points.
 */
import { clean } from '../rounding';
import type { Candidate, ComponentScore } from './opportunityTypes';
import { RANKER_DEFAULTS, type RankerSettings } from './rankerSettings';

export interface LocationAudit {
  direction: 'LONG' | 'SHORT';
  price: number;
  vwap: number;
  ema20: number;
  ema9: number;
  atr: number;
  /** Which structure level set the extension (the larger of the two). */
  anchor: 'VWAP' | 'EMA20';
  /** d × (price − anchor), unrounded dollars. */
  numerator: number;
  dVwapAtr: number;
  dEma20Atr: number;
  dEma9Atr: number;
  /** MAX(dVWAP, dEMA20) in ATR. */
  extensionAtr: number;
  band: string;
  bandPoints: number;
  bandLabel: string;
  ema9Deduction: number;
  chaseDeduction: number;
  points: number;
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Location/Extension audit — the same documented formula as the RB v1.1 scorer (see scoreLocation). */
export function locationAudit(c: Candidate): LocationAudit | null {
  const { vwap, ema9, ema20 } = c.inputs;
  if (!isNum(vwap) || !isNum(ema9) || !isNum(ema20) || !(c.atr > 0) || !isNum(c.currentPrice)) return null;
  const d = c.direction === 'LONG' ? 1 : -1;
  const A = c.atr;
  const dV = clean((d * (c.currentPrice - vwap)) / A);
  const d20 = clean((d * (c.currentPrice - ema20)) / A);
  const d9 = clean((d * (c.currentPrice - ema9)) / A);
  const ext = Math.max(dV, d20);
  const [band, bandPoints, bandLabel] =
    ext < 0 ? ['< 0', 4, 'Wrong side of VWAP/EMA20']
    : ext <= 1.0 ? ['≤ 1.0', 10, 'Near structure']
    : ext <= 1.5 ? ['≤ 1.5', 9, 'Near structure']
    : ext <= 2.0 ? ['≤ 2.0', 7, 'Somewhat stretched']
    : ext <= 2.5 ? ['≤ 2.5', 5, 'Stretched']
    : ext <= 3.5 ? ['≤ 3.5', 3, 'Very extended']
    : ['> 3.5', 1, 'Over-extended'];
  const ema9Deduction = d9 > 1.0 ? 1 : 0;
  const chase = c.chaseDistanceAtr ?? 0;
  const chaseDeduction = chase > 0 ? Math.round(8 * chase) : 0;
  const anchor = dV >= d20 ? 'VWAP' : 'EMA20';
  return {
    direction: c.direction, price: c.currentPrice, vwap, ema20, ema9, atr: A, anchor,
    numerator: d * (c.currentPrice - (anchor === 'VWAP' ? vwap : ema20)),
    dVwapAtr: dV, dEma20Atr: d20, dEma9Atr: d9, extensionAtr: ext, band: band as string, bandPoints: bandPoints as number, bandLabel: bandLabel as string,
    ema9Deduction, chaseDeduction, points: Math.max(0, Math.min(10, (bandPoints as number) - ema9Deduction - chaseDeduction)),
  };
}

/** The label the UI shows for a component: consistent with the points awarded (RB v1.1 points unchanged). */
export function displaySummary(comp: ComponentScore, c: Candidate, s: Readonly<RankerSettings> = RANKER_DEFAULTS): string {
  if (comp.na || comp.missing) return comp.summary;
  if (comp.key === 'momentum') {
    const top = Math.max(...s.rsiBandsLong.map((b) => b.points));
    const base = comp.max > 0 ? (comp.points * 10) / comp.max : 0; // back to the 0–10 band scale
    if (comp.summary === 'Moderate momentum' && base >= 0.8 * top) return 'Strong momentum';
    return comp.summary;
  }
  if (comp.key === 'location') {
    const a = locationAudit(c);
    if (!a) return comp.summary;
    const ded = [a.ema9Deduction ? 'stretched from EMA9' : '', a.chaseDeduction ? 'beyond the entry' : ''].filter(Boolean);
    return ded.length ? `${a.bandLabel} · ${ded.join(', ')}` : a.bandLabel;
  }
  return comp.summary;
}
