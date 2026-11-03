/**
 * CR-15 — cross-day trade reconciliation for the browser Journal (pure; no I/O, no React).
 *
 * Broker orders are EVENTS; a Journal trade is the logical position lifecycle they belong to. An open broker-synced
 * LONG is closed by its SELL exits (a SHORT by its BUY exits), whatever day they filled on — an opposite-side order is
 * never a new trade by side alone.
 *
 * Exit evidence, strongest first (a weaker rule never overrides a stronger one):
 *   1. the order is a bracket leg of the trade's entry order (parent/child, from the nested broker response);
 *   2. Alpaca's own position_intent on a later opposite-side order (`sell_to_close` / `buy_to_close`; `*_to_open` is a
 *      NEW position, never an exit);
 *   3. position continuity: an opposite-side order without intent is an exit only when exactly ONE open RB trade in
 *      that ticker and direction exists.
 * With two or more open trades in the same ticker and direction, a non-leg closing order is AMBIGUOUS (an intent proves
 * an exit, not which trade) and nothing is attributed.
 * Never: latest order / latest alert / same ticker alone / closest price.
 *
 * Quantities and prices are the broker's order-level cumulative fills (filled_qty, filled_avg_price): exact for P/L
 * (Σ fills = avg × qty), without per-execution timestamps. If the evidence is unverified, truncated or does not contain
 * the trade's entry order or its exits while the account is flat, the trade is RECONCILIATION INCOMPLETE — no exit is
 * ever invented. Only broker-owned fields are patched; strategy decision, manual override, plan, scores and notes are
 * never touched. A Journal row that turns out to be an exit of another trade (the pre-CR-15 "phantom" opposite-side
 * row) is marked superseded — never deleted.
 */
import type { JournalEntry, Outcome } from '../../journal';
import { etParts } from '../etTime';
import { brokerOrdersFrom, type BrokerOrder } from './brokerSync';

export const CR15_LOOKBACK_DAYS = 10;
const EOD_EXIT_FROM = 15 * 60 + 50;

export interface CrossDayEvidence {
  /** Fresh, live, for the requested tickers / window (see crossDayEvidenceVerified). */
  verified: boolean;
  /** The order page was not truncated. */
  complete: boolean;
  from: string;
  symbols: string[];
  /** Raw (sanitized) broker orders, bracket legs nested. */
  orders: unknown[];
  positions: { symbol: string; qty?: string | number; side?: string }[];
  asOfMs: number;
}

export type CrossDayStatus = 'CLOSED' | 'PARTIAL' | 'OPEN' | 'NO_CHANGE' | 'INCOMPLETE' | 'AMBIGUOUS';
export type ExitEvidence = 'BRACKET_LEG' | 'POSITION_INTENT' | 'POSITION_CONTINUITY';

export interface ExitFill { orderId: string; qty: number; avg: number; filledAt: number | null; reason: NonNullable<JournalEntry['exitReason']>; evidence: ExitEvidence }

export interface TradeReconciliation {
  tradeId: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryOrderId: string;
  status: CrossDayStatus;
  entry: { qty: number; avg: number | null; filledAt: number | null } | null;
  exits: ExitFill[];
  closedQty: number;
  realizedPnl: number | null;
  /** Broker-owned Journal fields to update (null = nothing to change). */
  patch: Partial<JournalEntry> | null;
  /** Journal rows (ids) that are exits of this trade and will be marked superseded. */
  supersedes: string[];
  notes: string[];
}

export interface CrossDayPlan {
  trades: TradeReconciliation[];
  /** Rows to mark superseded: id → by trade id + the broker order behind the row. */
  supersede: { id: string; by: string; orderId: string; reason: string }[];
  /** Broker order ids that are exits of a Journal trade (never to be added as a new Journal entry). */
  exitOrderIds: string[];
  /** Trades that could not be reconciled (incomplete history / ambiguous); listed for the preview. */
  unresolved: TradeReconciliation[];
  changed: boolean;
  /** Why no plan could be made at all (unverified / truncated evidence), else null. */
  blocked: string | null;
}

