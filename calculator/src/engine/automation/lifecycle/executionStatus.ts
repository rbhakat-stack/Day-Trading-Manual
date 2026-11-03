/**
 * Current EXECUTION status of a candidate, kept separate from its opportunity quality (score / tier):
 *   RB candidate status   — user-maintained (never rewritten here)
 *   Broker entry order    — from the read-only reconciliation, only when DETERMINISTICALLY linked to this candidate's
 *                           alert (reconcileBroker: unique price match; NO_PRICE_MATCH / AMBIGUOUS are never linked)
 *   Broker position       — OPEN / CLOSED / NONE for that linked execution
 *   Effective state       — whether a NEW entry from this candidate is permitted (it never is once submitted / filled)
 * Display only: nothing here changes a candidate, a score, a ticket or a broker order.
 */
import type { Candidate } from '../../ranker/opportunityTypes';
import { etParts } from '../etTime';
import type { TradeSync } from './brokerSync';

export const ALREADY_EXECUTED = 'ALREADY EXECUTED — DO NOT SUBMIT ANOTHER ENTRY';
export const ORDER_PENDING = 'ORDER PENDING — DO NOT DUPLICATE';
export const PENDING_UNVERIFIED = 'PENDING — BROKER LINK UNVERIFIED — DO NOT DUPLICATE';
export const PARTIALLY_FILLED = 'PARTIALLY FILLED — DO NOT DUPLICATE';
export const EXECUTED_CLOSED = 'EXECUTED — POSITION CLOSED — NO NEW ENTRY FROM THIS ALERT';
export const ENTRY_CANCELED = 'BROKER ENTRY CANCELED / REJECTED — NO FILL';
export const IN_POSITION_UNVERIFIED = 'IN POSITION (user-maintained) — DO NOT SUBMIT ANOTHER ENTRY';

export interface ExecutionStatus {
  candidateId: string;
  /** e.g. "PENDING (user-maintained)". */
  candidate: string;
  /** e.g. "FILLED — 75 sh @ $263.55" / "UNLINKED — …" / null when there is no broker information to show. */
  brokerEntry: string | null;
  /** e.g. "OPEN — LONG 75". */
  brokerPosition: string | null;
  /** Effective execution state; null = the candidate has no execution (normal evaluation applies). */
  effective: string | null;
  /** A new entry from THIS candidate is permitted. False once submitted / filled / unverifiable. */
  newEntryPermitted: boolean;
  /** Broker facts are fresh-verified (false = last known, or unavailable). */
  verified: boolean;
  /** Broker order id(s) deterministically linked to this candidate. */
  orderIds: string[];
  notes: string[];
}

