/**
 * RB v1 Trade Execution Calculator — calculation engine.
 *
 * Pure functions only: no React, no DOM, no storage. Every number shown in the UI
 * comes from here, so the whole decision can be unit-tested.
 *
 * ── FORMULAS (S = settings; defaults in settings.ts) ─────────────────────────────
 * LONG                                        SHORT
 *   B  = MAX(minBuffer, bufferPct × H)          B  = MAX(minBuffer, bufferPct × L)
 *   E  = H + B                                  E  = L − B
 *   Structural = E − L                          Structural = H − E
 *   R  = MAX(Structural, atrMult × ATR)         (same)
 *   Stop   = E − R                              Stop   = E + R
 *   Target = E + rewardMult × R                 Target = E − rewardMult × R
 *   RiskShares       = FLOOR(Equity × Risk% ÷ R)
 *   InvestmentShares = FLOOR(InvestmentCap ÷ E)
 *   Shares           = MIN(RiskShares, InvestmentShares)
 *
 * ── ROUNDING (see rounding.ts) ─────────────────────────────────────────────────
 *   • B is rounded to the nearest tick (0.0511 → 0.05), never below minBuffer.
 *   • R is rounded UP to the next tick (conservative: the stop is never closer than
 *     the rule requires). When structural risk controls, R is already a whole
 *     number of ticks and is unchanged.
 *   • Stop and Target are then exact tick prices, and Reward:Risk is exactly 2.00 : 1.
 *   • Shares are always rounded DOWN.
 *
 * ── DECISION HIERARCHY (in this exact order) ───────────────────────────────────
 *   1 validate inputs → INVALID INPUT
 *   2 existing position → DO NOT ADD (same dir) / MANAGE EXISTING (opposite)
 *   3 breakout trigger   4 structural vs ATR risk   5 stop & target
 *   6 position size      7 compare current price to trigger
 *   8 status: all hard rules from rules.ts (candle direction, entry window, 15m confirmation, structure,
 *     setup failed, stale, chased) → NOT ELIGIBLE; otherwise BUY STOP | SELL STOP | LATE ENTRY REVIEW
 *   9 trade ticket
 */
import { clean, floorShares, priceDecimals, roundPrice, roundToTick, tickSize } from './rounding';
import { RB_V1_DEFAULTS, type RbSettings } from './settings';
import { inputWarnings, validateInputs, type ValidationIssue } from './validation';
import {
  addMinutes,
  check15mConfirmation,
  checkCandleDirection,
  checkChase,
  checkSetupFailed,
  checkStale,
  checkStructure,
  checkTimeWindow,
  fail,
  lastCompleted15mCandle,
  RULES_VERSION,
  sortFails,
  type HardFail,
} from './rules';

export type Direction = 'LONG' | 'SHORT';

export interface TradeInputs {
  ticker: string;
  direction: Direction;
  open: number;
  high: number;
  low: number;
  close: number;
  /** ATR(14) from the same 5-minute chart, in dollars. */
  atr: number;
  currentPrice: number;
  /** Maximum notional dollars for this ticker. */
  investmentAmount: number;
  accountEquity: number;
  /** Maximum risk per trade as a FRACTION (0.0025 = 0.25%). */
  riskPct: number;
  /** Alert time, HH:MM Eastern Time (required — the entry window is a hard rule). */
  alertTime: string;
  /** Last COMPLETED regular-session 15-minute candle at the alert time: close and EMA20 (required). */
  close15m: number;
  ema20_15m: number;
  /** Optional: minutes since the alert fired. */
  minutesSinceAlert?: number | null;
  hasOpenPosition: boolean;
  openPositionDirection?: Direction | null;
  /** Late-entry state only: user chose "Use Current Price as Market Entry". */
  useMarketEntry?: boolean;
}

export type Action =
  | 'BUY_STOP'
  | 'SELL_STOP'
  | 'MARKET_LATE_ENTRY'
  | 'SKIP_CHASED'
  | 'SKIP_STALE'
  | 'SKIP_SETUP_FAILED'
  | 'DO_NOT_ADD'
  | 'MANAGE_EXISTING'
  | 'INVALID_INPUT'
  | 'INVALID_STRUCTURE'
  | 'NOT_ELIGIBLE';

