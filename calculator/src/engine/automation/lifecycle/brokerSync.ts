/**
 * CR-12 — broker order / fill synchronisation (READ ONLY, IMPORT BASED).
 *
 * The app has no broker connection by design (the static NO TRADE EXECUTION guard forbids any trading-API host or
 * order/position path in the code). This module therefore reconciles Alpaca ORDER DATA THE USER PASTES (the JSON the
 * Alpaca dashboard/API returns for orders, including bracket legs) with RB alerts. It never sends anything anywhere.
 *
 * Four answers are kept independent, so a manual trade never rewrites strategy history:
 *   Strategy Decision — what RB decided for the alert (READY / NO TICKET / NO TRADE, or NO ALERT)
 *   Manual Override   — YES when the broker shows an entry fill the strategy did not ticket
 *   Broker Status     — mapped from the Alpaca order status
 *   Position Status   — NONE / OPEN / CLOSED, from the fills
 * e.g. Strategy = NO TRADE, Override = YES, Broker = FILLED, Position = OPEN is a valid, recorded combination.
 * The manual "Mark order submitted / filled" fallback is unchanged.
 */
import { etParts } from '../etTime';
import type { QueueRow } from '../liveQueue';
import type { AutoAlertRecord } from '../alertDecision';
import type { Candidate } from '../../ranker/opportunityTypes';
import type { JournalEntry, Outcome } from '../../journal';
import type { AlertTimeSnapshot } from './alertTimeSnapshot';

export type BrokerStatus = 'PENDING' | 'PARTIAL' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'REJECTED' | 'UNKNOWN';
export type PositionStatus = 'NONE' | 'OPEN' | 'CLOSED';
export type ExitReason = 'TARGET HIT' | 'STOPPED OUT' | 'MANUAL EXIT' | 'CLOSED — EOD';

const STATUS_MAP: Record<string, BrokerStatus> = {
  new: 'PENDING', accepted: 'PENDING', pending_new: 'PENDING', accepted_for_bidding: 'PENDING', held: 'PENDING', calculated: 'PENDING',
  pending_replace: 'PENDING', pending_cancel: 'PENDING', replaced: 'PENDING', suspended: 'PENDING',
  partially_filled: 'PARTIAL', partial_fill: 'PARTIAL',
  filled: 'FILLED',
  canceled: 'CANCELED', cancelled: 'CANCELED', done_for_day: 'CANCELED', stopped: 'CANCELED',
  expired: 'EXPIRED',
  rejected: 'REJECTED',
};

export function mapBrokerStatus(s: string | null | undefined): BrokerStatus {
  return STATUS_MAP[(s ?? '').trim().toLowerCase()] ?? 'UNKNOWN';
}

/** The subset of an Alpaca order object this module reads (snake_case as Alpaca returns it). */
export interface BrokerOrder {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  status: string;
  qty: number | null;
  filledQty: number;
  filledAvgPrice: number | null;
  stopPrice: number | null;
  limitPrice: number | null;
  submittedAt: number | null;
  filledAt: number | null;
  orderClass: string;
  legs: BrokerOrder[];
}

const num = (x: unknown): number | null => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const ms = (x: unknown): number | null => (typeof x === 'string' && Number.isFinite(Date.parse(x)) ? Date.parse(x) : null);

function toOrder(o: Record<string, unknown>): BrokerOrder | null {
  const symbol = typeof o.symbol === 'string' ? o.symbol.toUpperCase() : '';
  const side = o.side === 'buy' || o.side === 'sell' ? o.side : null;
  if (!symbol || !side || typeof o.status !== 'string') return null;
  return {
    id: String(o.id ?? o.client_order_id ?? `${symbol}-${o.submitted_at ?? ''}`),
    symbol, side,
    type: String(o.type ?? o.order_type ?? ''),
    status: o.status,
    qty: num(o.qty),
    filledQty: num(o.filled_qty) ?? 0,
    filledAvgPrice: num(o.filled_avg_price),
    stopPrice: num(o.stop_price),
    limitPrice: num(o.limit_price),
    submittedAt: ms(o.submitted_at) ?? ms(o.created_at),
    filledAt: ms(o.filled_at),
    orderClass: String(o.order_class ?? ''),
    legs: Array.isArray(o.legs) ? o.legs.map((l) => toOrder(l as Record<string, unknown>)).filter((l): l is BrokerOrder => !!l) : [],
  };
}