const cents = (x: number) => Math.round(x * 100) / 100;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const minutesEt = (t: number) => { const h = etParts(t).hhmm; return Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5)); };
const exitReasonOfLeg = (o: BrokerOrder): NonNullable<JournalEntry['exitReason']> => (/stop/i.test(o.type) ? 'STOP_HIT' : /limit/i.test(o.type) ? 'TARGET_HIT' : 'MANUAL_EXIT');
const OUTCOME_OF: Record<string, Outcome> = { STOP_HIT: 'STOP_HIT', TARGET_HIT: 'TARGET_HIT', MANUAL_EXIT: 'MANUAL_EXIT', CLOSED_EOD: 'MANUAL_EXIT' };

/** Broker-synced Journal trades CR-15 reconciles: open (not superseded), with a broker entry order. */
export function openBrokerTrades(journal: JournalEntry[]): JournalEntry[] {
  return journal.filter((e) => e.source === 'broker_sync' && !!e.brokerOrderId && e.outcome === 'OPEN' && !e.supersededBy);
}

export type Cr15Mode = 'OFF' | 'PREVIEW' | 'AUTO';

/**
 * Effective CR-15 gate: the SERVER flag (rb-health `cr15Enabled`) AND this browser's mode. An unknown server flag
 * (health not loaded / failed) is OFF, so a cached client mode alone can never run CR-15. Writes only in AUTO.
 */
export function cr15Gate(serverFlag: boolean | null, mode: Cr15Mode): { on: boolean; autoWrites: boolean } {
  const on = serverFlag === true && mode !== 'OFF';
  return { on, autoWrites: on && mode === 'AUTO' };
}

/** Tickers + earliest entry date to request (bounded to the lookback); trades older than that are reported separately. */
export function crossDayRequest(journal: JournalEntry[], today: string, lookbackDays = CR15_LOOKBACK_DAYS): { symbols: string[]; from: string | null; outOfRange: string[] } {
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const oldest = day(today) - lookbackDays * 86_400_000;
  const open = openBrokerTrades(journal);
  const inRange = open.filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && day(e.date) >= oldest && e.date <= today);
  const symbols = [...new Set(inRange.map((e) => e.ticker.toUpperCase()))].sort();
  const from = inRange.length ? inRange.map((e) => e.date).sort()[0] : null;
  return { symbols, from, outOfRange: open.filter((e) => !inRange.includes(e)).map((e) => e.id) };
}

/** Evidence counts only when live, fresh (default 2 min) and for exactly the requested tickers / window. */
export function crossDayEvidenceVerified(feed: { status: string; lastOkMs: number | null; from?: string | null; symbols?: string[] | null } | null | undefined, req: { symbols: string[]; from: string | null }, now: number, maxAgeMs = 120_000): boolean {
  return !!feed && feed.status === 'LIVE' && feed.lastOkMs !== null && now - feed.lastOkMs <= maxAgeMs && feed.from === req.from
    && JSON.stringify([...(feed.symbols ?? [])].sort()) === JSON.stringify([...req.symbols].sort());
}

