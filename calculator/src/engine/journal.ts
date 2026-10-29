/**
 * Trade journal model and performance metrics (pure functions).
 * P/L is computed from the ACTUAL fill when entered, otherwise from the planned entry.
 * R multiple = P/L ÷ planned maximum loss (expectedRisk).
 */
import { clean } from './rounding';
import type { Action, Direction } from './tradeCalculator';

export type Outcome = 'OPEN' | 'TARGET_HIT' | 'STOP_HIT' | 'MANUAL_EXIT' | 'NEVER_TRIGGERED' | 'SKIPPED' | 'CANCELED';

export const OUTCOME_LABELS: Record<Outcome, string> = {
  OPEN: 'Open / pending',
  TARGET_HIT: 'Target hit',
  STOP_HIT: 'Stop hit',
  MANUAL_EXIT: 'Manual exit',
  NEVER_TRIGGERED: 'Never triggered',
  SKIPPED: 'Skipped',
  CANCELED: 'Canceled',
};

export interface JournalEntry {
  id: string;
  ticker: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM (ET recommended)
  direction: Direction;
  open: number;
  high: number;
  low: number;
  close: number;
  atr: number;
  alertPrice: number; // current price when calculated
  decision: Action;
  orderType: string;
  plannedEntry: number;
  actualFill: number | null;
  stop: number;
  target: number;
  quantity: number;
  positionValue: number;
  expectedRisk: number; // planned max loss ($)
  expectedReward: number; // planned gross profit ($)
  outcome: Outcome;
  exitPrice: number | null;
  notes: string;
  /** Central hard-rule codes (rules.ts) that failed when this entry was saved. */
  hardFailCodes?: string[];
  /** Rules version that produced the decision (never re-evaluated later). */
  rulesVersion?: string;
}

/** Outcomes that represent a filled and closed trade. */
export const CLOSED_OUTCOMES: Outcome[] = ['TARGET_HIT', 'STOP_HIT', 'MANUAL_EXIT'];

export function isClosedTrade(e: JournalEntry): boolean {
  return CLOSED_OUTCOMES.includes(e.outcome) && e.exitPrice !== null && Number.isFinite(e.exitPrice) && e.quantity > 0;
}

/** Realised P/L in dollars (null if the trade is not closed). */
export function tradePnl(e: JournalEntry): number | null {
  if (!isClosedTrade(e)) return null;
  const entry = e.actualFill ?? e.plannedEntry;
  const perShare = e.direction === 'LONG' ? (e.exitPrice as number) - entry : entry - (e.exitPrice as number);
  return clean(perShare * e.quantity);
}

/** R multiple = P/L ÷ planned dollar risk. */
export function tradeR(e: JournalEntry): number | null {
  const pnl = tradePnl(e);
  if (pnl === null || e.expectedRisk <= 0) return null;
  return clean(pnl / e.expectedRisk);
}

export interface GroupStats {
  key: string;
  trades: number;
  wins: number;
  winRate: number;
  totalR: number;
  totalPnl: number;
}

