/**
 * Broker-verified portfolio exposure — ONE model for every decision surface (Live Alert Queue, Opportunity Ranker,
 * score freezing). Read-only Alpaca PAPER facts decide which candidates / positions the EXISTING allocator sees as
 * exposures. No formula, limit or record changes: buildPortfolio / rankCandidates are unchanged.
 *
 * Releases happen only on a VERIFIED broker response (live, for today's ET date, fresh). Anything uncertain — feed off,
 * error, not loaded for today, stale — releases NOTHING (not even earlier releases): historical reservations may then
 * reappear, which can only reduce available capacity, never increase it.
 *
 *   • FILLED candidate → released when the account holds no position and no working order in that ticker.
 *   • PENDING candidate → released only when its entry order is identified deterministically (exactly one order at the
 *     candidate's planned entry within 2 ¢, same ticker / side / ET day, at or after the alert, claimed by no other
 *     candidate) and that order is canceled / expired / rejected with no fill — or filled and the account is now flat.
 *     An unidentifiable PENDING candidate keeps reserving (it may not be at the broker yet).
 *   • Partial fills / partial exits (a position remains) keep the full planned risk. Manual positions are always kept.
 *   • An open broker position no active RB record represents is ADDED conservatively (slot, market value, planned risk
 *     = the per-trade risk limit) — so a new exposure is never invisible.
 *
 * Release lifecycle (write-once records, kept for audit): a release is bound to the EXECUTION it proved closed —
 * the candidate's execution fingerprint (status, execution revision, fill, size, plan) and, when known, the broker
 * order id. It applies only while:
 *   1. the response is verified, and
 *   2. the candidate's fingerprint is unchanged (a new execution — new revision, new fill, new status — voids it), and
 *   3. any current exposure in that ticker (position / working order) is represented by ANOTHER active RB record;
 *      otherwise the current exposure may be this candidate reused → the release is ignored and the candidate counts.
 *
 * Cross-day: "flat" means no position AND no open order from ANY day (`openOrders`: GTC entries, overnight bracket
 * legs) — never only today's submitted orders; an unknown open-order list releases nothing. An earlier-dated candidate's
 * entry order is identified in its entry day's VERIFIED order list (`history`); no verified list → no identification.
 */
import type { Candidate, LifecycleStatus, ManualPosition } from '../../ranker/opportunityTypes';
import { etParts } from '../etTime';
import { brokerOrdersFrom, mapBrokerStatus, type BrokerOrder } from './brokerSync';
import type { Classification } from '../autoCandidate';

export interface BrokerExposureInput {
  /** Live, loaded for the current ET date and fresh. Anything else → no reconciliation at all. */
  verified: boolean;
  /** Orders submitted on the current ET date (bracket legs nested). */
  orders: unknown[];
  positions: { symbol: string; qty?: string | number; side?: string; avg_entry_price?: string | number; market_value?: string | number }[];
  /** Every order open NOW, whatever day it was submitted. null = unknown (not returned, truncated) → no release at all. */
  openOrders: unknown[] | null;
  /** Entry-day order lists for earlier-dated candidates, keyed by ET date — VERIFIED responses only (see verifiedHistory). */
  history?: Record<string, unknown[]>;
}

/** A release record. `fp` binds it to one execution of the candidate; `orderId` is the broker order behind it, if known. */
export interface ReleasedExposure { id: string; ticker: string; status: string; reason: string; atMs: number; fp: string; orderId?: string | null }
export type ReleasedExposureMap = Record<string, ReleasedExposure>;

