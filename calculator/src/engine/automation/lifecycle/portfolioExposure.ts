/**
 * Broker-verified portfolio exposure (read-only Alpaca PAPER facts → which exposures the EXISTING portfolio
 * allocator sees). No formula, limit or record changes: the allocator (buildPortfolio / rankCandidates) is unchanged;
 * this only decides which candidates / positions are passed to it as exposures.
 *
 * Rules — conservative unless the broker response is VERIFIED (live, for today's ET date, and fresh):
 *   • unverified (feed off / error / not loaded for today / stale) → nothing released, nothing added (today's behaviour);
 *   • a FILLED candidate is released only when the account holds NO position in that ticker and NO working
 *     (pending / partially filled) order in it — then no open exposure exists to attribute, so no trades can be
 *     conflated by ticker;
 *   • a PENDING candidate is released only when its entry order is identified deterministically (exactly one order
 *     at the candidate's planned entry within 2 ¢, same ticker / side / ET day, at or after the alert, and that order
 *     matches no other candidate) and that order is canceled / expired / rejected with no fill — or it filled and the
 *     account is now flat with no working order. An unlinked PENDING candidate keeps reserving (it may not be at the
 *     broker yet);
 *   • open broker positions represented by an active candidate or open manual position are counted once (by the RB
 *     record, never twice); an open broker position with no RB record is ADDED as a conservative exposure (slot,
 *     market value, planned risk = the per-trade risk limit, since its real plan is unknown) — never ignored;
 *   • manual positions are always kept (they may be held elsewhere);
 *   • a release is LATCHED per candidate id (write-once): a broker-confirmed closed trade cannot reopen, so it stays
 *     released after a reload, a broker outage, or a NEW position later opened in the same ticker (that is a new
 *     trade, counted by its own record). Latched releases only ever come from verified evidence.
 * Candidate and position records are returned untouched; only the exposure lists differ.
 */
import type { Candidate, ManualPosition } from '../../ranker/opportunityTypes';
import { etParts } from '../etTime';
import { brokerOrdersFrom, mapBrokerStatus, type BrokerOrder } from './brokerSync';
import type { Classification } from '../autoCandidate';

export interface BrokerExposureInput {
  /** Live, loaded for the current ET date and fresh. Anything else → no reconciliation at all. */
  verified: boolean;
  orders: unknown[];
  positions: { symbol: string; qty?: string | number; side?: string; avg_entry_price?: string | number; market_value?: string | number }[];
}

export interface ReleasedExposure { id: string; ticker: string; status: string; reason: string; atMs: number }
export type ReleasedExposureMap = Record<string, ReleasedExposure>;

export interface ExposureAdjustment {
  candidates: Candidate[];
  positions: ManualPosition[];
  verified: boolean;
  /** Candidates no longer reserving capacity, with the broker evidence. */
  released: ReleasedExposure[];
  /** Open broker positions with no RB record, added conservatively. */
  added: { ticker: string; qty: number; plannedRisk: number }[];
}

const num = (x: unknown) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? 0 : Number(x));
const WORKING = ['PENDING', 'PARTIAL'];
const DEAD = ['CANCELED', 'EXPIRED', 'REJECTED'];
const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) <= 0.02 + 1e-9;

/** The one broker entry order a candidate was placed as (deterministic), or null. */
function entryOrderFor(c: Candidate, orders: BrokerOrder[], all: Candidate[]): BrokerOrder | null {
  const side = c.direction === 'LONG' ? 'buy' : 'sell';
  const eligible = (o: BrokerOrder, x: Candidate) => o.symbol === x.ticker && o.side === (x.direction === 'LONG' ? 'buy' : 'sell') && o.submittedAt !== null
    && etParts(o.submittedAt).date === x.date && o.submittedAt >= (x.alertMs ?? 0) - 60_000 && near(o.stopPrice, x.entry);
  const mine = orders.filter((o) => o.side === side && eligible(o, c));
  if (mine.length !== 1) return null;
  const o = mine[0];
  const claimants = all.filter((x) => !x.archived && ['NEW', 'WATCHLIST', 'PENDING', 'FILLED'].includes(x.status) && eligible(o, x));
  return claimants.length === 1 ? o : null;
}