/** Parse pasted Alpaca order JSON (an array, or an object with an `orders` array). Bad entries are reported, not guessed. */
export function parseBrokerOrders(text: string): { orders: BrokerOrder[]; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { orders: [], errors: ['Not valid JSON — paste the Alpaca orders JSON (array of orders).'] };
  }
  const arr = Array.isArray(raw) ? raw : Array.isArray((raw as { orders?: unknown })?.orders) ? (raw as { orders: unknown[] }).orders : null;
  if (!arr) return { orders: [], errors: ['Expected an array of orders.'] };
  return brokerOrdersFrom(arr);
}

/** Orders from raw Alpaca order objects (the read-only rb-broker feed or a pasted export). */
export function brokerOrdersFrom(arr: unknown[]): { orders: BrokerOrder[]; errors: string[] } {
  const orders: BrokerOrder[] = [];
  const errors: string[] = [];
  arr.forEach((o, i) => {
    const x = o && typeof o === 'object' ? toOrder(o as Record<string, unknown>) : null;
    if (x) orders.push(x);
    else errors.push(`Order ${i + 1}: missing symbol, side or status`);
  });
  return { orders, errors };
}

export interface TradeSync {
  recordId: string | null;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryOrderId: string;
  strategyDecision: 'READY' | 'NO TICKET' | 'NO TRADE' | 'NO ALERT';
  manualOverride: boolean;
  brokerStatus: BrokerStatus;
  positionStatus: PositionStatus;
  entryQty: number;
  entryAvg: number | null;
  exitQty: number;
  exitAvg: number | null;
  exitReason: ExitReason | null;
  /** Realized P/L on the closed quantity (fills only; fees not included). */
  realizedPL: number | null;
  notes: string[];
  /** Broker timestamps (epoch ms): entry order submitted / entry filled / last exit filled. */
  submittedAt?: number | null;
  entryFilledAt?: number | null;
  exitFilledAt?: number | null;
}

const EOD_EXIT_FROM = 15 * 60 + 50;
const minutesEt = (t: number) => { const h = etParts(t).hhmm; return Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5)); };
const isFilled = (o: BrokerOrder) => o.filledQty > 0;

/** Find the RB alert this entry order belongs to: same ticker and side, same ET day, entry stop within 2 ¢ of RB's entry. */
function matchRow(o: BrokerOrder, rows: QueueRow[]): QueueRow | null {
  const dir = o.side === 'buy' ? 'LONG' : 'SHORT';
  const t = o.submittedAt;
  const cands = rows.filter((r) => r.record.alert.symbol === o.symbol && r.record.alert.direction === dir && (t === null || (etParts(t).date === etParts(r.record.alert.alertTimeMs).date && t >= r.record.alert.alertTimeMs - 60_000)));
  const entry = (r: QueueRow) => r.candidate?.entry ?? null;
  const priced = cands.filter((r) => o.stopPrice !== null && entry(r) !== null && Math.abs((entry(r) as number) - (o.stopPrice as number)) <= 0.02 + 1e-9);
  const pool = priced.length ? priced : cands;
  return pool.sort((a, b) => b.record.alert.alertTimeMs - a.record.alert.alertTimeMs)[0] ?? null;
}

/**
 * Reconcile imported orders with the queue rows. Entry = an order without a parent that opens (buy for LONG / sell
 * for SHORT, first per ticker); exits = its filled bracket legs, then opposite-side orders for the same ticker after it.
 */