export function planCrossDay(journal: JournalEntry[], ev: CrossDayEvidence | null): CrossDayPlan {
  const empty = (blocked: string | null): CrossDayPlan => ({ trades: [], supersede: [], exitOrderIds: [], unresolved: [], changed: false, blocked });
  const open = openBrokerTrades(journal);
  if (!open.length) return empty(null);
  if (!ev || !ev.verified) return empty('Broker history not verified (unavailable, stale or for other tickers) — nothing is reconciled.');
  if (!ev.complete) return empty('Broker history may be truncated (a full page was returned) — RECONCILIATION INCOMPLETE, nothing is reconciled.');
  const parsed = brokerOrdersFrom(ev.orders);
  if (parsed.errors.length) return empty('Broker history unreadable — nothing is reconciled.');

  // Every order once (parents and their nested legs); legs remember their parent.
  const byId = new Map<string, BrokerOrder>();
  const parentOf = new Map<string, string>();
  for (const o of parsed.orders) {
    byId.set(o.id, o);
    for (const l of o.legs) { byId.set(l.id, l); parentOf.set(l.id, o.id); }
  }
  const held = new Map<string, number>();
  for (const p of ev.positions) {
    const q = Number(p.qty ?? 0) * (/short/i.test(p.side ?? '') && Number(p.qty ?? 0) > 0 ? -1 : 1);
    if (q) held.set(p.symbol.toUpperCase(), (held.get(p.symbol.toUpperCase()) ?? 0) + q);
  }
  const requested = new Set(ev.symbols.map((s) => s.toUpperCase()));
  const evidenceStart = Date.parse(`${ev.from}T00:00:00Z`);
  const journalOrderIds = new Map(journal.filter((e) => e.brokerOrderId).map((e) => [e.brokerOrderId as string, e]));
  const claimed = new Set<string>();
  const trades: TradeReconciliation[] = [];

  for (const t of [...open].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))) {
    const symbol = t.ticker.toUpperCase();
    const direction = t.direction as 'LONG' | 'SHORT';
    const base = { tradeId: t.id, symbol, direction, entryOrderId: t.brokerOrderId as string, exits: [] as ExitFill[], closedQty: 0, realizedPnl: null, patch: null, supersedes: [] as string[], notes: [] as string[] };
    if (!requested.has(symbol) || Date.parse(`${t.date}T00:00:00Z`) < evidenceStart) {
      trades.push({ ...base, status: 'INCOMPLETE', entry: null, notes: ['Entry day is outside the verified broker history window.'] });
      continue;
    }
    const e = byId.get(t.brokerOrderId as string);
    if (!e) {
      trades.push({ ...base, status: 'INCOMPLETE', entry: null, notes: ['The entry order is not in the verified broker history.'] });
      continue;
    }
    if (parentOf.has(e.id)) {
      // A bracket leg recorded as its own trade before CR-15: when its parent is an open Journal trade it is that
      // trade's exit (superseded below), not a trade of its own; with no such parent it cannot be resolved.
      if (open.some((x) => x.brokerOrderId === parentOf.get(e.id))) continue;
      trades.push({ ...base, status: 'AMBIGUOUS', entry: null, notes: ['This Journal row is a bracket leg of an order that is not an open Journal trade — not reconciled.'] });
      continue;
    }
    const entry = { qty: e.filledQty, avg: e.filledAvgPrice, filledAt: e.filledAt };
    const exitSide = e.side === 'buy' ? 'sell' : 'buy';
    const exits: ExitFill[] = [];
    const notes: string[] = [];
    let remaining = e.filledQty;
    // 1. bracket legs of this entry
    for (const l of e.legs) {
      if (l.filledQty <= 0 || remaining <= 0) continue;
      const qty = Math.min(l.filledQty, remaining);
      exits.push({ orderId: l.id, qty, avg: l.filledAvgPrice ?? 0, filledAt: l.filledAt, reason: exitReasonOfLeg(l), evidence: 'BRACKET_LEG' });
      claimed.add(l.id);
      remaining -= qty;
    }
    // 2./3. later opposite-side orders that are not legs of any parent and not another trade's entry
    const siblings = open.filter((x) => x.id !== t.id && x.ticker.toUpperCase() === symbol && x.direction === direction);
    const later = parsed.orders
      .filter((o) => o.symbol === symbol && o.side === exitSide && o.id !== e.id && !parentOf.has(o.id) && !claimed.has(o.id) && o.filledQty > 0 && (o.submittedAt ?? 0) >= (e.filledAt ?? e.submittedAt ?? 0))
      .sort((a, b) => (a.filledAt ?? a.submittedAt ?? 0) - (b.filledAt ?? b.submittedAt ?? 0));
    for (const o of later) {
      if (remaining <= 0) break;
      const intent = o.positionIntent ?? null;
      if (intent && /_to_open$/.test(intent)) continue; // a new position, never an exit
      // An intent proves "exit", not WHICH trade: with another open trade in this ticker and direction nothing is attributed.
      if (siblings.length) { notes.push(`${symbol} closing order ${o.id.slice(0, 8)} could belong to ${siblings.length + 1} open trades — AMBIGUOUS, not attributed.`); continue; }
      const evidence: ExitEvidence = intent && /_to_close$/.test(intent) ? 'POSITION_INTENT' : 'POSITION_CONTINUITY';
      const qty = Math.min(o.filledQty, remaining);
      if (o.filledQty > remaining) notes.push(`Order ${o.id.slice(0, 8)} filled ${o.filledQty}, ${o.filledQty - remaining} more than this position — the excess is new opposite exposure (a separate trade), not part of this one.`);
      exits.push({ orderId: o.id, qty, avg: o.filledAvgPrice ?? 0, filledAt: o.filledAt, reason: o.filledAt !== null && minutesEt(o.filledAt) >= EOD_EXIT_FROM ? 'CLOSED_EOD' : 'MANUAL_EXIT', evidence });
      claimed.add(o.id);
      remaining -= qty;
    }
    const closedQty = exits.reduce((n, x) => n + x.qty, 0);
    const exitAvg = closedQty ? exits.reduce((n, x) => n + x.qty * x.avg, 0) / closedQty : null;
    const sign = direction === 'LONG' ? 1 : -1;
    const realizedPnl = closedQty && entry.avg !== null && exitAvg !== null ? cents(sign * (exitAvg - entry.avg) * closedQty) : null;
    const pos = held.get(symbol) ?? 0;
    const fullyClosed = entry.qty > 0 && closedQty >= entry.qty;
    let status: CrossDayStatus;
    if (entry.qty <= 0) status = 'NO_CHANGE'; // never filled: the same-day sync owns unfilled / canceled entries
    else if (fullyClosed) status = 'CLOSED';
    else if (pos === 0 && closedQty < entry.qty) {
      status = 'INCOMPLETE';
      notes.push(`Alpaca shows no ${symbol} position, but only ${closedQty} of ${entry.qty} shares have a verified exit — no exit is invented.`);
    } else status = closedQty > 0 ? 'PARTIAL' : 'OPEN';
    if (fullyClosed && pos !== 0) notes.push(`Alpaca currently holds ${pos} ${symbol} — a different position than this (fully exited) trade.`);
    const last = exits[exits.length - 1] ?? null;
    let patch: Partial<JournalEntry> | null = null;
    if (status === 'CLOSED') {
      const reason = last!.reason;
      patch = {
        actualFill: entry.avg, quantity: entry.qty, positionValue: entry.avg !== null ? cents(entry.qty * entry.avg) : t.positionValue,
        outcome: OUTCOME_OF[reason], exitPrice: exitAvg !== null ? Math.round(exitAvg * 10_000) / 10_000 : null, exitReason: reason, positionStatus: 'CLOSED', brokerStatus: 'FILLED',
        entryFilledIso: iso(entry.filledAt), exitFilledIso: iso(last!.filledAt), exitOrderIds: exits.map((x) => x.orderId), exitQty: closedQty, realizedPnl, reconciliation: 'CR15',
      };
    } else if (status === 'PARTIAL') {
      patch = { exitOrderIds: exits.map((x) => x.orderId), exitQty: closedQty, realizedPnl, reconciliation: 'CR15' };
    }
    if (patch) {
      const changed = (Object.keys(patch) as (keyof JournalEntry)[]).some((k) => JSON.stringify(t[k] ?? null) !== JSON.stringify(patch![k] ?? null));
      if (!changed) { patch = null; status = status === 'CLOSED' ? 'NO_CHANGE' : status; }
    }
    const supersedes = exits.map((x) => journalOrderIds.get(x.orderId)).filter((r): r is JournalEntry => !!r && r.id !== t.id && !r.supersededBy).map((r) => r.id);
    trades.push({ ...base, status, entry, exits, closedQty, realizedPnl, patch, supersedes, notes });
  }

  const supersede = trades.flatMap((x) => x.supersedes.map((id) => {
    const row = journal.find((r) => r.id === id)!;
    return { id, by: x.tradeId, orderId: row.brokerOrderId as string, reason: `Exit of ${x.direction} ${x.symbol} ${x.tradeId} (order ${String(row.brokerOrderId).slice(0, 8)}) — recorded as a separate ${row.direction} trade before CR-15.` };
  }));
  const exitOrderIds = [...new Set([...trades.flatMap((x) => x.exits.map((f) => f.orderId)), ...journal.flatMap((r) => r.exitOrderIds ?? [])])];
  const unresolved = trades.filter((x) => x.status === 'INCOMPLETE' || x.status === 'AMBIGUOUS');
  return { trades, supersede, exitOrderIds, unresolved, changed: trades.some((x) => x.patch) || supersede.length > 0, blocked: null };
}