export function reconcileExposure(candidates: Candidate[], positions: ManualPosition[], broker: BrokerExposureInput | null | undefined, opts: { classify: (s: string) => Classification | null; conservativeRisk: number; latched?: ReleasedExposureMap; now?: number }): ExposureAdjustment {
  const latched = opts.latched ?? {};
  const isLatched = (c: Candidate) => !!latched[c.id] && (c.status === 'FILLED' || c.status === 'PENDING');
  if (!broker?.verified) {
    // Unverified: nothing new is released and nothing is added; only releases already proven earlier still apply.
    const prior = candidates.filter(isLatched);
    return { candidates: prior.length ? candidates.filter((c) => !isLatched(c)) : candidates, positions, verified: false, released: prior.map((c) => latched[c.id]), added: [] };
  }
  const now = opts.now ?? Date.now();
  const { orders } = brokerOrdersFrom(broker.orders);
  const held = new Map<string, number>();
  for (const p of broker.positions) if (num(p.qty) !== 0) held.set(p.symbol.toUpperCase(), (held.get(p.symbol.toUpperCase()) ?? 0) + num(p.qty));
  const working = new Set(orders.filter((o) => WORKING.includes(mapBrokerStatus(o.status))).map((o) => o.symbol));
  const flat = (t: string) => !held.has(t.toUpperCase()) && !working.has(t.toUpperCase());

  const released: ReleasedExposure[] = [];
  const rel = (c: Candidate, reason: string) => released.push({ id: c.id, ticker: c.ticker, status: c.status, reason, atMs: now });
  const keep = candidates.filter((c) => {
    if (c.archived || (c.status !== 'FILLED' && c.status !== 'PENDING')) return true;
    if (isLatched(c)) {
      released.push(latched[c.id]);
      return false;
    }
    if (c.status === 'FILLED') {
      if (!flat(c.ticker)) return true;
      rel(c, `Alpaca shows no ${c.ticker} position and no working order — closed`);
      return false;
    }
    const o = entryOrderFor(c, orders, candidates);
    if (!o) return true; // not identifiable at the broker (may not be placed yet) → keep the reservation
    const st = mapBrokerStatus(o.status);
    if (DEAD.includes(st) && o.filledQty === 0 && flat(c.ticker)) {
      rel(c, `entry order ${o.id.slice(0, 8)} ${st.toLowerCase()} with no fill`);
      return false;
    }
    if (o.filledQty > 0 && flat(c.ticker)) {
      rel(c, `entry order ${o.id.slice(0, 8)} filled and the position is closed`);
      return false;
    }
    return true;
  });

  const represented = new Set([
    ...keep.filter((c) => !c.archived && (c.status === 'FILLED' || c.status === 'PENDING')).map((c) => c.ticker.toUpperCase()),
    ...positions.filter((p) => p.status === 'OPEN').map((p) => p.ticker.toUpperCase()),
  ]);
  const added: ExposureAdjustment['added'] = [];
  const extra: ManualPosition[] = [];
  for (const [t, qty] of held) {
    if (represented.has(t)) continue;
    const p = broker.positions.find((x) => x.symbol.toUpperCase() === t)!;
    const cls = opts.classify(t);
    const value = Math.abs(num(p.market_value)) || Math.abs(qty) * num(p.avg_entry_price);
    extra.push({ id: `broker-position-${t}`, ticker: t, direction: qty < 0 || /short/i.test(p.side ?? '') ? 'SHORT' : 'LONG', sector: cls?.sector ?? '', industry: cls?.industry ?? '', theme: cls?.theme ?? '', positionValue: Math.round(value * 100) / 100, plannedRisk: opts.conservativeRisk, entry: num(p.avg_entry_price), stop: 0, target: 0, status: 'OPEN' });
    added.push({ ticker: t, qty, plannedRisk: opts.conservativeRisk });
  }
  return { candidates: released.length ? keep : candidates, positions: extra.length ? [...positions, ...extra] : positions, verified: true, released, added };
}

/** Write-once latch of releases (existing entries never change; same object returned when nothing is new). */
export function latchReleases(prev: ReleasedExposureMap, released: ReleasedExposure[]): { map: ReleasedExposureMap; changed: boolean } {
  let map = prev;
  for (const r of released) {
    if (prev[r.id]) continue;
    if (map === prev) map = { ...prev };
    map[r.id] = r;
  }
  return { map, changed: map !== prev };
}

/** A broker response is verified only when live, for today's ET date, and recent (default: within 2 minutes). */
export function brokerVerified(feed: { status: string; loadedDate?: string | null; lastOkMs: number | null } | null | undefined, date: string, now: number, maxAgeMs = 120_000): boolean {
  return !!feed && feed.status === 'LIVE' && feed.loadedDate === date && feed.lastOkMs !== null && now - feed.lastOkMs <= maxAgeMs;
}