export function reconcileBroker(orders: BrokerOrder[], rows: QueueRow[], positions?: { symbol: string; qty?: string | number }[]): TradeSync[] {
  // Live broker positions (when supplied) are the authority for open/closed; fills alone may miss an exit outside the window.
  const held = positions ? new Set(positions.filter((p) => Number(p.qty ?? 0) !== 0).map((p) => p.symbol.toUpperCase())) : null;
  const sorted = [...orders].sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0));
  // Bracket legs are exits of their parent, never entries of their own (even when listed at top level too).
  const used = new Set<string>(sorted.flatMap((o) => o.legs.map((l) => l.id)));
  const out: TradeSync[] = [];
  for (const o of sorted) {
    if (used.has(o.id)) continue;
    used.add(o.id);
    o.legs.forEach((l) => used.add(l.id));
    const direction = o.side === 'buy' ? 'LONG' : 'SHORT';
    const row = matchRow(o, rows);
    const lc = row?.lifecycle;
    const strategyDecision: TradeSync['strategyDecision'] = !row ? 'NO ALERT' : row.decision.ticket ? 'READY' : lc?.finalActionability === 'NO TRADE' ? 'NO TRADE' : 'NO TICKET';
    // Exits: bracket legs first, then later opposite-side orders in the same ticker (manual / EOD closes).
    const exitSide = o.side === 'buy' ? 'sell' : 'buy';
    const later = sorted.filter((x) => !used.has(x.id) && x.symbol === o.symbol && x.side === exitSide && (x.submittedAt ?? 0) >= (o.submittedAt ?? 0));
    let remaining = o.filledQty;
    const exits: { o: BrokerOrder; reason: ExitReason }[] = [];
    for (const l of o.legs.filter(isFilled)) exits.push({ o: l, reason: /limit/i.test(l.type) ? 'TARGET HIT' : /stop/i.test(l.type) ? 'STOPPED OUT' : 'MANUAL EXIT' });
    remaining -= exits.reduce((n, e) => n + e.o.filledQty, 0);
    for (const x of later) {
      if (remaining <= 0) break;
      if (!isFilled(x)) continue;
      used.add(x.id);
      exits.push({ o: x, reason: x.filledAt !== null && minutesEt(x.filledAt) >= EOD_EXIT_FROM ? 'CLOSED — EOD' : 'MANUAL EXIT' });
      remaining -= x.filledQty;
    }
    const exitQty = exits.reduce((n, e) => n + e.o.filledQty, 0);
    const exitAvg = exitQty ? exits.reduce((n, e) => n + e.o.filledQty * (e.o.filledAvgPrice ?? 0), 0) / exitQty : null;
    const closedQty = Math.min(exitQty, o.filledQty);
    const sign = direction === 'LONG' ? 1 : -1;
    const realizedPL = closedQty && o.filledAvgPrice !== null && exitAvg !== null ? Math.round(sign * (exitAvg - o.filledAvgPrice) * closedQty * 100) / 100 : null;
    const fromFills: PositionStatus = o.filledQty <= 0 ? 'NONE' : exitQty >= o.filledQty ? 'CLOSED' : 'OPEN';
    const positionStatus: PositionStatus = held && fromFills === 'OPEN' && !held.has(o.symbol) ? 'CLOSED' : held && fromFills === 'CLOSED' && held.has(o.symbol) ? 'OPEN' : fromFills;
    const notes: string[] = [];
    if (!row) notes.push('No RB alert matched this order (manual trade).');
    if (positionStatus !== fromFills) notes.push(`Position status from broker positions (fills in the window say ${fromFills}).`);
    if (exits.length > 1 && new Set(exits.map((e) => e.reason)).size > 1) notes.push(`Mixed exits: ${exits.map((e) => `${e.o.filledQty} ${e.reason}`).join(', ')}`);
    out.push({
      recordId: row?.record.id ?? null, symbol: o.symbol, direction, entryOrderId: o.id,
      strategyDecision, manualOverride: o.filledQty > 0 && strategyDecision !== 'READY',
      brokerStatus: mapBrokerStatus(o.status), positionStatus,
      entryQty: o.filledQty, entryAvg: o.filledAvgPrice, exitQty, exitAvg,
      exitReason: positionStatus === 'CLOSED' ? (exits[exits.length - 1]?.reason ?? null) : null,
      realizedPL, notes,
      submittedAt: o.submittedAt, entryFilledAt: o.filledAt, exitFilledAt: exits.length ? exits[exits.length - 1].o.filledAt : null,
    });
  }
  return out;
}

/** CR-13 — broker facts for the EOD flatness check: tickers with an open position, and unfilled entry orders. */
export function brokerEodFacts(feed: { orders: unknown[]; positions: { symbol: string; qty?: string | number }[] }): { openTickers: string[]; pendingTickers: string[] } {
  const { orders } = brokerOrdersFrom(feed.orders);
  return {
    openTickers: feed.positions.filter((p) => Number(p.qty ?? 0) !== 0).map((p) => p.symbol.toUpperCase()),
    pendingTickers: orders.filter((o) => ['PENDING', 'PARTIAL'].includes(mapBrokerStatus(o.status)) && o.filledQty < (o.qty ?? Infinity)).map((o) => o.symbol),
  };
}