/** Apply a plan (pure): patched trades + superseded rows; the same array when nothing changes. Never deletes a row. */
export function applyCrossDay(journal: JournalEntry[], plan: CrossDayPlan, nowIso: string): JournalEntry[] {
  if (!plan.changed) return journal;
  const patches = new Map(plan.trades.filter((x) => x.patch).map((x) => [x.tradeId, x.patch as Partial<JournalEntry>]));
  const sup = new Map(plan.supersede.map((s) => [s.id, s]));
  return journal.map((e) => {
    const p = patches.get(e.id);
    const s = sup.get(e.id);
    if (!p && !s) return e;
    return { ...e, ...(p ? { ...p, reconciledIso: nowIso } : {}), ...(s ? { supersededBy: s.by, supersededReason: s.reason, supersededIso: nowIso } : {}) };
  });
}

/** Fields CR-15 never changes: user notes, strategy classification, the frozen plan and scores, identity. */
const PROTECTED: (keyof JournalEntry)[] = [
  'id', 'ticker', 'date', 'time', 'direction', 'notes', 'strategyDecision', 'manualOverride', 'alertRecordId', 'alertLinkage', 'brokerOrderId', 'source',
  'plannedEntry', 'stop', 'target', 'expectedRisk', 'expectedReward', 'plannedQty', 'v11Score', 'v11Tier', 'v12Score', 'v12OptionA', 'v12OptionB', 'ruleSet', 'alertTimeIso', 'decision', 'orderType', 'hardFailCodes', 'rulesVersion',
];

/** Structural validation before any write: every original row kept (same ids, same order), no duplicates, sane fields. */
export function validateReconciledJournal(before: JournalEntry[], after: JournalEntry[]): string | null {
  if (!Array.isArray(after) || after.length !== before.length) return 'Row count changed — refusing to write.';
  const ids = new Set<string>();
  for (let k = 0; k < after.length; k++) {
    const a = after[k];
    if (!a || typeof a.id !== 'string' || a.id !== before[k].id) return `Row ${k + 1} identity changed — refusing to write.`;
    if (ids.has(a.id)) return `Duplicate row id ${a.id} — refusing to write.`;
    ids.add(a.id);
    if (PROTECTED.some((f) => JSON.stringify(a[f] ?? null) !== JSON.stringify(before[k][f] ?? null))) return `Protected fields changed on ${a.id} — refusing to write.`;
    if (a.realizedPnl !== undefined && a.realizedPnl !== null && !Number.isFinite(a.realizedPnl)) return `Invalid realized P/L on ${a.id}.`;
  }
  return null;
}
