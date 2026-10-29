/**
 * Opportunity scoring — every formula is explicit; nothing is hidden or subjective.
 *
 * Each component first computes BASE points on its default scale (see DEFAULT_MAX),
 * then scales to the configured weight:   points = round1(base × weight ÷ defaultMax)
 * With default weights the scale factor is 1, so points are whole numbers.
 *
 * All distances are normalised by the 5-minute ATR so a $20 stock and a $400 stock
 * are judged on the same scale. LONG/SHORT are handled with a direction sign d:
 *   d = +1 for LONG, −1 for SHORT;  "aligned distance" = d × (A − B) ÷ ATR
 *
 * ⚠ All bands and weights are RB v1 PAPER-TESTING ASSUMPTIONS, not proven relationships.
 */
import { clean } from '../rounding';
import { assessCorrelation, type Classified } from './correlationRules';
import { checkFit, type PortfolioSnapshot } from './portfolioAllocator';
import { COMPONENT_LABELS, type Candidate, type ComponentKey, type ComponentScore } from './opportunityTypes';
import { DEFAULT_MAX, toMinutes, type RankerSettings } from './rankerSettings';

const round1 = (x: number) => Math.round(x * 10) / 10;
const f2 = (x: number) => x.toFixed(2);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function make(
  key: ComponentKey,
  base: number,
  s: RankerSettings,
  parts: { summary: string; calc: string[]; positives?: string[]; negatives?: string[]; missing?: boolean },
): ComponentScore {
  const max = s.weights[key];
  const points = round1((Math.max(0, Math.min(base, DEFAULT_MAX[key])) * max) / DEFAULT_MAX[key]);
  return {
    key,
    label: COMPONENT_LABELS[key],
    points,
    max,
    summary: parts.summary,
    calc: [...parts.calc, `Base ${base}/${DEFAULT_MAX[key]} × (weight ${max} ÷ ${DEFAULT_MAX[key]}) = ${points}`],
    positives: parts.positives ?? [],
    negatives: parts.negatives ?? [],
    missing: parts.missing,
  };
}

const missing = (key: ComponentKey, s: RankerSettings, what: string) =>
  make(key, 0, s, { summary: `Missing input: ${what}`, calc: [`Cannot score without ${what}.`], negatives: [`${what} not entered`], missing: true });

const dirSign = (c: Candidate) => (c.direction === 'LONG' ? 1 : -1);

/* ─────────────── 1. Trend alignment (15) ─────────────── */
/**
 * sep  = d × (EMA9 − EMA20) ÷ ATR            → ≤0: 0 · <0.10: 1 · <0.25: 3 · <0.50: 5 · ≥0.50: 6
 * p20  = d × (Price − EMA20) ÷ ATR           → ≤0: 0 · <0.25: 1 · <0.75: 3 · ≥0.75: 4
 * t15  = d × (15m Close − 15m EMA20) ÷ ATR   → ≤0: 0 · <0.25: 2 · <0.75: 4 · ≥0.75: 5
 * base = sep + p20 + t15 (max 15). If price is on the wrong side of VWAP, EMAs are not
 * aligned, or the 15m trend disagrees, base is capped at 4 (marginal).
 * (15m distance uses the 5m ATR because the 15m ATR is not an input.)
 */