export type Tone = 'long' | 'short' | 'warn' | 'danger' | 'neutral';

export type OrderType = 'BUY STOP' | 'SELL STOP' | 'MARKET';

export interface TradePlan {
  direction: Direction;
  /** 'TRIGGER' = planned stop-order breakout entry; 'MARKET' = recalculated at the current price. */
  entryMethod: 'TRIGGER' | 'MARKET';
  orderType: OrderType;
  signalPrice: number; // H for LONG, L for SHORT (buffer base)
  bufferRaw: number; // before rounding (0 for MARKET plans)
  buffer: number; // rounded order buffer (0 for MARKET plans)
  entry: number;
  structuralRisk: number; // full precision
  atrRisk: number; // atrMult × ATR, full precision
  rRaw: number; // MAX(structural, atrRisk), full precision
  riskPerShare: number; // R rounded UP to tick — used for stop, target and sizing
  riskMethod: 'STRUCTURAL' | 'ATR';
  stop: number;
  target: number;
  rewardPerShare: number;
  rewardRatio: number; // reward ÷ risk
  maxDollarRisk: number; // equity × risk%
  riskShares: number;
  investmentShares: number;
  shares: number;
  limitedBy: 'RISK' | 'INVESTMENT' | 'BOTH';
  positionValue: number;
  pctOfAccount: number; // fraction
  maxLoss: number;
  potentialProfit: number;
  structureValid: boolean;
  decimals: number;
}

export interface ChaseInfo {
  crossed: boolean;
  /** Positive = price is beyond the trigger in the trade direction. */
  distance: number;
  distanceAtr: number;
  thresholdAtr: number;
  thresholdDollars: number;
}

export interface Message {
  level: 'info' | 'warn' | 'danger';
  text: string;
}

export interface TradeResult {
  action: Action;
  headline: string;
  subhead: string;
  status: string;
  tone: Tone;
  /** True only when the ticket is a valid, actionable order (no hard failure). */
  ready: boolean;
  /** False whenever any hard rule failed. */
  eligible: boolean;
  /** Every failed hard rule, highest priority first (central rules.ts). */
  hardFails: HardFail[];
  errors: ValidationIssue[];
  warnings: string[];
  messages: Message[];
  /** The planned breakout (trigger) plan, when computable. */
  plan: TradePlan | null;
  /** Recalculated plan at the current price (late-entry state only). */
  marketPlan: TradePlan | null;
  /** The plan that the ticket shows (plan, or marketPlan if the user chose a market entry). */
  ticket: TradePlan | null;
  chase: ChaseInfo | null;
  stale: boolean;
  minutesSinceAlert: number | null;
  candlesSinceAlert: number | null;
  /** Alert time + minutes since alert (the time a new entry would happen). */
  evaluationTime: string | null;
  /** The 15m candle the 15m inputs must come from. */
  last15mCandle: { start: string; end: string } | null;
  rulesVersion: string;
}

/* ───────────────────────────── building blocks ───────────────────────────── */

/** Step 3a — breakout buffer: MAX(minBuffer, bufferPct × signal price), rounded to the nearest tick. */
export function calcBuffer(signalPrice: number, s: Pick<RbSettings, 'minBuffer' | 'bufferPct'> = RB_V1_DEFAULTS) {
  const raw = Math.max(s.minBuffer, s.bufferPct * signalPrice);
  const rounded = Math.max(s.minBuffer, roundToTick(raw, 'nearest', tickSize(signalPrice)));
  return { raw, rounded };
}

/** Step 3b — breakout entry trigger. */
export function calcEntryTrigger(direction: Direction, high: number, low: number, s: Pick<RbSettings, 'minBuffer' | 'bufferPct'> = RB_V1_DEFAULTS) {
  const signalPrice = direction === 'LONG' ? high : low;
  const buffer = calcBuffer(signalPrice, s);
  const entry = direction === 'LONG' ? roundPrice(signalPrice + buffer.rounded) : roundPrice(signalPrice - buffer.rounded);
  return { signalPrice, bufferRaw: buffer.raw, buffer: buffer.rounded, entry };
}

