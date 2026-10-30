/**
 * Automated alert → Opportunity Ranker candidate, using ONLY the shared engine (evaluateTrade). No formula is
 * re-implemented here.
 *
 *  • candidateFromRecord(): builds the candidate once. Entry, stop, target, quantity, planned risk and the ranking
 *    inputs are taken from the FROZEN alert-time snapshot and never change afterwards.
 *  • liveState(): re-runs the same calculator with the CURRENT price and alert age to get the dynamic state
 *    (waiting for breakout, trigger crossed / late entry, chased, stale). It never rewrites alert-time values.
 */
import type { Candidate } from '../ranker/opportunityTypes';
import type { RbSettings } from '../settings';
import { evaluateTrade, type TradeInputs, type TradeResult } from '../tradeCalculator';
import type { AutoAlertRecord } from './alertDecision';
import { etParts } from './etTime';

export interface Classification {
  sector: string;
  industry: string;
  theme: string;
}

/** Calculator inputs from the frozen snapshot. Returns null when the snapshot is not complete (fail closed). */
export function inputsFromRecord(rec: AutoAlertRecord, currentPrice: number, now: number, s: RbSettings): TradeInputs | null {
  const v = rec.snapshot?.values;
  if (!v || rec.status !== 'OK') return null;
  return {
    ticker: rec.alert.symbol,
    direction: rec.alert.direction,
    open: v.open,
    high: v.high,
    low: v.low,
    close: v.close,
    atr: v.atr,
    currentPrice,
    investmentAmount: s.investmentCap,
    accountEquity: s.accountEquity,
    riskPct: s.riskPct,
    alertTime: etParts(rec.alert.alertTimeMs).hhmm,
    close15m: v.close15m,
    ema20_15m: v.ema20_15m,
    minutesSinceAlert: Math.max(0, (now - rec.alert.alertTimeMs) / 60_000),
    hasOpenPosition: false, // same-ticker exposure is checked by the ranker against the real portfolio
  };
}

export function liveState(rec: AutoAlertRecord, currentPrice: number, now: number, s: RbSettings): TradeResult | null {
  const i = inputsFromRecord(rec, currentPrice, now, s);
  return i ? evaluateTrade(i, s) : null;
}

/** Dynamic candidate fields from a live evaluation (current price, age, calculator state). */
export function livePatch(r: TradeResult, currentPrice: number): Partial<Candidate> {
  return {
    currentPrice,
    calcAction: r.action,
    calcReady: r.ready,
    calcHardFails: r.hardFails,
    chaseDistanceAtr: r.chase?.distanceAtr ?? null,
    minutesSinceAlert: r.minutesSinceAlert,
  };
}

export function candidateFromRecord(rec: AutoAlertRecord, currentPrice: number, now: number, s: RbSettings, cls: Classification | null): Candidate | null {
  const v = rec.snapshot?.values;
  const r = liveState(rec, currentPrice, now, s);
  if (!v || !r || !r.plan) return null;
  const p = r.plan; // the TRIGGER plan (stop-order breakout) — the only plan the automated path ever proposes
  const et = etParts(rec.alert.alertTimeMs);
  return {
    id: rec.id,
    source: 'AUTO',
    alertMs: rec.alert.alertTimeMs,
    date: et.date,
    alertTime: et.hhmm,
    createdAt: rec.receivedMs,
    ticker: rec.alert.symbol,
    direction: rec.alert.direction,
    open: v.open,
    high: v.high,
    low: v.low,
    close: v.close,
    atr: v.atr,
    entry: p.entry,
    stop: p.stop,
    target: p.target,
    shares: p.shares,
    positionValue: p.positionValue,
    plannedRisk: p.maxLoss,
    expectedReward: p.potentialProfit,
    orderType: p.orderType,
    rulesVersion: rec.versions.rules,
    inputs: {
      rvol: v.rvol,
      rsi: v.rsi,
      vwap: v.vwap,
      ema9: v.ema9,
      ema20: v.ema20,
      close15m: v.close15m,
      ema20_15m: v.ema20_15m,
      sector: cls?.sector ?? '',
      industry: cls?.industry ?? '',
      theme: cls?.theme ?? '',
    },
    scored: true,
    status: 'NEW',
    initialScore: null,
    entryScore: null,
    finalScore: null,
    actualFill: null,
    exitPrice: null,
    notes: `Automated alert ${rec.alert.alertName} · ${rec.provider.name} (${rec.provider.feed})`,
    archived: false,
    keptAgainst: [],
    ...livePatch(r, currentPrice),
  } as Candidate;
}
