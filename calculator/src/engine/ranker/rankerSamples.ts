/**
 * Sample data so the ranker can be understood immediately (spec §58).
 * Execution numbers come from the real Trade Calculator engine (planTrigger), so they are consistent.
 * Ranking inputs (RVOL, RSI, VWAP, EMAs, 15m) are ILLUSTRATIVE mock values, not market data.
 */
import { planTrigger, type Direction, type TradeInputs } from '../tradeCalculator';
import { RB_V1_DEFAULTS } from '../settings';
import { RULES_VERSION } from '../rules';
import { KNOWN_CLASSIFICATIONS } from './correlationRules';
import { rankCandidates, snapshotOf } from './candidateRanker';
import type { Candidate, LifecycleStatus, ManualPosition, RankingInputs } from './opportunityTypes';
import type { RankerSettings } from './rankerSettings';

interface Spec {
  ticker: string;
  direction: Direction;
  o: number; h: number; l: number; c: number; atr: number; price: number;
  rvol: number; rsi: number; vwap: number; ema9: number; ema20: number; close15m: number; ema20_15m: number;
  alertTime: string;
  status: LifecycleStatus;
  exitPrice?: number;
}

export function emptyInputs(ticker = ''): RankingInputs {
  const k = KNOWN_CLASSIFICATIONS[ticker.toUpperCase()];
  return { rvol: null, rsi: null, vwap: null, ema9: null, ema20: null, close15m: null, ema20_15m: null, sector: k?.sector ?? '', industry: k?.industry ?? '', theme: k?.theme ?? '' };
}

function build(sp: Spec, date: string, createdAt: number): Candidate {
  const ti: TradeInputs = {
    ticker: sp.ticker, direction: sp.direction, open: sp.o, high: sp.h, low: sp.l, close: sp.c, atr: sp.atr,
    currentPrice: sp.price, investmentAmount: RB_V1_DEFAULTS.investmentCap, accountEquity: 100000, riskPct: 0.0025,
    minutesSinceAlert: 2, hasOpenPosition: false, alertTime: sp.alertTime, close15m: sp.close15m, ema20_15m: sp.ema20_15m,
  };
  const p = planTrigger(ti);
  const chase = sp.direction === 'LONG' ? sp.price - p.entry : p.entry - sp.price;
  return {
    id: `sample-${date}-${sp.ticker}`,
    date,
    alertTime: sp.alertTime,
    createdAt,
    ticker: sp.ticker,
    direction: sp.direction,
    open: sp.o, high: sp.h, low: sp.l, close: sp.c, atr: sp.atr, currentPrice: sp.price,
    entry: p.entry, stop: p.stop, target: p.target, shares: p.shares, positionValue: p.positionValue,
    plannedRisk: p.maxLoss, expectedReward: p.potentialProfit, orderType: p.orderType,
    calcAction: sp.direction === 'LONG' ? 'BUY_STOP' : 'SELL_STOP',
    calcReady: true,
    calcHardFails: [],
    rulesVersion: RULES_VERSION,
    chaseDistanceAtr: Math.round((chase / sp.atr) * 1e4) / 1e4,
    minutesSinceAlert: 2,
    inputs: { ...emptyInputs(sp.ticker), rvol: sp.rvol, rsi: sp.rsi, vwap: sp.vwap, ema9: sp.ema9, ema20: sp.ema20, close15m: sp.close15m, ema20_15m: sp.ema20_15m },
    scored: true,
    status: sp.status,
    initialScore: null,
    entryScore: null,
    finalScore: null,
    actualFill: null,
    exitPrice: sp.exitPrice ?? null,
    notes: '',
    archived: false,
    keptAgainst: [],
  };
}