/** Steps 4–6 — risk, stop, target and size for a given entry price. */
export function buildPlan(
  direction: Direction,
  entry: number,
  high: number,
  low: number,
  atr: number,
  sizing: { accountEquity: number; riskPct: number; investmentAmount: number },
  s: RbSettings = RB_V1_DEFAULTS,
  meta: { entryMethod: 'TRIGGER' | 'MARKET'; signalPrice: number; bufferRaw: number; buffer: number } = {
    entryMethod: 'TRIGGER',
    signalPrice: direction === 'LONG' ? high : low,
    bufferRaw: 0,
    buffer: 0,
  },
): TradePlan {
  const tick = tickSize(entry);
  const structuralRisk = clean(direction === 'LONG' ? entry - low : high - entry);
  const atrRisk = clean(s.atrStopMultiple * atr);
  const rRaw = Math.max(structuralRisk, atrRisk);
  const riskMethod: 'STRUCTURAL' | 'ATR' = structuralRisk >= atrRisk ? 'STRUCTURAL' : 'ATR';
  const riskPerShare = roundToTick(rRaw, 'up', tick);

  const stop = direction === 'LONG' ? roundPrice(entry - riskPerShare) : roundPrice(entry + riskPerShare);
  const target =
    direction === 'LONG'
      ? roundPrice(entry + s.rewardMultiple * riskPerShare)
      : roundPrice(entry - s.rewardMultiple * riskPerShare);
  const rewardPerShare = clean(Math.abs(target - entry));
  const rewardRatio = riskPerShare > 0 ? clean(rewardPerShare / riskPerShare) : 0;

  const maxDollarRisk = clean(sizing.accountEquity * sizing.riskPct);
  const riskShares = riskPerShare > 0 ? floorShares(maxDollarRisk / riskPerShare) : 0;
  const investmentShares = entry > 0 ? floorShares(sizing.investmentAmount / entry) : 0;
  const shares = Math.min(riskShares, investmentShares);
  const limitedBy = riskShares < investmentShares ? 'RISK' : riskShares > investmentShares ? 'INVESTMENT' : 'BOTH';

  const positionValue = clean(shares * entry);
  const structureValid =
    riskPerShare > 0 &&
    target > 0 &&
    (direction === 'LONG' ? stop < entry && entry < target : target < entry && entry < stop);

  return {
    direction,
    entryMethod: meta.entryMethod,
    orderType: meta.entryMethod === 'MARKET' ? 'MARKET' : direction === 'LONG' ? 'BUY STOP' : 'SELL STOP',
    signalPrice: meta.signalPrice,
    bufferRaw: meta.bufferRaw,
    buffer: meta.buffer,
    entry,
    structuralRisk,
    atrRisk,
    rRaw,
    riskPerShare,
    riskMethod,
    stop,
    target,
    rewardPerShare,
    rewardRatio,
    maxDollarRisk,
    riskShares,
    investmentShares,
    shares,
    limitedBy,
    positionValue,
    pctOfAccount: sizing.accountEquity > 0 ? positionValue / sizing.accountEquity : 0,
    maxLoss: clean(shares * riskPerShare),
    potentialProfit: clean(shares * rewardPerShare),
    structureValid,
    decimals: priceDecimals(entry),
  };
}

/** Steps 3–6 for the standard breakout trigger. */
export function planTrigger(i: TradeInputs, s: RbSettings = RB_V1_DEFAULTS): TradePlan {
  const t = calcEntryTrigger(i.direction, i.high, i.low, s);
  return buildPlan(i.direction, t.entry, i.high, i.low, i.atr, i, s, {
    entryMethod: 'TRIGGER',
    signalPrice: t.signalPrice,
    bufferRaw: t.bufferRaw,
    buffer: t.buffer,
  });
}

/** Late entry: a COMPLETE recalculation using the current price as a market entry. */
export function planMarket(i: TradeInputs, s: RbSettings = RB_V1_DEFAULTS): TradePlan {
  const entry = roundPrice(i.currentPrice);
  return buildPlan(i.direction, entry, i.high, i.low, i.atr, i, s, {
    entryMethod: 'MARKET',
    signalPrice: i.direction === 'LONG' ? i.high : i.low,
    bufferRaw: 0,
    buffer: 0,
  });
}