const usd = (x: number) => `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ACTIVE = ['PENDING', 'FILLED'];

/**
 * @param trades  read-only reconciliation of today's broker orders (null = broker facts unavailable)
 * @param broker  verification of those facts (fresh / last known at)
 */
export function executionStatus(c: Candidate, trades: TradeSync[] | null, broker: { verified: boolean; asOfMs: number | null }): ExecutionStatus {
  const base = { candidateId: c.id, candidate: `${c.status.replace(/_/g, ' ')} (user-maintained)`, orderIds: [] as string[], notes: [] as string[] };
  if (!ACTIVE.includes(c.status) || c.archived) return { ...base, brokerEntry: null, brokerPosition: null, effective: null, newEntryPermitted: c.status === 'NEW' || c.status === 'WATCHLIST', verified: broker.verified };
  const linked = (trades ?? []).filter((t) => t.linkage === 'MATCHED' && t.recordId === c.id);
  const unlinked = (trades ?? []).filter((t) => t.recordId === null && t.symbol === c.ticker.toUpperCase());
  const notes = [...base.notes];
  if (unlinked.length) notes.push(`${unlinked.length} ${c.ticker} broker order(s) today are not linked to any RB alert (${unlinked.map((t) => t.linkage === 'AMBIGUOUS' ? 'ambiguous' : 'no price match').join(', ')}) — not attributed to this candidate.`);
  const asOf = broker.asOfMs !== null ? `${etParts(broker.asOfMs).hhmmss} ET` : null;
  if (trades && !broker.verified) notes.push(`Broker facts are last known${asOf ? ` at ${asOf}` : ''} — not currently verified.`);
  const fallback = c.status === 'FILLED' ? IN_POSITION_UNVERIFIED : PENDING_UNVERIFIED;
  if (!linked.length) {
    const why = trades === null ? 'broker data unavailable' : c.date !== (broker.asOfMs !== null ? etParts(broker.asOfMs).date : c.date) ? 'entry day is not in today\'s broker orders' : 'no broker order deterministically linked to this alert';
    return { ...base, notes, brokerEntry: `UNLINKED — ${why}`, brokerPosition: null, effective: fallback, newEntryPermitted: false, verified: false };
  }
  const orderIds = linked.map((t) => t.entryOrderId);
  const filled = linked.filter((t) => t.entryQty > 0);
  const dir = (t: TradeSync) => t.direction;
  const brokerVerified = broker.verified;
  if (filled.length) {
    const qty = filled.reduce((a, t) => a + t.entryQty, 0);
    const avg = filled.reduce((a, t) => a + t.entryQty * (t.entryAvg ?? 0), 0) / qty;
    const open = filled.filter((t) => t.positionStatus === 'OPEN');
    const openQty = open.reduce((a, t) => a + (t.entryQty - t.exitQty), 0);
    const partial = linked.some((t) => t.brokerStatus === 'PARTIAL');
    const entry = `${partial ? 'PARTIALLY FILLED' : 'FILLED'} — ${qty.toLocaleString('en-US')} sh @ ${usd(Math.round(avg * 100) / 100)}${linked.length > 1 ? ` (${linked.length} linked orders)` : ''}`;
    const position = open.length ? `OPEN — ${dir(open[0])} ${openQty.toLocaleString('en-US')}` : 'CLOSED';
    const effective = partial ? PARTIALLY_FILLED : open.length ? ALREADY_EXECUTED : EXECUTED_CLOSED;
    return { ...base, notes, orderIds, brokerEntry: entry, brokerPosition: position, effective, newEntryPermitted: false, verified: brokerVerified };
  }
  if (linked.some((t) => t.brokerStatus === 'PENDING' || t.brokerStatus === 'PARTIAL')) {
    return { ...base, notes, orderIds, brokerEntry: 'WORKING — accepted, not filled', brokerPosition: 'NONE', effective: ORDER_PENDING, newEntryPermitted: false, verified: brokerVerified };
  }
  if (linked.every((t) => ['CANCELED', 'EXPIRED', 'REJECTED'].includes(t.brokerStatus))) {
    notes.push('The candidate is still marked as submitted. RB does not change it: update its status in the Ranker to re-evaluate; expired, chased and SETUP FAILED alerts stay terminal.');
    return { ...base, notes, orderIds, brokerEntry: `${[...new Set(linked.map((t) => t.brokerStatus))].join(' / ')} — 0 filled`, brokerPosition: 'NONE', effective: ENTRY_CANCELED, newEntryPermitted: false, verified: brokerVerified };
  }
  return { ...base, notes, orderIds, brokerEntry: `UNKNOWN — broker status ${linked.map((t) => t.brokerStatus).join(', ')}`, brokerPosition: null, effective: fallback, newEntryPermitted: false, verified: false };
}

/** Short Ranker table label for an execution (the full effective state is in the detail panels). */
export function executionShortLabel(x: ExecutionStatus): string | null {
  switch (x.effective) {
    case ALREADY_EXECUTED: return 'EXECUTED — NO NEW ENTRY';
    case PARTIALLY_FILLED: return 'PARTIAL FILL — NO DUPLICATE';
    case EXECUTED_CLOSED: return 'EXECUTED — CLOSED';
    case ORDER_PENDING: return 'ORDER PENDING — NO DUPLICATE';
    case ENTRY_CANCELED: return 'BROKER ENTRY CANCELED';
    case PENDING_UNVERIFIED: return 'PENDING — LINK UNVERIFIED';
    case IN_POSITION_UNVERIFIED: return 'IN POSITION — NO NEW ENTRY';
    default: return null;
  }
}
