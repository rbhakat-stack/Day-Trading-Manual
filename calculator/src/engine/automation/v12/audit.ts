/**
 * RB v1.2 — additive audit record (RB_V1_2_ARCHITECTURE.md §15), written by the server next to the unchanged v1.1
 * record while v1.2 runs in SHADOW mode. v1.1 code never reads `v12`; a missing `v12` means a pre-v1.2 record.
 *
 *   at receipt     → qualification (trust boundary), signal mapping, dedupe keys (v1.1 + v1.2), v1.2 duplicate link
 *   at enrichment  → reconstruction (SIP), forming 15m, condition diagnostics, warnings, integrity (DATA REVIEW) codes,
 *                    alert-time ticket reference
 * Immutable once the record is OK (same rule as the v1.1 snapshot).
 */
import type { AutoAlertRecord, ParityTolerance } from '../alertDecision';
import type { SnapshotResult } from '../alertSnapshot';
import type { Bar } from '../indicators';
import type { Direction } from '../../tradeCalculator';
import { classifyConditions, forming15m, type ConditionDiagnostic, type Forming15m } from './parityDiagnostics';
import { qualify, readRuleSet, type Qualification, type RuleSetEntry } from './ruleSets';
import { mapSignalCandle, v12DedupeKey, type MappingWindows, type SignalMapping } from './signalMapping';

export const V12_AUDIT_SCHEMA = 1;
export const RB_V1_2 = 'RB v1.2';

export interface V12Reconstruction {
  source: 'SIP';
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  atr14: number | null;
  vwap: number | null;
  ema9: number | null;
  ema20: number | null;
  rsi14: number | null;
  /** Diagnostic only — never used to validate TrendSpider RVOL. */
  sipRvol: number | null;
  close15mCompleted: number | null;
  ema20_15mCompleted: number | null;
  forming15m: Forming15m | null;
}

export interface V12Audit {
  schema: typeof V12_AUDIT_SCHEMA;
  logicVersion: typeof RB_V1_2;
  /** SHADOW while v1.1 is the active decision path. */
  mode: 'SHADOW';
  qualification: Qualification;
  signalMapping: SignalMapping;
  dedupeKeys: { v11: string; v12: string };
  /** Id of the earlier record holding the same v1.2 key (same symbol/direction/candle/rule set), else null. */
  duplicateOf: string | null;
  reconstruction: V12Reconstruction | null;
  conditionDiagnostics: ConditionDiagnostic[];
  warnings: string[];
  /** Integrity problems found at processing (DATA REVIEW codes). Indicator disagreement is never listed here. */
  dataReview: string[];
  ticketAtAlert: { entry: number | null; stop: number | null; target: number | null; shares: number | null; plannedRisk: number | null } | null;
  /** Set only if building the audit failed; v1.1 processing is never affected. */
  error?: string;
}

export type AutoAlertRecordV12 = AutoAlertRecord & { v12?: V12Audit };

/** Receipt-time part of the audit. The record is only stored after the webhook token check, so it is authenticated. */
export function receiptAudit(args: { body: unknown; symbol: string; direction: Direction; receivedMs: number; v11Key: string; registry?: readonly RuleSetEntry[]; windows?: MappingWindows }): V12Audit {
  const ruleSet = readRuleSet(args.body);
  const signalMapping = mapSignalCandle(args.receivedMs, args.windows);
  return {
    schema: V12_AUDIT_SCHEMA,
    logicVersion: RB_V1_2,
    mode: 'SHADOW',
    qualification: qualify({ authenticated: true, test: false, ruleSet, direction: args.direction, registry: args.registry }),
    signalMapping,
    dedupeKeys: { v11: args.v11Key, v12: v12DedupeKey(args.symbol, args.direction, signalMapping, ruleSet) },
    duplicateOf: null,
    reconstruction: null,
    conditionDiagnostics: [],
    warnings: [],
    dataReview: [],
    ticketAtAlert: null,
  };
}

/** Snapshot issue codes that are objective reconstruction / integrity problems (RB_V1_2_ARCHITECTURE.md §9). */
export const INTEGRITY_CODES = [
  'SIGNAL_CANDLE_MISSING', 'SIGNAL_CANDLE_INVALID', 'NO_COMPLETED_SIGNAL_CANDLE', 'ATR14_UNAVAILABLE', 'INSUFFICIENT_HISTORY',
  'MISSING_BARS', 'CALENDAR_UNAVAILABLE', 'MARKET_CLOSED_DAY', 'EARLY_CLOSE_SESSION',
] as const;