/** Step 7 — how far the current price is beyond the trigger, in dollars and ATR. */
export function calcChase(direction: Direction, entry: number, currentPrice: number, atr: number, thresholdAtr: number): ChaseInfo {
  const crossed = direction === 'LONG' ? currentPrice >= entry : currentPrice <= entry;
  const rawDistance = clean(direction === 'LONG' ? currentPrice - entry : entry - currentPrice);
  const distance = crossed ? Math.max(0, rawDistance) : rawDistance;
  return {
    crossed,
    distance,
    distanceAtr: atr > 0 ? clean(distance / atr) : 0,
    thresholdAtr,
    thresholdDollars: clean(thresholdAtr * atr),
  };
}

/* ───────────────────────────── main entry point ───────────────────────────── */

const base = (partial: Partial<TradeResult>): TradeResult => ({
  action: 'INVALID_INPUT',
  headline: 'INVALID INPUT',
  subhead: '',
  status: '',
  tone: 'neutral',
  ready: false,
  eligible: false,
  hardFails: [],
  errors: [],
  warnings: [],
  messages: [],
  plan: null,
  marketPlan: null,
  ticket: null,
  chase: null,
  stale: false,
  minutesSinceAlert: null,
  candlesSinceAlert: null,
  evaluationTime: null,
  last15mCandle: null,
  rulesVersion: RULES_VERSION,
  ...partial,
});

/** Map the headline hard-fail code to the calculator Action. */
function actionFor(f: HardFail, i: TradeInputs): Action {
  switch (f.code) {
    case 'INVALID_INPUT': return 'INVALID_INPUT';
    case 'INVALID_TRADE_STRUCTURE': return 'INVALID_STRUCTURE';
    case 'SETUP_FAILED': return 'SKIP_SETUP_FAILED';
    case 'STALE_SETUP': return 'SKIP_STALE';
    case 'CHASED_SETUP': return 'SKIP_CHASED';
    case 'EXISTING_SAME_TICKER_POSITION':
      return (i.openPositionDirection ?? i.direction) === i.direction ? 'DO_NOT_ADD' : 'MANAGE_EXISTING';
    default: return 'NOT_ELIGIBLE';
  }
}

/**
 * Evaluate an alert against the RB v1.1 rules. This is the only function the UI needs.
 *
 * Every hard rule is evaluated (all failures are reported, the highest-priority one is the
 * headline). The plan is still calculated whenever possible so "Show Calculation" can teach,
 * but a result with ANY hard failure is never `ready` and never carries a `ticket`.
 */