/* ───────────────────────── Journal sync (browser-local ledger) ───────────────────────── */

const TICKET_DECISIONS = ['TRADE NOW — ELITE', 'HIGH PRIORITY — TRADE CONSIDERATION'];

/**
 * The strategy decision of a reconciled trade, taken from the FROZEN alert-time snapshot when one exists: what RB
 * decided when the alert arrived (a ticket → READY; NOT ELIGIBLE / SKIP → NO TRADE; otherwise NO TICKET). The live
 * derivation changes over time (an RB trade marked submitted reads NO TICKET, an expired one NO TRADE), so it is only
 * the fallback when no snapshot was captured. Broker facts are never touched.
 */
export function withAlertTimeDecision(trades: TradeSync[], snaps: Record<string, AlertTimeSnapshot>): TradeSync[] {
  return trades.map((t) => {
    const s = t.recordId ? snaps[t.recordId] : undefined;
    if (!s) return t;
    const d: TradeSync['strategyDecision'] = TICKET_DECISIONS.includes(s.v11.decision) ? 'READY' : ['NOT ELIGIBLE', 'SKIP'].includes(s.v11.decision) ? 'NO TRADE' : 'NO TICKET';
    return { ...t, strategyDecision: d, manualOverride: t.entryQty > 0 && d !== 'READY' };
  });
}

/** What the journal knows about the RB alert behind a trade (all frozen values; null when there is no RB alert). */
export interface SyncContext {
  snap: AlertTimeSnapshot | null;
  candidate: Candidate | null;
  record: AutoAlertRecord | null;
}

const EXIT_REASON: Record<ExitReason, NonNullable<JournalEntry['exitReason']>> = {
  'TARGET HIT': 'TARGET_HIT', 'STOPPED OUT': 'STOP_HIT', 'MANUAL EXIT': 'MANUAL_EXIT', 'CLOSED — EOD': 'CLOSED_EOD',
};
const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/** Broker-owned journal fields: the only fields a later poll may update on an existing broker-synced entry. */
function brokerFacts(t: TradeSync, strategyDecision: TradeSync['strategyDecision']): Partial<JournalEntry> {
  const filled = t.entryQty > 0;
  const closed = t.positionStatus === 'CLOSED';
  const unfilledEnd = !filled && ['CANCELED', 'EXPIRED', 'REJECTED'].includes(t.brokerStatus);
  const reason = closed && t.exitReason ? EXIT_REASON[t.exitReason] : unfilledEnd ? 'CANCELED' : null;
  const outcome: Outcome = closed ? (reason === 'TARGET_HIT' ? 'TARGET_HIT' : reason === 'STOP_HIT' ? 'STOP_HIT' : 'MANUAL_EXIT') : unfilledEnd ? 'CANCELED' : 'OPEN';
  return {
    actualFill: filled ? t.entryAvg : null,
    quantity: t.entryQty,
    positionValue: filled && t.entryAvg !== null ? Math.round(t.entryQty * t.entryAvg * 100) / 100 : 0,
    outcome,
    exitPrice: closed ? t.exitAvg : null,
    brokerStatus: t.brokerStatus,
    positionStatus: t.positionStatus,
    exitReason: reason,
    entryFilledIso: iso(t.entryFilledAt),
    exitFilledIso: closed ? iso(t.exitFilledAt) : null,
    manualOverride: filled && strategyDecision !== 'READY',
  };
}

/**
 * A journal entry for one reconciled broker trade. Fills, quantities, times and the exit come from the broker; the
 * plan (entry/stop/target/planned qty/planned risk) and scores come only from the frozen RB alert snapshot — never
 * recomputed. With no RB alert those fields stay blank/0 and no planned risk or R is invented.
 */