export function scoreTrend(c: Candidate, s: RankerSettings): ComponentScore {
  const { vwap, ema9, ema20, close15m, ema20_15m } = c.inputs;
  if (![vwap, ema9, ema20, close15m, ema20_15m].every(isNum) || !(c.atr > 0)) return missing('trend', s, 'VWAP, EMA9, EMA20, 15m Close and 15m EMA20');
  const d = dirSign(c);
  const A = c.atr;
  const sep = clean((d * ((ema9 as number) - (ema20 as number))) / A);
  const p20 = clean((d * (c.currentPrice - (ema20 as number))) / A);
  const vw = clean((d * (c.currentPrice - (vwap as number))) / A);
  const t15 = clean((d * ((close15m as number) - (ema20_15m as number))) / A);
  const sepPts = sep <= 0 ? 0 : sep < 0.1 ? 1 : sep < 0.25 ? 3 : sep < 0.5 ? 5 : 6;
  const p20Pts = p20 <= 0 ? 0 : p20 < 0.25 ? 1 : p20 < 0.75 ? 3 : 4;
  const t15Pts = t15 <= 0 ? 0 : t15 < 0.25 ? 2 : t15 < 0.75 ? 4 : 5;
  let base = sepPts + p20Pts + t15Pts;
  const misaligned = vw <= 0 || sep <= 0 || t15 <= 0;
  if (misaligned) base = Math.min(base, 4);
  const pos: string[] = [];
  const neg: string[] = [];
  if (sep >= 0.25) pos.push(`Clear EMA9/EMA20 separation (${f2(sep)} ATR)`);
  else if (sep > 0) neg.push(`EMA9/EMA20 compressed (${f2(sep)} ATR)`);
  if (t15 >= 0.25) pos.push(`15m trend confirms (${f2(t15)} ATR beyond 15m EMA20)`);
  else if (t15 > 0) neg.push(`15m confirmation is marginal (${f2(t15)} ATR)`);
  if (misaligned) neg.push('Trend not fully aligned (VWAP / EMA / 15m) — capped at marginal');
  const label = base >= 13 ? 'Very clean alignment' : base >= 9 ? 'Good alignment, modest separation' : base >= 5 ? 'Aligned but compressed' : 'Choppy / marginal';
  return make('trend', base, s, {
    summary: label,
    calc: [
      `sep = d×(EMA9−EMA20)÷ATR = ${f2(sep)} → ${sepPts}/6`,
      `p20 = d×(Price−EMA20)÷ATR = ${f2(p20)} → ${p20Pts}/4`,
      `t15 = d×(15m Close−15m EMA20)÷ATR = ${f2(t15)} → ${t15Pts}/5`,
      `VWAP side d×(Price−VWAP)÷ATR = ${f2(vw)}${misaligned ? ' → misaligned, base capped at 4' : ''}`,
    ],
    positives: pos,
    negatives: neg,
  });
}

/* ─────────────── 2. Relative volume (15) ─────────────── */
export function rvolBand(rvol: number, s: RankerSettings) {
  let band: (typeof s.rvolBands)[number] | null = null;
  for (const b of s.rvolBands) if (rvol >= b.min) band = b;
  return band;
}

export function scoreRvol(c: Candidate, s: RankerSettings): ComponentScore {
  const r = c.inputs.rvol;
  if (!isNum(r)) return missing('rvol', s, 'RVOL(20)');
  const band = rvolBand(r, s);
  const base = band?.points ?? 0;
  const label = band?.label ?? 'BELOW ALERT THRESHOLD';
  return make('rvol', base, s, {
    summary: `RVOL ${f2(r)} — ${label}`,
    calc: [`RVOL ${f2(r)} → band ${band ? `≥ ${band.min}` : `< ${s.rvolBands[0]?.min ?? 0}`} = ${base}/15`],
    positives: base >= 12 ? [`RVOL ${f2(r)} indicates ${label.toLowerCase()} participation`] : [],
    negatives: base < 9 ? [`RVOL ${f2(r)} is only ${label.toLowerCase()} participation`] : [],
  });
}

/* ─────────────── 3. Momentum quality (10) ─────────────── */
/** LONG uses RSI directly; SHORT uses the mirror 100 − RSI on the same bands. Bands are [from, to). */
export function scoreMomentum(c: Candidate, s: RankerSettings): ComponentScore {
  const rsi = c.inputs.rsi;
  if (!isNum(rsi)) return missing('momentum', s, 'RSI(14)');
  const eff = c.direction === 'LONG' ? rsi : 100 - rsi;
  const band = s.rsiBandsLong.find((b) => eff >= b.from && eff < b.to);
  const base = band?.points ?? 0;
  const top = Math.max(...s.rsiBandsLong.map((b) => b.points));
  const exhausted = band && band.points < top && eff >= (s.rsiBandsLong.find((b) => b.points === top)?.to ?? 101);
  const pos = base === top ? [`RSI ${rsi.toFixed(1)} shows strong but not extreme momentum`] : [];
  const neg: string[] = [];
  if (!band) neg.push(`RSI ${rsi.toFixed(1)} is outside the RB v1 ${c.direction} momentum range`);
  else if (exhausted) neg.push(`RSI ${rsi.toFixed(1)} is extended — exhaustion risk`);
  else if (base < top) neg.push(`RSI ${rsi.toFixed(1)} is moderate momentum`);
  return make('momentum', base, s, {
    summary: band ? (exhausted ? 'Extended momentum' : base === top ? 'Strong, not exhausted' : 'Moderate momentum') : 'Outside range',
    calc: [
      c.direction === 'LONG' ? `RSI ${rsi.toFixed(1)}` : `SHORT mirror: 100 − ${rsi.toFixed(1)} = ${eff.toFixed(1)}`,
      band ? `band [${band.from}, ${band.to}) = ${base}/10` : 'no band → 0/10',
    ],
    positives: pos,
    negatives: neg,
  });
}