export function evaluateTrade(i: TradeInputs, s: RbSettings = RB_V1_DEFAULTS): TradeResult {
  // 1 ── Validate inputs (missing values are never defaulted)
  const errors = validateInputs(i);
  if (errors.length) {
    return base({
      action: 'INVALID_INPUT', headline: 'INVALID INPUT', subhead: 'Fix the highlighted inputs', tone: 'neutral', errors,
      hardFails: [fail('INVALID_INPUT', errors.map((e) => e.message).join(' '))],
    });
  }
  const warnings = inputWarnings(i);
  const minutes = i.minutesSinceAlert ?? null;
  const candles = minutes === null ? null : Math.floor(minutes / s.timeframeMinutes);
  const evaluationTime = minutes === null ? i.alertTime : addMinutes(i.alertTime, minutes);
  const common = { warnings, minutesSinceAlert: minutes, candlesSinceAlert: candles, evaluationTime, last15mCandle: lastCompleted15mCandle(i.alertTime) };
  const fails: HardFail[] = [];
  const push = (f: HardFail | null) => void (f && fails.push(f));

  // 2 ── Existing position / order in this ticker (no pyramiding, no reversal)
  let existingBlocks = false;
  if (i.hasOpenPosition) {
    const existing = i.openPositionDirection ?? i.direction;
    if (existing !== i.direction) {
      push(fail('EXISTING_SAME_TICKER_POSITION', `Open ${existing} position in ${i.ticker || 'this ticker'}. Manage the existing trade first. Do not automatically reverse.`, 'MANAGE EXISTING TRADE FIRST'));
      existingBlocks = true;
    } else if (!s.allowPyramiding) {
      push(fail('EXISTING_SAME_TICKER_POSITION', 'RB v1 permits one active position or pending order per ticker. No pyramiding, no averaging up or down.'));
      existingBlocks = true;
    } else {
      warnings.push('Pyramiding override is ON in Settings: this would ADD to an existing same-direction position. This is not standard RB v1.');
    }
  }

  // 3 ── Strategy hard rules that do not need the plan
  push(checkCandleDirection(i.direction, i.open, i.close));
  const timeFail = checkTimeWindow(i.alertTime, s, 'Alert');
  push(timeFail);
  if (!timeFail && evaluationTime !== i.alertTime) push(checkTimeWindow(evaluationTime, s, 'Current (alert + minutes since alert)'));
  push(check15mConfirmation(i.direction, i.close15m, i.ema20_15m));

  // 4–6 ── Trigger, risk, stop/target, size. Not calculated for an existing-position block (no additional entry).
  const plan = existingBlocks ? null : planTrigger(i, s);
  let chase: ChaseInfo | null = null;
  if (plan) {
    push(checkStructure(i.direction, plan.stop, plan.entry, plan.target, plan.shares));
    // 7 ── Current price vs trigger
    chase = calcChase(i.direction, plan.entry, i.currentPrice, i.atr, s.chaseThresholdAtr);
    push(checkSetupFailed(i.direction, i.currentPrice, plan.stop));
    push(checkStale(chase.crossed, minutes, s.alertWindowMinutes));
    push(checkChase(chase.crossed, chase.distanceAtr, s.chaseThresholdAtr));
  }
  const stale = fails.some((f) => f.code === 'STALE_SETUP');
  const ctx = { ...common, plan, chase, stale };

  // 8a ── Any hard failure → NOT ELIGIBLE (all reasons listed; math stays visible in Show Calculation only)
  if (fails.length) {
    const sorted = sortFails(fails);
    const head = sorted[0];
    const action = actionFor(head, i);
    return base({
      ...ctx,
      action,
      headline: head.label,
      subhead: head.code === 'SETUP_FAILED' ? 'DO NOT ENTER' : sorted.length > 1 ? `${sorted.length} hard rules failed` : 'Hard rule failed — not eligible to trade',
      status: 'NOT ELIGIBLE',
      tone: head.code === 'INVALID_INPUT' ? 'neutral' : action === 'DO_NOT_ADD' || action === 'MANAGE_EXISTING' ? 'warn' : 'danger',
      hardFails: sorted,
      errors: head.code === 'INVALID_INPUT' ? [{ field: 'investmentAmount', message: head.reason }] : [],
      messages: [
        ...sorted.map((f) => ({ level: 'danger' as const, text: `${f.label}: ${f.reason}` })),
        ...(plan ? [{ level: 'info' as const, text: 'The entry, stop, target and size can still be calculated (see Show Calculation), but this setup is NOT eligible to trade.' }] : []),
      ],
    });
  }

  const p = plan as TradePlan;
  const c = chase as ChaseInfo;
  const dp = p.decimals;
  const $ = (v: number) => `$${v.toFixed(dp)}`;

  // 8b ── Trigger not crossed → stop order (distance to trigger is informational; chase logic does not apply)
  if (!c.crossed) {
    const isLong = i.direction === 'LONG';
    return base({
      ...ctx,
      action: isLong ? 'BUY_STOP' : 'SELL_STOP',
      headline: isLong ? 'BUY STOP' : 'SELL STOP',
      subhead: `@ ${$(p.entry)}`,
      status: isLong ? 'WAITING FOR BREAKOUT' : 'WAITING FOR BREAKDOWN',
      tone: isLong ? 'long' : 'short',
      ready: true,
      eligible: true,
      ticket: p,
      messages: [
        {
          level: 'info',
          text: isLong
            ? 'The stock has not yet broken above the signal candle. The Buy Stop waits for confirmation and only fills if price trades at the trigger.'
            : 'The trade activates only if price breaks downward through the trigger. The Sell Stop waits for confirmation.',
        },
        { level: 'info', text: `Distance to trigger: ${$(Math.abs(c.distance))} (${Math.abs(c.distanceAtr).toFixed(2)} ATR). Cancel the order if it has not triggered within ${s.alertWindowMinutes} minutes of the alert.` },
      ],
    });
  }

  // 8c ── Crossed but within the chase threshold → LATE ENTRY — REVIEW (never automatically valid)
  const marketPlan = planMarket(i, s);
  const marketFail = checkStructure(i.direction, marketPlan.stop, marketPlan.entry, marketPlan.target, marketPlan.shares);
  const useMarket = !!i.useMarketEntry;
  const messages: Message[] = [
    {
      level: 'warn',
      text: `Price already crossed the trigger by ${$(c.distance)} (${c.distanceAtr.toFixed(2)} ATR, limit ${s.chaseThresholdAtr} ATR). This is NOT automatically a trade. Review the recalculated risk before using a market order.`,
    },
  ];
  if (useMarket && marketFail) messages.push({ level: 'danger', text: `The recalculated market entry is not valid: ${marketFail.reason} Do not trade.` });
  return base({
    ...ctx,
    action: 'MARKET_LATE_ENTRY',
    headline: 'MARKET — LATE ENTRY REVIEW',
    subhead: useMarket ? `Recalculated at ${$(marketPlan.entry)}` : 'Review before any market order',
    status: 'LATE ENTRY — REVIEW',
    tone: 'warn',
    eligible: true,
    ready: useMarket && !marketFail,
    marketPlan,
    ticket: useMarket && !marketFail ? marketPlan : null,
    messages,
  });
}

