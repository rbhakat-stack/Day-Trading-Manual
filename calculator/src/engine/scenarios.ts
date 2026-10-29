/**
 * Preloaded test scenarios from the RB v1 / v1.1 specifications.
 * Values marked "assumed" were not given in the specification (Open, Close, current price,
 * alert time, 15m values, DLTR/chase high-low); they were chosen to produce the described outcome.
 */
import type { TradeInputs } from './tradeCalculator';

export interface Scenario {
  id: string;
  label: string;
  expected: string;
  inputs: TradeInputs;
}

const base = {
  investmentAmount: 20000,
  accountEquity: 100000,
  riskPct: 0.0025,
  minutesSinceAlert: 2,
  alertTime: '10:15',
  hasOpenPosition: false,
  openPositionDirection: null,
  useMarketEntry: false,
} as const;

const IBM = { ticker: 'IBM', direction: 'LONG', open: 255.3, high: 255.6, low: 255.24, close: 255.55, atr: 0.37, close15m: 255.48, ema20_15m: 255.0 } as const;
const NVDA = { ticker: 'NVDA', direction: 'SHORT', open: 212.95, high: 212.97, low: 212.57, close: 212.6, atr: 0.333, close15m: 212.65, ema20_15m: 213.3 } as const;
const CANDLE_90 = { open: 90.34, high: 90.34, low: 90.13, close: 90.17, atr: 0.18 } as const;