/** DATA REVIEW codes for a record (pure; used at processing time and again by the v1.2 decision). */
export function integrityCodes(rec: Pick<AutoAlertRecord, 'status' | 'snapshot'>, mapping: SignalMapping | null): string[] {
  const out: string[] = [];
  if (rec.status === 'DATA_ERROR') out.push('DATA_ERROR');
  if (mapping?.status === 'AMBIGUOUS') out.push('SIGNAL_MAPPING_AMBIGUOUS');
  if (mapping?.status === 'NO_SESSION') out.push(mapping.session === 'UNKNOWN' ? 'CALENDAR_UNAVAILABLE' : 'MARKET_CLOSED_DAY');
  if (rec.status === 'OK') {
    const snap = rec.snapshot;
    if (!snap) out.push('RECONSTRUCTION_INCOMPLETE');
    else {
      for (const i of snap.issues) if ((INTEGRITY_CODES as readonly string[]).includes(i.code) && !out.includes(i.code)) out.push(i.code);
      const s = snap.values;
      // Geometry inputs the ticket needs. Missing indicator values (VWAP/EMA/RSI/RVOL/15m) are NOT integrity problems.
      if (!s && !out.some((c) => (INTEGRITY_CODES as readonly string[]).includes(c))) out.push('RECONSTRUCTION_INCOMPLETE');
      if (s && !(s.high >= Math.max(s.open, s.close) && s.low <= Math.min(s.open, s.close) && s.low > 0 && [s.open, s.high, s.low, s.close].every(Number.isFinite))) {
        if (!out.includes('SIGNAL_CANDLE_INVALID')) out.push('SIGNAL_CANDLE_INVALID');
      }
      if (s && !(s.atr > 0) && !out.includes('ATR14_UNAVAILABLE')) out.push('ATR14_UNAVAILABLE');
      if (mapping?.candleStartMs != null && snap.signal && Date.parse(snap.signal.startIso) !== mapping.candleStartMs) out.push('SIGNAL_CANDLE_MISMATCH');
    }
  }
  return out;
}

/** Enrichment-time part of the audit (called with the same bars and snapshot the v1.1 record stores). */
export function withReconstruction(a: V12Audit, rec: Pick<AutoAlertRecord, 'status' | 'snapshot' | 'calcAtAlert'>, bars: Bar[], direction: Direction, tol: ParityTolerance): V12Audit {
  const snap: SnapshotResult | null = rec.snapshot;
  const v = snap?.values ?? null;
  const signalEnd = a.signalMapping.candleEndMs;
  const forming = signalEnd !== null ? forming15m(bars, signalEnd) : null;
  const reconstruction: V12Reconstruction = {
    source: 'SIP',
    open: v?.open ?? null, high: v?.high ?? null, low: v?.low ?? null, close: v?.close ?? null, volume: v?.volume ?? null,
    atr14: v?.atr ?? null, vwap: v?.vwap ?? null, ema9: v?.ema9 ?? null, ema20: v?.ema20 ?? null, rsi14: v?.rsi ?? null,
    sipRvol: v?.rvol ?? null, close15mCompleted: v?.close15m ?? null, ema20_15mCompleted: v?.ema20_15m ?? null, forming15m: forming,
  };
  const parity = classifyConditions(
    { open: reconstruction.open, close: reconstruction.close, vwap: reconstruction.vwap, ema9: reconstruction.ema9, ema20: reconstruction.ema20, rsi: reconstruction.rsi14, rvol: reconstruction.sipRvol, close15m: reconstruction.close15mCompleted, ema20_15m: reconstruction.ema20_15mCompleted },
    direction, tol, forming,
  );
  const warnings = [...parity.warnings];
  if (a.signalMapping.status === 'DELAYED') warnings.unshift('DELIVERY_DELAYED');
  const c = rec.calcAtAlert;
  return {
    ...a,
    reconstruction,
    conditionDiagnostics: parity.diagnostics,
    warnings,
    dataReview: integrityCodes(rec, a.signalMapping),
    ticketAtAlert: c ? { entry: c.entry, stop: c.stop, target: c.target, shares: c.shares, plannedRisk: c.plannedRisk } : null,
  };
}