export function journalEntryFromSync(t: TradeSync, ctx: SyncContext): JournalEntry {
  const { snap, candidate, record } = ctx;
  const when = t.entryFilledAt ?? t.submittedAt ?? record?.alert.alertTimeMs ?? 0;
  const et = etParts(when);
  const v = record?.snapshot?.values ?? null;
  const plan = snap?.trade ?? (candidate ? { entry: candidate.entry, stop: candidate.stop, target: candidate.target, shares: candidate.shares, plannedRisk: candidate.plannedRisk, expectedReward: candidate.expectedReward, orderType: candidate.orderType } : null);
  return {
    id: `broker-${t.entryOrderId}`,
    ticker: t.symbol,
    date: et.date,
    time: et.hhmm,
    direction: t.direction,
    open: snap?.ohlc?.open ?? v?.open ?? 0,
    high: snap?.ohlc?.high ?? v?.high ?? 0,
    low: snap?.ohlc?.low ?? v?.low ?? 0,
    close: snap?.ohlc?.close ?? v?.close ?? 0,
    atr: snap?.ohlc?.atr ?? v?.atr ?? 0,
    alertPrice: record?.initialQuote?.price ?? 0,
    decision: record?.calcAtAlert?.action ?? 'NOT_ELIGIBLE',
    orderType: plan?.orderType ?? `${t.direction === 'LONG' ? 'BUY' : 'SELL'} (broker)`,
    plannedEntry: plan?.entry ?? 0,
    stop: plan?.stop ?? 0,
    target: plan?.target ?? 0,
    expectedRisk: plan?.plannedRisk ?? 0,
    expectedReward: plan?.expectedReward ?? 0,
    notes: '',
    rulesVersion: snap?.provenance.rulesVersion ?? record?.versions.rules,
    source: 'broker_sync',
    brokerOrderId: t.entryOrderId,
    alertRecordId: t.recordId,
    strategyDecision: t.strategyDecision,
    plannedQty: plan?.shares ?? null,
    alertTimeIso: record ? new Date(record.alert.alertTimeMs).toISOString() : null,
    ruleSet: snap?.ruleSet ?? null,
    v11Score: snap?.v11.total ?? candidate?.initialScore?.total ?? null,
    v11Tier: snap?.v11.tier ?? candidate?.initialScore?.tier ?? null,
    v12Score: snap?.v12?.total ?? null,
    v12OptionA: snap?.v12?.tierOptionA ?? null,
    v12OptionB: snap?.v12?.tierOptionB ?? null,
    possibleDuplicateOf: null,
    ...brokerFacts(t, t.strategyDecision),
  } as JournalEntry;
}

export interface JournalSyncResult {
  journal: JournalEntry[];
  changed: boolean;
  added: string[];
  updated: string[];
  /** Broker entries added next to a manually logged entry that looks like the same trade (never merged). */
  flagged: string[];
}

const near = (a: number | null | undefined, b: number | null | undefined) => a !== null && a !== undefined && b !== null && b !== undefined && a > 0 && Math.abs(a - b) <= 0.02 + 1e-9;

/**
 * Upsert reconciled trades into the journal, keyed by the broker entry order id (deterministic, so repeated polls
 * never duplicate). An existing broker-synced entry gets ONLY broker-owned fields updated (fills, quantity, exit,
 * statuses); its strategy decision, frozen plan/scores, notes and any field you edited stay as they are. Manual
 * entries are never modified; a manual entry that looks like the same trade is flagged on the new broker entry.
 * Returns the same array object when nothing changed.
 */
export function syncJournal(journal: JournalEntry[], trades: TradeSync[], ctx: (t: TradeSync) => SyncContext): JournalSyncResult {
  let next = journal;
  const added: string[] = [];
  const updated: string[] = [];
  const flagged: string[] = [];
  for (const t of trades) {
    if (!t.entryOrderId) continue;
    const idx = next.findIndex((e) => e.brokerOrderId === t.entryOrderId);
    if (idx < 0) {
      const fresh = journalEntryFromSync(t, ctx(t));
      const dup = next.find((e) => e.source !== 'broker_sync' && e.ticker.toUpperCase() === t.symbol && e.direction === t.direction && e.date === fresh.date && (near(e.actualFill, t.entryAvg) || near(e.plannedEntry, fresh.plannedEntry)));
      if (dup) {
        fresh.possibleDuplicateOf = dup.id;
        flagged.push(fresh.id);
      }
      next = [...next, fresh];
      added.push(fresh.id);
      continue;
    }
    const cur = next[idx];
    if (cur.source !== 'broker_sync') continue; // never touch a manual entry
    const patch = brokerFacts(t, cur.strategyDecision ?? t.strategyDecision);
    const changed = (Object.keys(patch) as (keyof JournalEntry)[]).some((k) => cur[k] !== patch[k]);
    if (!changed) continue;
    next = next.map((e, k) => (k === idx ? { ...e, ...patch } : e));
    updated.push(cur.id);
  }
  return { journal: next, changed: next !== journal, added, updated, flagged };
}