const TODAY: Spec[] = [
  // Active position (filled earlier) — never displaced by newer candidates
  { ticker: 'TRMB', direction: 'LONG', o: 65.15, h: 65.19, l: 65.14, c: 65.18, atr: 0.1, price: 65.15, rvol: 2.2, rsi: 61, vwap: 64.98, ema9: 65.08, ema20: 65.02, close15m: 65.12, ema20_15m: 64.95, alertTime: '09:52', status: 'FILLED' },
  // Pending Sell Stop — capital reserved
  { ticker: 'AEP', direction: 'SHORT', o: 128.9, h: 128.91, l: 128.78, c: 128.8, atr: 0.157, price: 128.85, rvol: 1.9, rsi: 43, vwap: 129.05, ema9: 128.92, ema20: 128.96, close15m: 128.84, ema20_15m: 128.99, alertTime: '10:01', status: 'PENDING' },
  { ticker: 'NVDA', direction: 'SHORT', o: 212.95, h: 212.97, l: 212.57, c: 212.6, atr: 0.333, price: 212.7, rvol: 3.8, rsi: 33, vwap: 213.05, ema9: 212.85, ema20: 213.1, close15m: 212.65, ema20_15m: 213.3, alertTime: '10:05', status: 'NEW' },
  { ticker: 'IBM', direction: 'LONG', o: 255.3, h: 255.6, l: 255.24, c: 255.55, atr: 0.37, price: 255.5, rvol: 3.1, rsi: 64, vwap: 255.05, ema9: 255.35, ema20: 255.18, close15m: 255.48, ema20_15m: 255.0, alertTime: '10:12', status: 'NEW' },
  { ticker: 'NEE', direction: 'SHORT', o: 82.0, h: 82.02, l: 81.92, c: 81.95, atr: 0.081, price: 81.97, rvol: 2.7, rsi: 36, vwap: 82.06, ema9: 82.0, ema20: 82.04, close15m: 81.96, ema20_15m: 82.07, alertTime: '10:20', status: 'NEW' },
  { ticker: 'AVGO', direction: 'SHORT', o: 352.38, h: 352.4, l: 351.8, c: 351.86, atr: 0.62, price: 351.95, rvol: 2.9, rsi: 34, vwap: 352.5, ema9: 352.2, ema20: 352.45, close15m: 351.9, ema20_15m: 352.6, alertTime: '10:24', status: 'NEW' },
  { ticker: 'HCA', direction: 'LONG', o: 475.1, h: 477.45, l: 474.99, c: 477.3, atr: 0.823, price: 477.2, rvol: 2.3, rsi: 66, vwap: 476.1, ema9: 476.6, ema20: 476.2, close15m: 477.0, ema20_15m: 475.9, alertTime: '11:41', status: 'NEW' },
  { ticker: 'DLTR', direction: 'LONG', o: 131.32, h: 131.53, l: 131.3, c: 131.4, atr: 0.228, price: 131.42, rvol: 1.6, rsi: 57, vwap: 131.35, ema9: 131.38, ema20: 131.37, close15m: 131.4, ema20_15m: 131.38, alertTime: '12:40', status: 'NEW' },
];

/** Prior-day closed trades so the analytics page has something to show (illustrative only). */
const HISTORY: Spec[] = [
  { ...TODAY[2], alertTime: '10:02', status: 'TARGET_HIT', exitPrice: 211.65 },
  { ...TODAY[3], alertTime: '10:15', status: 'TARGET_HIT', exitPrice: 256.47 },
  { ...TODAY[4], alertTime: '10:31', status: 'STOPPED_OUT', exitPrice: 82.02 },
  { ...TODAY[6], alertTime: '12:05', status: 'STOPPED_OUT', exitPrice: 474.99 },
  { ...TODAY[7], alertTime: '13:10', status: 'STOPPED_OUT', exitPrice: 131.32 },
  { ...TODAY[0], alertTime: '14:20', status: 'MANUAL_EXIT', exitPrice: 65.24 },
];

export function sampleDay(today: string, previousDay: string, s: RankerSettings): { candidates: Candidate[]; positions: ManualPosition[] } {
  const t0 = Date.parse(`${today}T14:00:00Z`) || Date.now();
  const todays = TODAY.map((sp, i) => build(sp, today, t0 + i * 1000));
  // Freeze initial scores as they would have been when each was first scored.
  const r = rankCandidates(todays.map((c) => ({ ...c, status: c.status === 'FILLED' || c.status === 'PENDING' ? 'NEW' : c.status })), [], s, today);
  for (const c of todays) {
    const rc = r.ranked.find((x) => x.candidate.id === c.id)!;
    c.initialScore = snapshotOf(rc, c.createdAt, s);
    if (c.status === 'FILLED') c.entryScore = snapshotOf(rc, c.createdAt + 60_000, s);
  }
  const hist = HISTORY.map((sp, i) => build(sp, previousDay, t0 - 86_400_000 + i * 1000));
  const hr = rankCandidates(hist.map((c) => ({ ...c, status: 'NEW' })), [], s, previousDay);
  for (const c of hist) {
    c.initialScore = snapshotOf(hr.ranked.find((x) => x.candidate.id === c.id)!, c.createdAt, s);
    c.archived = true;
    c.id = `${c.id}-h`;
  }
  return { candidates: [...todays, ...hist], positions: [] };
}