export interface ExposureAdjustment {
  /** Exposure list (candidates minus `exclude`). Rankers keep ALL candidates and pass `exclude` instead. */
  candidates: Candidate[];
  /** Candidate ids holding no exposure in this evaluation (records are never changed). */
  exclude: ReadonlySet<string>;
  positions: ManualPosition[];
  verified: boolean;
  /** Candidates not reserving capacity in this evaluation (new and still-valid earlier releases). */
  released: ReleasedExposure[];
  /** Earlier releases ignored in this evaluation, with why (audit; the records themselves are kept). */
  voided: { id: string; ticker: string; reason: string }[];
  /** Open broker positions with no RB record, added conservatively. */
  added: { ticker: string; qty: number; plannedRisk: number }[];
}

const num = (x: unknown) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? 0 : Number(x));
const WORKING = ['PENDING', 'PARTIAL'];
const DEAD = ['CANCELED', 'EXPIRED', 'REJECTED'];
const ACTIVE: LifecycleStatus[] = ['PENDING', 'FILLED'];
const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) <= 0.02 + 1e-9;

/** Execution fingerprint: anything that changes when a candidate is used for a new execution. */
export function executionFingerprint(c: Candidate): string {
  return JSON.stringify([c.status, c.executionRev ?? 0, c.actualFill ?? null, c.shares, c.entry, c.plannedRisk]);
}

/**
 * Execution revision for a status change: a NEW execution starts when a candidate enters PENDING from any other status,
 * or enters FILLED other than from PENDING (PENDING → FILLED is the same execution). Returns the patch to apply;
 * `nowMs` also stamps when the execution started (an older broker order is never evidence for it).
 */
export function executionRevPatch(prev: Candidate, next: LifecycleStatus, nowMs?: number): Partial<Candidate> {
  const fresh = (next === 'PENDING' && prev.status !== 'PENDING') || (next === 'FILLED' && prev.status !== 'PENDING' && prev.status !== 'FILLED');
  if (!fresh) return {};
  return { executionRev: (prev.executionRev ?? 0) + 1, ...(nowMs !== undefined ? { executionStartedMs: nowMs } : {}) };
}

/** An entry order may be placed shortly before the candidate is marked PENDING / FILLED. */
const ORDER_BEFORE_MARK_MS = 15 * 60_000;
/** Earliest submission time of an order that can belong to the candidate's current execution. */
const orderSince = (x: Candidate) => Math.max((x.alertMs ?? 0) - 60_000, x.executionStartedMs !== undefined ? x.executionStartedMs - ORDER_BEFORE_MARK_MS : -Infinity);

/** Cross-day lookback: entry-day order lists fetched for at most this many ET dates, within this many calendar days. */
export const HISTORY_MAX_DATES = 5;
export const HISTORY_LOOKBACK_DAYS = 10;

/** ET dates (before today, newest first, bounded) whose orders are needed to identify earlier-dated active candidates. */
export function historyDatesFor(candidates: Candidate[], today: string, maxDates = HISTORY_MAX_DATES, lookbackDays = HISTORY_LOOKBACK_DAYS): string[] {
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const oldest = day(today) - lookbackDays * 86_400_000;
  const dates = new Set(candidates.filter((c) => !c.archived && ACTIVE.includes(c.status) && /^\d{4}-\d{2}-\d{2}$/.test(c.date) && c.date < today && day(c.date) >= oldest).map((c) => c.date));
  return [...dates].sort().reverse().slice(0, maxDates);
}

/** Only entry-day responses that are live, for that date and fresh count as evidence; failed / stale ones are dropped. */
export function verifiedHistory(feeds: Record<string, { status: string; loadedDate?: string | null; lastOkMs: number | null; orders: unknown[] }>, dates: string[], now: number): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const d of dates) if (feeds[d] && brokerVerified(feeds[d], d, now)) out[d] = feeds[d].orders;
  return out;
}