/* ───────────────────────────── explanations & export ───────────────────────────── */

/** Step-by-step "Show Calculation" lines for a plan. */
export function calculationSteps(p: TradePlan, i: Pick<TradeInputs, 'high' | 'low' | 'atr' | 'accountEquity' | 'riskPct' | 'investmentAmount'>, s: RbSettings = RB_V1_DEFAULTS): string[] {
  const d = p.decimals;
  const f = (v: number, dp = d) => v.toFixed(dp);
  const L = p.direction === 'LONG';
  const lines: string[] = [];
  if (p.entryMethod === 'TRIGGER') {
    lines.push(`Signal ${L ? 'High' : 'Low'} = ${f(p.signalPrice)}`);
    lines.push(`Buffer = MAX(${f(s.minBuffer)}, ${f(p.signalPrice)} × ${s.bufferPct})`);
    lines.push(`Buffer = ${p.bufferRaw.toFixed(4)} → rounded order buffer = ${f(p.buffer)}`);
    lines.push(`Entry = ${f(p.signalPrice)} ${L ? '+' : '−'} ${f(p.buffer)} = ${f(p.entry)}`);
  } else {
    lines.push(`Market entry = current price = ${f(p.entry)} (no buffer; trigger plan discarded)`);
  }
  lines.push(
    L
      ? `Structural risk = Entry − Signal Low = ${f(p.entry)} − ${f(i.low)} = ${p.structuralRisk.toFixed(4)}`
      : `Structural risk = Signal High − Entry = ${f(i.high)} − ${f(p.entry)} = ${p.structuralRisk.toFixed(4)}`,
  );
  lines.push(`ATR risk = ${s.atrStopMultiple} × ${i.atr} = ${p.atrRisk.toFixed(4)}`);
  lines.push(`R = MAX(${p.structuralRisk.toFixed(4)}, ${p.atrRisk.toFixed(4)}) = ${p.rRaw.toFixed(4)} → ${p.riskMethod === 'STRUCTURAL' ? 'structural stop controls' : 'ATR controls'}`);
  if (Math.abs(p.rRaw - p.riskPerShare) > 1e-9) {
    lines.push(`R rounded UP to a whole cent (stop never closer than the rule) = ${f(p.riskPerShare)}`);
  }
  lines.push(`Stop = ${f(p.entry)} ${L ? '−' : '+'} ${f(p.riskPerShare)} = ${f(p.stop)}`);
  lines.push(`Target = ${f(p.entry)} ${L ? '+' : '−'} ${s.rewardMultiple} × ${f(p.riskPerShare)} = ${f(p.target)}`);
  lines.push(`Max dollar risk = ${i.accountEquity.toLocaleString('en-US')} × ${(i.riskPct * 100).toFixed(2)}% = ${p.maxDollarRisk.toFixed(2)}`);
  lines.push(`Risk-based shares = FLOOR(${p.maxDollarRisk.toFixed(2)} ÷ ${f(p.riskPerShare)}) = ${p.riskShares}`);
  lines.push(`Investment-cap shares = FLOOR(${i.investmentAmount.toLocaleString('en-US')} ÷ ${f(p.entry)}) = ${p.investmentShares}`);
  lines.push(`Shares = MIN(${p.riskShares}, ${p.investmentShares}) = ${p.shares} (${limitedByText(p)})`);
  lines.push(`Position value = ${p.shares} × ${f(p.entry)} = ${p.positionValue.toFixed(2)}`);
  lines.push(`Max planned loss = ${p.shares} × ${f(p.riskPerShare)} = ${p.maxLoss.toFixed(2)}`);
  lines.push(`Potential gross profit = ${p.shares} × ${f(p.rewardPerShare)} = ${p.potentialProfit.toFixed(2)}`);
  return lines;
}