/* ─────────────── 4. Signal candle quality (10) ─────────────── */
export interface CandleMetrics {
  range: number;
  body: number;
  bodyRatio: number;
  upperWick: number;
  lowerWick: number;
  opposingWickRatio: number; // LONG: upper wick ÷ range; SHORT: lower wick ÷ range
  closeLocation: number; // LONG: (C − L) ÷ range; SHORT: (H − C) ÷ range
  directional: boolean; // LONG: green; SHORT: red
  classification: 'Strong Breakout Candle' | 'Acceptable' | 'Weak' | 'Rejection Risk';
  base: number;
}

/**
 * Directional candle:  base = ROUND(10 × (0.5 × BodyRatio + 0.5 × CloseLocation))
 * Opposing wick ≥ 50% of range: base = 2 (rejection)
 * Wrong-colour / doji candle: base = MIN(2, ROUND(2 × CloseLocation))
 * Zero range: 0.
 * Classes: ≥9 Strong Breakout · 6–8 Acceptable · 3–5 Weak · 0–2 Rejection Risk
 */
export function candleMetrics(c: Pick<Candidate, 'open' | 'high' | 'low' | 'close' | 'direction'>): CandleMetrics {
  const { open: O, high: H, low: L, close: C } = c;
  const range = clean(H - L);
  const body = clean(Math.abs(C - O));
  const upperWick = clean(H - Math.max(O, C));
  const lowerWick = clean(Math.min(O, C) - L);
  const LONG = c.direction === 'LONG';
  const directional = LONG ? C > O : C < O;
  if (range <= 0) {
    return { range, body, bodyRatio: 0, upperWick, lowerWick, opposingWickRatio: 0, closeLocation: 0, directional, classification: 'Rejection Risk', base: 0 };
  }
  const bodyRatio = clean(body / range);
  const opposingWickRatio = clean((LONG ? upperWick : lowerWick) / range);
  const closeLocation = clean(LONG ? (C - L) / range : (H - C) / range);
  let base: number;
  if (!directional) base = Math.min(2, Math.round(2 * closeLocation));
  else if (opposingWickRatio >= 0.5) base = 2;
  else base = Math.round(10 * (0.5 * bodyRatio + 0.5 * closeLocation));
  const classification = base >= 9 ? 'Strong Breakout Candle' : base >= 6 ? 'Acceptable' : base >= 3 ? 'Weak' : 'Rejection Risk';
  return { range, body, bodyRatio, upperWick, lowerWick, opposingWickRatio, closeLocation, directional, classification, base };
}

export function scoreCandle(c: Candidate, s: RankerSettings): ComponentScore {
  const m = candleMetrics(c);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const pos: string[] = [];
  const neg: string[] = [];
  if (m.base >= 9) pos.push(`Signal candle has a large body (${pct(m.bodyRatio)}) and closes near its ${c.direction === 'LONG' ? 'high' : 'low'}`);
  if (!m.directional) neg.push(`Signal candle is not ${c.direction === 'LONG' ? 'green' : 'red'} (indecision)`);
  else if (m.opposingWickRatio >= 0.5) neg.push(`Large opposing wick (${pct(m.opposingWickRatio)} of range) — rejection risk`);
  else if (m.base < 6) neg.push(`Weak body (${pct(m.bodyRatio)} of range)`);
  return make('candle', m.base, s, {
    summary: m.classification,
    calc: [
      `Range = H − L = ${f2(m.range)}; Body = |C − O| = ${f2(m.body)}; Body ratio = ${f2(m.bodyRatio)}`,
      `Upper wick = ${f2(m.upperWick)}; Lower wick = ${f2(m.lowerWick)}; Opposing wick ratio = ${f2(m.opposingWickRatio)}`,
      `Close location = ${f2(m.closeLocation)} (1 = at the favourable extreme)`,
      m.range <= 0
        ? 'Zero range → 0'
        : !m.directional
          ? `Not directional → MIN(2, ROUND(2 × ${f2(m.closeLocation)})) = ${m.base}`
          : m.opposingWickRatio >= 0.5
            ? 'Opposing wick ≥ 50% → 2'
            : `ROUND(10 × (0.5 × ${f2(m.bodyRatio)} + 0.5 × ${f2(m.closeLocation)})) = ${m.base}`,
    ],
    positives: pos,
    negatives: neg,
  });
}

