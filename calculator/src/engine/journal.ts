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

  /* ── Broker sync (optional; absent on manual entries — older journals stay valid) ── */
  /** 'broker_sync' = written automatically from read-only Alpaca reconciliation; absent/'manual' = entered by you. */
  source?: 'manual' | 'broker_sync';
  /** Deterministic identity of a broker-synced entry: the Alpaca entry order id. */
  brokerOrderId?: string;
  /** RB alert record the order was matched to (null = no RB alert, a manual trade). */
  alertRecordId?: string | null;
  /** MATCHED = exactly one RB alert at this order's price; NO_PRICE_MATCH / AMBIGUOUS = unlinked (no RB decision used). */
  alertLinkage?: 'MATCHED' | 'NO_PRICE_MATCH' | 'AMBIGUOUS';
  /** The four independent states. Strategy decision is written once and never rewritten. */
  strategyDecision?: 'READY' | 'NO TICKET' | 'NO TRADE' | 'NO ALERT';
  manualOverride?: boolean;
  brokerStatus?: string;
  positionStatus?: 'NONE' | 'OPEN' | 'CLOSED';
  /** Exit classification from broker evidence only (never guessed). */
  exitReason?: 'TARGET_HIT' | 'STOP_HIT' | 'MANUAL_EXIT' | 'CLOSED_EOD' | 'CANCELED' | null;
  entryFilledIso?: string | null;
  exitFilledIso?: string | null;
  /** Frozen alert-time plan and scores (from the RB alert snapshot; never recomputed). */
  plannedQty?: number | null;
  alertTimeIso?: string | null;
  ruleSet?: string | null;
  v11Score?: number | null;
  v11Tier?: string | null;
  v12Score?: number | null;
  v12OptionA?: string | null;
  v12OptionB?: string | null;
  /** Set when a manually logged entry looks like the same trade — flagged for you to resolve, never merged. */
  possibleDuplicateOf?: string | null;

  /* ── CR-15 cross-day reconciliation (optional; absent unless reconciliation was applied — older builds ignore them) ── */
  /** Broker orders that closed this trade (bracket legs / closing orders), oldest first. */
  exitOrderIds?: string[];
  /** Quantity closed so far from broker fills (a partially closed trade stays OPEN). */
  exitQty?: number | null;
  /** Realized P/L from broker fills: (avg exit − avg entry) × closed qty, signed by direction; fees not included. */
  realizedPnl?: number | null;
  reconciliation?: 'CR15';
  reconciledIso?: string | null;
  /** This row is an exit of another trade (written as a separate trade before CR-15): kept for audit, not counted. */
  supersededBy?: string | null;
  supersededReason?: string | null;
  supersededIso?: string | null;
}

/** Dashboard scope: all trades, trades RB recommended, or trades taken despite RB (manual overrides). */
export type JournalScope = 'ALL' | 'RB_STRATEGY' | 'MANUAL_OVERRIDE';

/** Manual entries and broker trades RB ticketed are strategy trades; broker trades RB did not ticket are overrides. */
export const isManualOverride = (e: JournalEntry) => e.manualOverride === true;

export function journalScope(entries: JournalEntry[], scope: JournalScope): JournalEntry[] {
  if (scope === 'ALL') return entries;
  return entries.filter((e) => (scope === 'MANUAL_OVERRIDE' ? isManualOverride(e) : !isManualOverride(e)));
}

/** Outcomes that represent a filled and closed trade. */
export const CLOSED_OUTCOMES: Outcome[] = ['TARGET_HIT', 'STOP_HIT', 'MANUAL_EXIT'];

export function isClosedTrade(e: JournalEntry): boolean {
  return CLOSED_OUTCOMES.includes(e.outcome) && e.exitPrice !== null && Number.isFinite(e.exitPrice) && e.quantity > 0;
}

/** Realised P/L in dollars (null if the trade is not closed). A CR-15 reconciled trade uses its broker-fill P/L. */
export function tradePnl(e: JournalEntry): number | null {
  if (!isClosedTrade(e)) return null;
  if (e.reconciliation === 'CR15' && e.realizedPnl !== null && e.realizedPnl !== undefined && Number.isFinite(e.realizedPnl)) return clean(e.realizedPnl);
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

/** Rows that count: a row superseded by CR-15 (an exit recorded as its own trade) is kept for audit only. */
export const activeEntries = (entries: JournalEntry[]) => (entries.some((e) => e.supersededBy) ? entries.filter((e) => !e.supersededBy) : entries);

export function computeMetrics(all: JournalEntry[]): DashboardMetrics {
  const entries = activeEntries(all);
  const chronological = [...entries].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  const closed = chronological.filter(isClosedTrade);
  const pnls = closed.map((e) => tradePnl(e) as number);
  // R needs a planned risk. A trade without one (e.g. a manual trade with no RB alert) has no R: it is excluded from
  // R averages instead of counting as 0 R. With planned risk on every closed trade this is identical to before.
  const rN = closed.map((e) => tradeR(e));
  const rs = rN.map((r) => r ?? 0);
  const withR = (ks: number[]) => ks.filter((k) => rN[k] !== null).map((k) => rs[k]);
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
    averageWinnerR: clean(mean(withR(winsIdx))),
    averageLoserR: clean(mean(withR(lossIdx))),
    averageR: clean(mean(withR(closed.map((_, k) => k)))),
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