export function limitedByText(p: TradePlan): string {
  if (p.limitedBy === 'INVESTMENT') return 'limited by the investment cap';
  if (p.limitedBy === 'RISK') return `limited by the $${p.maxDollarRisk.toFixed(2)} risk cap`;
  return 'risk cap and investment cap give the same size';
}

/** Plain-text ticket for the COPY TRADE button. */
export function formatTicket(ticker: string, p: TradePlan): string {
  const d = p.decimals;
  return [
    `${(ticker || 'TICKER').toUpperCase()} ${p.direction}`,
    p.orderType,
    `Qty: ${p.shares}`,
    `Entry: ${p.entry.toFixed(d)}`,
    `Stop: ${p.stop.toFixed(d)}`,
    `Take Profit: ${p.target.toFixed(d)}`,
    `Risk/share: ${p.riskPerShare.toFixed(d)}`,
    `Position: $${p.positionValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    `Max loss: $${p.maxLoss.toFixed(2)}`,
    `R:R: ${p.rewardRatio.toFixed(1)}`,
  ].join('\n');
}

/* ───────────────────────────── actual fill analysis ───────────────────────────── */

export interface FillAnalysis {
  actualEntry: number;
  slippagePerShare: number; // positive = worse than planned
  actualRiskPerShare: number; // to the existing stop
  actualRewardPerShare: number; // to the existing target
  actualRewardRatio: number;
  actualPositionCost: number;
  actualMaxLoss: number;
  actualPotentialProfit: number;
  riskInPlannedR: number; // actual risk ÷ planned risk
  beyondStop: boolean;
}

/** Planned vs actual: re-measure risk/reward from a real fill WITHOUT changing the plan's stop or target. */
export function analyzeFill(p: TradePlan, actualFill: number): FillAnalysis {
  const L = p.direction === 'LONG';
  const risk = clean(L ? actualFill - p.stop : p.stop - actualFill);
  const reward = clean(L ? p.target - actualFill : actualFill - p.target);
  return {
    actualEntry: actualFill,
    slippagePerShare: clean(L ? actualFill - p.entry : p.entry - actualFill),
    actualRiskPerShare: risk,
    actualRewardPerShare: reward,
    actualRewardRatio: risk > 0 ? clean(reward / risk) : 0,
    actualPositionCost: clean(p.shares * actualFill),
    actualMaxLoss: clean(p.shares * Math.max(0, risk)),
    actualPotentialProfit: clean(p.shares * Math.max(0, reward)),
    riskInPlannedR: p.riskPerShare > 0 ? clean(risk / p.riskPerShare) : 0,
    beyondStop: risk <= 0,
  };
}