/* ─────────────── 5. Location / extension (10) ─────────────── */
/**
 * dV = d×(Price − VWAP)÷ATR; d20 = d×(Price − EMA20)÷ATR; d9 = d×(Price − EMA9)÷ATR
 * ext = MAX(dV, d20) → <0: 4 · ≤1.0: 10 · ≤1.5: 9 · ≤2.0: 7 · ≤2.5: 5 · ≤3.5: 3 · >3.5: 1
 * −1 if d9 > 1.0 ATR (stretched from the fast average)
 * −ROUND(8 × chase ATR) if price is already beyond the planned entry (late entry; max 2 at 0.25 ATR)
 */
export function scoreLocation(c: Candidate, s: RankerSettings): ComponentScore {
  const { vwap, ema9, ema20 } = c.inputs;
  if (![vwap, ema9, ema20].every(isNum) || !(c.atr > 0)) return missing('location', s, 'VWAP, EMA9 and EMA20');
  const d = dirSign(c);
  const A = c.atr;
  const dV = clean((d * (c.currentPrice - (vwap as number))) / A);
  const d20 = clean((d * (c.currentPrice - (ema20 as number))) / A);
  const d9 = clean((d * (c.currentPrice - (ema9 as number))) / A);
  const ext = Math.max(dV, d20);
  let base = ext < 0 ? 4 : ext <= 1.0 ? 10 : ext <= 1.5 ? 9 : ext <= 2.0 ? 7 : ext <= 2.5 ? 5 : ext <= 3.5 ? 3 : 1;
  const calc = [`dVWAP = ${f2(dV)} ATR; dEMA20 = ${f2(d20)} ATR; dEMA9 = ${f2(d9)} ATR`, `ext = MAX(dVWAP, dEMA20) = ${f2(ext)} → ${base}`];
  const neg: string[] = [];
  const pos: string[] = [];
  if (d9 > 1.0) {
    base -= 1;
    calc.push('dEMA9 > 1.0 ATR → −1');
    neg.push(`Price ${f2(d9)} ATR from EMA9 — stretched`);
  }
  const chase = c.chaseDistanceAtr ?? 0;
  if (chase > 0) {
    const ded = Math.round(8 * chase);
    base -= ded;
    calc.push(`Already ${f2(chase)} ATR beyond entry → −${ded}`);
    if (ded > 0) neg.push(`Price already ${f2(chase)} ATR beyond the planned entry`);
  }
  base = Math.max(0, Math.min(10, base));
  if (ext > 2.0) neg.push(`Extended ${f2(ext)} ATR from VWAP/EMA20`);
  if (base >= 9) pos.push(`Entry is not significantly extended (${f2(ext)} ATR from structure)`);
  const label = base >= 9 ? 'Near structure' : base >= 6 ? 'Somewhat stretched' : base >= 3 ? 'Very extended' : 'Chasing / poor location';
  return make('location', base, s, { summary: label, calc, positives: pos, negatives: neg });
}

/* ─────────────── 6. Time of day (10) ─────────────── */
/**
 * Time buckets score ONLY times inside the entry window. Outside the window the time is a hard fail
 * (rules.ts checkTimeWindow) and never receives time points. Before the first bucket → null.
 */
export function timeBucketFor(alertTime: string, s: RankerSettings) {
  const t = toMinutes(alertTime);
  if (!Number.isFinite(t)) return null;
  let bucket: (typeof s.timeBuckets)[number] | null = null;
  for (const b of s.timeBuckets) if (toMinutes(b.start) <= t) bucket = b;
  return bucket;
}