export const SCENARIOS: Scenario[] = [
  {
    id: 'trmb-long',
    label: 'TRMB LONG — ATR controls risk',
    expected: 'BUY STOP @ 65.20 · Stop 65.10 · Target 65.40 · 306 sh',
    inputs: { ...base, ticker: 'TRMB', direction: 'LONG', open: 65.15, high: 65.19, low: 65.14, close: 65.18, atr: 0.1, currentPrice: 65.15, close15m: 65.12, ema20_15m: 64.95 },
  },
  {
    id: 'aep-short',
    label: 'AEP SHORT — structural slightly > ATR',
    expected: 'SELL STOP @ 128.75 · Stop 128.91 · Target 128.43 · 155 sh',
    inputs: { ...base, ticker: 'AEP', direction: 'SHORT', open: 128.9, high: 128.91, low: 128.78, close: 128.8, atr: 0.157, currentPrice: 128.85, close15m: 128.84, ema20_15m: 128.99 },
  },
  {
    id: 'nvda-short',
    label: 'NVDA SHORT — structural > ATR',
    expected: 'SELL STOP @ 212.53 · Stop 212.97 · Target 211.65 · 94 sh',
    inputs: { ...base, ...NVDA, currentPrice: 212.7 },
  },
  {
    id: 'nee-short',
    label: 'NEE SHORT — structural controls',
    expected: 'SELL STOP @ 81.90 · Stop 82.02 · Target 81.66 · 244 sh',
    inputs: { ...base, ticker: 'NEE', direction: 'SHORT', open: 82.0, high: 82.02, low: 81.92, close: 81.95, atr: 0.081, currentPrice: 81.97, close15m: 81.96, ema20_15m: 82.07 },
  },
  {
    id: 'ibm-long',
    label: 'IBM LONG — structural > ATR',
    expected: 'BUY STOP @ 255.65 · Stop 255.24 · Target 256.47 · 78 sh',
    inputs: { ...base, ...IBM, currentPrice: 255.5 },
  },
  {
    id: 'ibm-long-2',
    label: 'IBM LONG #2 — H 255.75 / L 255.22',
    expected: 'BUY STOP @ 255.80 · Stop 255.22 · Target 256.96 · 78 sh',
    inputs: { ...base, ticker: 'IBM', direction: 'LONG', open: 255.3, high: 255.75, low: 255.22, close: 255.7, atr: 0.388, currentPrice: 255.6, close15m: 255.5, ema20_15m: 255.1 },
  },
  {
    id: 'short-mirror-90',
    label: 'SHORT 90.34/90.13 — valid red candle',
    expected: 'SELL STOP @ 90.11 · Stop 90.34 · Target 89.65 · 221 sh',
    inputs: { ...base, ticker: 'TEST', direction: 'SHORT', ...CANDLE_90, currentPrice: 90.2, close15m: 90.15, ema20_15m: 90.25 },
  },
  {
    id: 'long-red-candle',
    label: 'LONG with red candle (C < O) — hard fail',
    expected: 'NOT ELIGIBLE — LONG SIGNAL CANDLE INVALID',
    inputs: { ...base, ticker: 'TEST', direction: 'LONG', ...CANDLE_90, currentPrice: 90.2, close15m: 90.3, ema20_15m: 90.2 },
  },
  {
    id: 'nvda-after-hours',
    label: 'NVDA alert at 16:04 ET — after session',
    expected: 'NOT ELIGIBLE — AFTER REGULAR SESSION',
    inputs: { ...base, ...NVDA, currentPrice: 212.7, alertTime: '16:04' },
  },
  {
    id: 'nvda-window-closed',
    label: 'NVDA alert at 15:31 ET — window closed',
    expected: 'NOT ELIGIBLE — NEW ENTRY WINDOW CLOSED',
    inputs: { ...base, ...NVDA, currentPrice: 212.7, alertTime: '15:31' },
  },
  {
    id: 'nvda-too-early',
    label: 'NVDA alert at 09:40 ET — too early',
    expected: 'NOT ELIGIBLE — TOO EARLY',
    inputs: { ...base, ...NVDA, currentPrice: 212.7, alertTime: '09:40' },
  },
  {
    id: 'ibm-htf-fail',
    label: 'IBM LONG — 15m close below 15m EMA20',
    expected: 'NOT ELIGIBLE — 15M TREND CONFIRMATION FAILED',
    inputs: { ...base, ...IBM, currentPrice: 255.5, close15m: 255.0, ema20_15m: 255.1 },
  },
  {
    id: 'chase-0375',
    label: 'LONG entry 100.00, price 100.15, ATR 0.40 — chased',
    expected: 'NOT ELIGIBLE — DO NOT CHASE (0.375 ATR)',
    inputs: { ...base, ticker: 'TEST', direction: 'LONG', open: 99.75, high: 99.98, low: 99.7, close: 99.95, atr: 0.4, currentPrice: 100.15, close15m: 99.9, ema20_15m: 99.6 },
  },
  {
    id: 'no-chase-before-trigger',
    label: 'LONG entry 100.00, price 99.80, ATR 0.20 — not crossed',
    expected: 'BUY STOP @ 100.00 (1.00 ATR below trigger — not chased)',
    inputs: { ...base, ticker: 'TEST', direction: 'LONG', open: 99.75, high: 99.98, low: 99.7, close: 99.95, atr: 0.2, currentPrice: 99.8, close15m: 99.9, ema20_15m: 99.6 },
  },
  {
    id: 'hca-chased',
    label: 'HCA LONG — price moved too far',
    expected: 'NOT ELIGIBLE — DO NOT CHASE (1.35 ATR past 477.55)',
    inputs: { ...base, ticker: 'HCA', direction: 'LONG', open: 475.1, high: 477.45, low: 474.99, close: 477.3, atr: 0.823, currentPrice: 478.66, close15m: 477.0, ema20_15m: 475.9 },
  },
  {
    id: 'dltr-missed',
    label: 'DLTR LONG — missed breakout',
    expected: 'NOT ELIGIBLE — DO NOT CHASE (trigger 131.56, 1.01 ATR)',
    inputs: { ...base, ticker: 'DLTR', direction: 'LONG', open: 131.32, high: 131.53, low: 131.3, close: 131.5, atr: 0.228, currentPrice: 131.79, close15m: 131.4, ema20_15m: 131.38 },
  },
  {
    id: 'ibm-failed',
    label: 'IBM LONG — failed breakout',
    expected: 'NOT ELIGIBLE — SETUP FAILED (price 255.11 below stop 255.24)',
    inputs: { ...base, ...IBM, currentPrice: 255.11 },
  },
  {
    id: 'ibm-late',
    label: 'IBM LONG — late entry (0.14 ATR past trigger)',
    expected: 'MARKET — LATE ENTRY REVIEW (market @ 255.70 → stop 255.24, target 256.62)',
    inputs: { ...base, ...IBM, currentPrice: 255.7 },
  },
  {
    id: 'trmb-stale',
    label: 'TRMB LONG — no trigger after 15 minutes',
    expected: 'NOT ELIGIBLE — STALE SETUP',
    inputs: { ...base, ticker: 'TRMB', direction: 'LONG', open: 65.15, high: 65.19, low: 65.14, close: 65.18, atr: 0.1, currentPrice: 65.15, close15m: 65.12, ema20_15m: 64.95, minutesSinceAlert: 15 },
  },
];