export interface DashboardMetrics {
  totalEntries: number;
  closedTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  skipped: number;
  neverTriggered: number;
  canceled: number;
  open: number;
  winRate: number;
  averageWinner: number; // $
  averageLoser: number; // $ (negative)
  averageWinnerR: number;
  averageLoserR: number;
  averageR: number;
  totalR: number;
  profitFactor: number | null; // null when there are no losses
  totalPnl: number;
  maxDrawdown: number; // $ (positive number)
  maxDrawdownR: number;
  averagePlannedRisk: number;
  averageActualLoss: number; // $ (positive number)
  byDirection: GroupStats[];
  byTicker: GroupStats[];
  byTimeOfDay: GroupStats[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Time-of-day bucket for an "HH:MM" string (Eastern time assumed). */
export function timeBucket(time: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(time || '');
  if (!m) return 'Unknown';
  const mins = Number(m[1]) * 60 + Number(m[2]);
  if (mins < 570) return 'Pre-market';
  if (mins < 600) return '09:30–10:00';
  if (mins >= 960) return 'After-hours';
  const h = Math.floor(mins / 60);
  return `${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00`;
}

function group(closed: JournalEntry[], keyOf: (e: JournalEntry) => string): GroupStats[] {
  const map = new Map<string, JournalEntry[]>();
  for (const e of closed) {
    const k = keyOf(e);
    map.set(k, [...(map.get(k) ?? []), e]);
  }
  return [...map.entries()]
    .map(([key, es]) => {
      const pnls = es.map((e) => tradePnl(e) as number);
      const wins = pnls.filter((p) => p > 0).length;
      return {
        key,
        trades: es.length,
        wins,
        winRate: es.length ? wins / es.length : 0,
        totalR: clean(es.reduce((a, e) => a + (tradeR(e) ?? 0), 0)),
        totalPnl: clean(pnls.reduce((a, b) => a + b, 0)),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function computeMetrics(entries: JournalEntry[]): DashboardMetrics {
  const chronological = [...entries].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  const closed = chronological.filter(isClosedTrade);
  const pnls = closed.map((e) => tradePnl(e) as number);
  const rs = closed.map((e) => tradeR(e) ?? 0);
  const winsIdx = pnls.map((p, k) => (p > 0 ? k : -1)).filter((k) => k >= 0);
  const lossIdx = pnls.map((p, k) => (p < 0 ? k : -1)).filter((k) => k >= 0);
  const grossWin = winsIdx.reduce((a, k) => a + pnls[k], 0);
  const grossLoss = lossIdx.reduce((a, k) => a + pnls[k], 0);

  // Max drawdown on cumulative P/L and cumulative R (peak starts at 0)
  let cum = 0, peak = 0, mdd = 0, cumR = 0, peakR = 0, mddR = 0;
  closed.forEach((_, k) => {
    cum += pnls[k];
    peak = Math.max(peak, cum);
    mdd = Math.max(mdd, peak - cum);
    cumR += rs[k];
    peakR = Math.max(peakR, cumR);
    mddR = Math.max(mddR, peakR - cumR);
  });

  return {
    totalEntries: entries.length,
    closedTrades: closed.length,
    wins: winsIdx.length,
    losses: lossIdx.length,
    breakeven: closed.length - winsIdx.length - lossIdx.length,
    skipped: entries.filter((e) => e.outcome === 'SKIPPED').length,
    neverTriggered: entries.filter((e) => e.outcome === 'NEVER_TRIGGERED').length,
    canceled: entries.filter((e) => e.outcome === 'CANCELED').length,
    open: entries.filter((e) => e.outcome === 'OPEN').length,
    winRate: closed.length ? winsIdx.length / closed.length : 0,
    averageWinner: clean(mean(winsIdx.map((k) => pnls[k]))),
    averageLoser: clean(mean(lossIdx.map((k) => pnls[k]))),
    averageWinnerR: clean(mean(winsIdx.map((k) => rs[k]))),
    averageLoserR: clean(mean(lossIdx.map((k) => rs[k]))),
    averageR: clean(mean(rs)),
    totalR: clean(rs.reduce((a, b) => a + b, 0)),
    profitFactor: grossLoss < 0 ? clean(grossWin / Math.abs(grossLoss)) : null,
    totalPnl: clean(pnls.reduce((a, b) => a + b, 0)),
    maxDrawdown: clean(mdd),
    maxDrawdownR: clean(mddR),
    averagePlannedRisk: clean(mean(closed.map((e) => e.expectedRisk))),
    averageActualLoss: clean(Math.abs(mean(lossIdx.map((k) => pnls[k])))),
    byDirection: group(closed, (e) => e.direction),
    byTicker: group(closed, (e) => e.ticker.toUpperCase() || '—'),
    byTimeOfDay: group(closed, (e) => timeBucket(e.time)),
  };
}

/** CSV export of the journal with derived P/L and R. */
export function journalToCsv(entries: JournalEntry[]): string {
  const cols: (keyof JournalEntry)[] = [
    'date', 'time', 'ticker', 'direction', 'decision', 'orderType', 'open', 'high', 'low', 'close', 'atr',
    'alertPrice', 'plannedEntry', 'actualFill', 'stop', 'target', 'quantity', 'positionValue',
    'expectedRisk', 'expectedReward', 'outcome', 'exitPrice', 'notes', 'rulesVersion', 'hardFailCodes',
  ];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [...cols, 'pnl', 'rMultiple'].join(',');
  const rows = entries.map((e) => [...cols.map((c) => esc(e[c])), esc(tradePnl(e)), esc(tradeR(e))].join(','));
  return [header, ...rows].join('\n');
}