export function scoreTime(c: Candidate, s: RankerSettings): ComponentScore {
  const b = timeBucketFor(c.alertTime, s);
  if (!b) return missing('time', s, 'alert time inside the entry window');
  return make('time', b.points, s, {
    summary: b.label,
    calc: [`Alert ${c.alertTime} ET → "${b.label}" = ${b.points}/10`],
    positives: b.points >= 10 ? ['Alert in the primary trading window'] : [],
    negatives: b.points <= 6 ? [`Alert during ${b.label.toLowerCase()}`] : [],
  });
}

/* ─────────────── 7. Capital efficiency (10) ─────────────── */
/**
 * Efficiency = Expected gross reward ÷ Position value (a rough planning ratio, NOT a return forecast).
 * With ≥ minCandidatesForRelative peers: percentile p (ties share the average rank),
 *   base = ROUND(2 + 8 × p).   Otherwise neutral base = 6.
 */
export function scoreCapitalEfficiency(c: Candidate, peerEfficiencies: number[], available: number, s: RankerSettings): ComponentScore {
  if (!(c.positionValue > 0)) return missing('capitalEfficiency', s, 'position value');
  const eff = clean(c.expectedReward / c.positionValue);
  const reqPct = available > 0 ? c.positionValue / available : Infinity;
  const n = peerEfficiencies.length;
  let base: number;
  const calc = [`Efficiency = ${c.expectedReward.toFixed(2)} ÷ ${c.positionValue.toFixed(2)} = ${(eff * 100).toFixed(3)}%`, `Capital required = ${Number.isFinite(reqPct) ? (reqPct * 100).toFixed(1) : '∞'}% of available`];
  if (n < s.minCandidatesForRelative) {
    base = 6;
    calc.push(`Only ${n} candidate(s) (< ${s.minCandidatesForRelative}) → neutral 6/10`);
  } else {
    const less = peerEfficiencies.filter((x) => x < eff - 1e-12).length;
    const equal = peerEfficiencies.filter((x) => Math.abs(x - eff) <= 1e-12).length;
    const p = (less + 0.5 * (equal - 1)) / (n - 1);
    base = Math.round(2 + 8 * p);
    calc.push(`Percentile among ${n} candidates = ${p.toFixed(2)} → ROUND(2 + 8 × ${p.toFixed(2)}) = ${base}`);
  }
  return make('capitalEfficiency', base, s, {
    summary: `${(eff * 100).toFixed(2)}% planned reward per $ deployed`,
    calc,
    positives: base >= 8 ? ['Comparable reward with less capital than peers'] : [],
    negatives: base <= 4 ? ['Ties up more capital per dollar of planned reward than peers'] : [],
  });
}

/* ─────────────── 8. Capital availability (8) ─────────────── */
/** Does not fit (capital, slot or max size) → 0 · uses ≤ 50% of available → 8 · ≤ 80% → 5 · otherwise → 2 */
export function scoreCapitalAvailability(c: Candidate, pf: PortfolioSnapshot, s: RankerSettings): ComponentScore {
  const fit = checkFit(asClassified(c), pf, s, { maxPositions: pf.maxPositions, heatLimit: pf.heatLimit, maxPositionValue: pf.maxPositionValue });
  const used = pf.available > 0 ? c.positionValue / pf.available : Infinity;
  const fits = fit.capitalOk && fit.slotOk && fit.sizeOk;
  const base = !fits ? 0 : used <= 0.5 ? 8 : used <= 0.8 ? 5 : 2;
  const calc = [
    `Requires ${usd(c.positionValue)} of ${usd(pf.available)} available (${Number.isFinite(used) ? (used * 100).toFixed(1) : '∞'}%)`,
    `Slots ${pf.slotsUsed}/${pf.maxPositions} used · max single position ${usd(pf.maxPositionValue)}`,
  ];
  const neg: string[] = [];
  if (!fit.slotOk) neg.push(`All ${pf.maxPositions} position slots are in use`);
  if (!fit.capitalOk) neg.push(`Needs ${usd(c.positionValue)} but only ${usd(pf.available)} is allocatable`);
  if (!fit.sizeOk) neg.push(`Position ${usd(c.positionValue)} exceeds the ${usd(pf.maxPositionValue)} maximum`);
  if (fits && used > 0.8) neg.push(`Position consumes ${(used * 100).toFixed(0)}% of currently allocatable capital`);
  return make('capitalAvailability', base, s, {
    summary: fits ? `Uses ${(used * 100).toFixed(0)}% of available capital` : 'Does not fit',
    calc,
    positives: base === 8 ? [`Position requires only ${usd(c.positionValue)} (${(used * 100).toFixed(0)}% of available)`] : [],
    negatives: neg,
  });
}

