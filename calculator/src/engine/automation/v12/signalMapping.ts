/**
 * RB v1.2 — receipt time → signal candle (RB_V1_2_ARCHITECTURE.md §7).
 *
 * TrendSpider Multi-Factor Alerts are evaluated when the smallest-timeframe (5m) candle closes, and the webhook has
 * no alert-time placeholder, so the signal candle is inferred from the Netlify receipt time R:
 *   B   = the regular-session 5m boundary at or below R (09:30 grid; the session close caps it)
 *   lag = R − B
 *   signal candle = [B − 5 min, B)
 *   lag ≤ 60 s  → ON_TIME   · 60 s < lag ≤ 120 s → DELAYED (warning)   · lag > 120 s → AMBIGUOUS (DATA REVIEW)
 * A receipt before the first candle closes (09:35) or more than 120 s after the session close has no signal candle.
 * The windows are provisional (n = 4 genuine deliveries so far) and are recalibrated in shadow mode.
 */
import { etParts, etToEpoch } from '../etTime';
import { sessionFor, type SessionKind } from '../marketCalendar';
import type { Direction } from '../../tradeCalculator';

const FIVE = 5 * 60_000;

export interface MappingWindows {
  onTimeSec: number;
  delayedSec: number;
}

export const DEFAULT_MAPPING_WINDOWS: MappingWindows = { onTimeSec: 60, delayedSec: 120 };

export type MappingStatus = 'ON_TIME' | 'DELAYED' | 'AMBIGUOUS' | 'BEFORE_FIRST_CANDLE' | 'AFTER_SESSION' | 'NO_SESSION';

export interface SignalMapping {
  status: MappingStatus;
  receivedMs: number;
  session: SessionKind;
  /** Boundary B (end of the mapped candle); null when there is no candle to map. */
  boundaryMs: number | null;
  lagSec: number | null;
  candleStartMs: number | null;
  candleEndMs: number | null;
  /** "HH:MM–HH:MM" ET, or null. */
  label: string | null;
  reason: string;
}

export function mapSignalCandle(receivedMs: number, w: MappingWindows = DEFAULT_MAPPING_WINDOWS): SignalMapping {
  const p = etParts(receivedMs);
  const s = sessionFor(p.date);
  const none = (status: MappingStatus, reason: string): SignalMapping => ({ status, receivedMs, session: s.kind, boundaryMs: null, lagSec: null, candleStartMs: null, candleEndMs: null, label: null, reason });
  if (!s.open || !s.close) return none('NO_SESSION', s.note);
  const open = etToEpoch(p.date, s.open);
  const close = etToEpoch(p.date, s.close);
  if (receivedMs < open + FIVE) return none('BEFORE_FIRST_CANDLE', `Received ${p.hhmmss} ET — no regular-session 5m candle had closed yet (first closes ${etParts(open + FIVE).hhmm}).`);
  const boundary = receivedMs >= close ? close : open + Math.floor((receivedMs - open) / FIVE) * FIVE;
  const lagSec = (receivedMs - boundary) / 1000;
  if (receivedMs >= close && lagSec > w.delayedSec) return none('AFTER_SESSION', `Received ${p.hhmmss} ET — more than ${w.delayedSec} s after the ${s.close} ET session close.`);
  const label = `${etParts(boundary - FIVE).hhmm}–${etParts(boundary).hhmm}`;
  const status: MappingStatus = lagSec <= w.onTimeSec ? 'ON_TIME' : lagSec <= w.delayedSec ? 'DELAYED' : 'AMBIGUOUS';
  const reason =
    status === 'ON_TIME'
      ? `Received ${lagSec.toFixed(1)} s after the ${label} candle closed.`
      : status === 'DELAYED'
        ? `Delivery delayed: received ${lagSec.toFixed(1)} s after the ${label} candle closed (on-time ≤ ${w.onTimeSec} s).`
        : `Received ${lagSec.toFixed(1)} s after the ${label} candle closed (> ${w.delayedSec} s): it could be a delayed delivery of an earlier candle. Not mapped silently.`;
  return { status, receivedMs, session: s.kind, boundaryMs: boundary, lagSec, candleStartMs: boundary - FIVE, candleEndMs: boundary, label, reason };
}

/**
 * RB v1.2 dedupe key: one record per symbol, direction, mapped signal candle and rule set, so a TrendSpider
 * redelivery of the same candle collapses. Unmappable receipts fall back to the receipt second. Prefixed "v12|" so it
 * can never collide with the v1.1 key in the shared dedupe namespace.
 */
export function v12DedupeKey(symbol: string, direction: Direction, m: Pick<SignalMapping, 'candleStartMs' | 'receivedMs'>, ruleSet: string | null): string {
  const slot = m.candleStartMs !== null ? `C${new Date(m.candleStartMs).toISOString()}` : `R${Math.floor(m.receivedMs / 1000)}`;
  return `v12|${symbol}|${direction}|${slot}|${ruleSet ?? '-'}`;
}