/** The one broker entry order a candidate was placed as (deterministic), or null. */
function entryOrderFor(c: Candidate, orders: BrokerOrder[], all: Candidate[]): BrokerOrder | null {
  const side = c.direction === 'LONG' ? 'buy' : 'sell';
  const eligible = (o: BrokerOrder, x: Candidate) => o.symbol === x.ticker && o.side === (x.direction === 'LONG' ? 'buy' : 'sell') && o.submittedAt !== null
    && etParts(o.submittedAt).date === x.date && o.submittedAt >= orderSince(x) && near(o.stopPrice, x.entry);
  const mine = orders.filter((o) => o.side === side && eligible(o, c));
  if (mine.length !== 1) return null;
  const o = mine[0];
  const claimants = all.filter((x) => !x.archived && ['NEW', 'WATCHLIST', 'PENDING', 'FILLED'].includes(x.status) && eligible(o, x));
  return claimants.length === 1 ? o : null;
}

export function reconcileExposure(candidates: Candidate[], positions: ManualPosition[], broker: BrokerExposureInput | null | undefined, opts: { classify: (s: string) => Classification | null; conservativeRisk: number; latched?: ReleasedExposureMap; now?: number }): ExposureAdjustment {
  // Unverified — or open orders across all days unknown / unreadable: no releases at all (conservative), nothing added.
  const unverified: ExposureAdjustment = { candidates, exclude: new Set(), positions, verified: false, released: [], voided: [], added: [] };
  if (!broker?.verified || !Array.isArray(broker.openOrders)) return unverified;
  const open = brokerOrdersFrom(broker.openOrders);
  if (open.errors.length) return unverified;
  const latched = opts.latched ?? {};
  const now = opts.now ?? Date.now();
  // Today's orders plus the verified entry-day lists of earlier-dated candidates (one entry per order id).
  const ids = new Set<string>();
  const orders = [broker.orders, ...Object.values(broker.history ?? {})].flatMap((l) => brokerOrdersFrom(l).orders).filter((o) => !ids.has(o.id) && !!ids.add(o.id));
  const held = new Map<string, number>();
  for (const p of broker.positions) if (num(p.qty) !== 0) held.set(p.symbol.toUpperCase(), (held.get(p.symbol.toUpperCase()) ?? 0) + num(p.qty));
  const withLegs = (os: BrokerOrder[]) => os.flatMap((o) => [o, ...o.legs]);
  // Working = any open order from any day (incl. bracket legs), plus any working order / leg in the fetched lists.
  const working = new Set([...withLegs(open.orders), ...withLegs(orders).filter((o) => WORKING.includes(mapBrokerStatus(o.status)))].map((o) => o.symbol.toUpperCase()));
  const T = (t: string) => t.toUpperCase();
  const flat = (t: string) => !held.has(T(t)) && !working.has(T(t));
  const active = (c: Candidate) => !c.archived && ACTIVE.includes(c.status);

  const released: ReleasedExposure[] = [];
  const voided: ExposureAdjustment['voided'] = [];
  const out = new Set<string>();
  const rel = (c: Candidate, reason: string, orderId: string | null = null) => {
    released.push({ id: c.id, ticker: c.ticker, status: c.status, reason, atMs: now, fp: executionFingerprint(c), orderId });
    out.add(c.id);
  };

  // Pass 1 — fresh evidence from this verified response.
  for (const c of candidates) {
    if (!active(c)) continue;
    if (c.status === 'FILLED') {
      if (flat(c.ticker)) rel(c, `Alpaca shows no ${c.ticker} position and no open order on any day — closed`, entryOrderFor(c, orders, candidates)?.id ?? null);
      continue;
    }
    const o = entryOrderFor(c, orders, candidates);
    if (!o) continue; // not identifiable at the broker (may not be placed yet) → keep the reservation
    // An order that already proved an EARLIER execution of this candidate closed is that execution's order; it is
    // never evidence about a new execution (e.g. PENDING → canceled → PENDING again before the new order is placed).
    const prior = latched[c.id];
    if (prior?.orderId === o.id && prior.fp !== executionFingerprint(c)) continue;
    const st = mapBrokerStatus(o.status);
    if (DEAD.includes(st) && o.filledQty === 0 && flat(c.ticker)) rel(c, `entry order ${o.id.slice(0, 8)} ${st.toLowerCase()} with no fill`, o.id);
    else if (o.filledQty > 0 && flat(c.ticker)) rel(c, `entry order ${o.id.slice(0, 8)} filled and the position is closed`, o.id);
  }

  // Pass 2 — earlier releases, honoured only for the same execution and only if any current exposure is someone else's.
  for (const c of candidates) {
    if (!active(c) || out.has(c.id)) continue;
    const r = latched[c.id];
    if (!r) continue;
    if (r.fp !== executionFingerprint(c)) {
      voided.push({ id: c.id, ticker: c.ticker, reason: 'candidate used for a new execution since the release' });
      continue;
    }
    if (!flat(c.ticker)) {
      const others = candidates.some((x) => x.id !== c.id && active(x) && !out.has(x.id) && T(x.ticker) === T(c.ticker) && !(latched[x.id] && latched[x.id].fp === executionFingerprint(x)))
        || positions.some((p) => p.status === 'OPEN' && T(p.ticker) === T(c.ticker));
      if (!others) {
        voided.push({ id: c.id, ticker: c.ticker, reason: `${c.ticker} has exposure no other RB record represents — counted again` });
        continue;
      }
    }
    released.push(r);
    out.add(c.id);
  }

  const keep = out.size ? candidates.filter((c) => !out.has(c.id)) : candidates;
  const represented = new Set([
    ...keep.filter(active).map((c) => T(c.ticker)),
    ...positions.filter((p) => p.status === 'OPEN').map((p) => T(p.ticker)),
  ]);
  const added: ExposureAdjustment['added'] = [];
  const extra: ManualPosition[] = [];
  for (const [t, qty] of held) {
    if (represented.has(t)) continue;
    const p = broker.positions.find((x) => T(x.symbol) === t)!;
    const cls = opts.classify(t);
    const value = Math.abs(num(p.market_value)) || Math.abs(qty) * num(p.avg_entry_price);
    extra.push({ id: `broker-position-${t}`, ticker: t, direction: qty < 0 || /short/i.test(p.side ?? '') ? 'SHORT' : 'LONG', sector: cls?.sector ?? '', industry: cls?.industry ?? '', theme: cls?.theme ?? '', positionValue: Math.round(value * 100) / 100, plannedRisk: opts.conservativeRisk, entry: num(p.avg_entry_price), stop: 0, target: 0, status: 'OPEN' });
    added.push({ ticker: t, qty, plannedRisk: opts.conservativeRisk });
  }
  return { candidates: keep, exclude: out, positions: extra.length ? [...positions, ...extra] : positions, verified: true, released, voided, added };
}

/** Write-once latch of releases (existing records never change; same object returned when nothing is new). A record
 *  for a voided execution stays for audit; a later release of a NEW execution of the same candidate replaces it. */
export function latchReleases(prev: ReleasedExposureMap, released: ReleasedExposure[]): { map: ReleasedExposureMap; changed: boolean } {
  let map = prev;
  for (const r of released) {
    const cur = prev[r.id];
    if (cur && cur.fp === r.fp) continue;
    if (map === prev) map = { ...prev };
    map[r.id] = cur ? { ...r, reason: `${r.reason} (previous release ${new Date(cur.atMs).toISOString()} superseded)` } : r;
  }
  return { map, changed: map !== prev };
}

/** A broker response is verified only when live, for today's ET date, and recent (default: within 2 minutes). */
export function brokerVerified(feed: { status: string; loadedDate?: string | null; lastOkMs: number | null } | null | undefined, date: string, now: number, maxAgeMs = 120_000): boolean {
  return !!feed && feed.status === 'LIVE' && feed.loadedDate === date && feed.lastOkMs !== null && now - feed.lastOkMs <= maxAgeMs;
}