/* ─────────────── 9. Correlation / diversification (7) ─────────────── */
export function scoreCorrelation(c: Candidate, pf: PortfolioSnapshot, s: RankerSettings): ComponentScore {
  if (!c.inputs.sector.trim()) return missing('correlation', s, 'sector');
  const a = assessCorrelation(asClassified(c), pf.exposures, s.correlation);
  const theme = c.inputs.industry || c.inputs.theme || c.inputs.sector;
  const neg: string[] = [];
  if (a.blocked) neg.push(`CORRELATED EXPOSURE with ${a.highWith.join(', ')} (${theme})`);
  else if (a.level === 'HIGH') neg.push(`High thematic overlap with ${a.highWith.join(', ')}`);
  else if (a.level === 'SECTOR') neg.push(`Same sector as ${a.sectorWith.join(', ')}`);
  return make('correlation', a.basePoints, s, {
    summary: a.blocked ? 'Blocked — correlated' : a.level === 'HIGH' ? 'High overlap' : a.level === 'SECTOR' ? 'Some sector overlap' : 'No material overlap',
    calc: [
      `HIGH overlaps${s.correlation.allowOppositeDirection ? ' (same direction)' : ' (either direction)'}: ${a.highWith.join(', ') || 'none'}; sector overlaps: ${a.sectorWith.join(', ') || 'none'}`,
      `Policy: max ${s.correlation.maxHighlyCorrelated} highly correlated position(s) per theme${s.correlation.hardBlock ? ' (hard block)' : ''}`,
      ...(a.oppositeWith.length ? [`Opposite-direction overlap (treated as hedged by setting): ${a.oppositeWith.join(', ')}`] : []),
    ],
    positives: a.level === 'NONE' ? [`No conflicting ${c.inputs.industry || c.inputs.sector} exposure`] : [],
    negatives: neg,
  });
}

/* ─────────────── 10. Portfolio risk capacity (5) ─────────────── */
/** projected = committed heat + new risk; ratio = projected ÷ limit → >1: 0 · ≤0.50: 5 · ≤0.75: 4 · ≤0.90: 3 · ≤1: 2 */
export function scorePortfolioRisk(c: Candidate, pf: PortfolioSnapshot, s: RankerSettings): ComponentScore {
  const projected = clean(pf.heatCommitted + c.plannedRisk);
  const ratio = pf.heatLimit > 0 ? projected / pf.heatLimit : Infinity;
  const base = ratio > 1 + 1e-9 ? 0 : ratio <= 0.5 ? 5 : ratio <= 0.75 ? 4 : ratio <= 0.9 ? 3 : 2;
  return make('portfolioRisk', base, s, {
    summary: `Projected heat ${usd(projected)} / ${usd(pf.heatLimit)}`,
    calc: [`Committed heat ${usd(pf.heatCommitted)} + new risk ${usd(c.plannedRisk)} = ${usd(projected)} → ${(ratio * 100).toFixed(0)}% of limit`],
    positives: base >= 4 ? ['Portfolio heat remains well below limit'] : [],
    negatives: base === 0 ? [`Would exceed the ${usd(pf.heatLimit)} portfolio heat limit`] : base <= 2 ? ['Uses most of the remaining heat budget'] : [],
  });
}

/* ─────────────── helpers ─────────────── */
export function asClassified(c: Candidate): Classified & { positionValue: number; plannedRisk: number } {
  return {
    ticker: c.ticker, direction: c.direction, sector: c.inputs.sector, industry: c.inputs.industry, theme: c.inputs.theme,
    positionValue: c.positionValue, plannedRisk: c.plannedRisk,
  };
}

function usd(v: number) {
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
