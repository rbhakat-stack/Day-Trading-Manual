/**
 * HISTORICAL SIP PARITY TEST (pure, diagnostic only) — INTRABAR reconstruction.
 *
 * Answers one question: "for this historical TrendSpider alert, would Alpaca SIP have produced materially the same
 * candle and indicator values AT THE MOMENT THE ALERT FIRED?" TrendSpider multi-factor alerts can fire before the 5m
 * candle closes, so the signal candle is the ACTIVE 5m candle at the alert time, built only from data up to the
 * reconstruction cutoff. Nothing is re-implemented:
 *
 *   • indicators + candle selection → buildAlertSnapshot (alertSnapshot.ts, UNCHANGED), fed the completed 5m history
 *     plus ONE synthetic partial 5m bar (this file's adapter)
 *   • 15m confirmation               → buildAlertSnapshot at the alert time (last COMPLETED 15m candle, unchanged rule)
 *   • field comparison + tolerances  → compareParity (parity.ts, the Automation-settings tolerances)
 *   • derived ticket                 → evaluateTrade (tradeCalculator.ts) with the frozen RB v1.1 defaults
 *
 * The live webhook path keeps its own (completed-candle) semantics; nothing here is used by it.
 * It produces no alert record, no id, no dedupe key, no candidate, no capital reservation and no journal entry.
 *
 * ── TIMESTAMP RULES (1-minute SIP bars; a bar stamped t covers trades in [t, t + 60 s)) ──────────────────────────
 *   Active bucket  = [floor5(T), floor5(T) + 5 min), T = alert time (minute start for an approximate minute).
 *   Cutoff C       = the instant the reconstruction represents. A 1m bar is included iff
 *                    bucketStart ≤ t  AND  t + 60 s ≤ C   (i.e. every trade in it happened strictly before C).
 *   EXACT SECOND, seconds = 00  → one reconstruction, C = T (exact up to trades stamped exactly at T).
 *   EXACT SECOND, seconds ≠ 00  → 1m bars cannot cut inside a minute → INTRABAR_TIME_PRECISION_LIMITATION; bracketed:
 *                                 EARLIEST C = floor1(T) (state at the start of that minute),
 *                                 LATEST   C = floor1(T) + 60 s (state at the end of that minute; may include trades after T).
 *   APPROXIMATE MINUTE M        → the alert happened somewhere in [M, M + 60 s): bracketed the same way.
 *   Completed 5m history        = 5m bars with t + 5 min ≤ bucketStart. Nothing at or after the cutoff is ever used.
 */
import { RB_V1_DEFAULTS, type RbSettings } from '../settings';
import { evaluateTrade, type Action, type Direction, type TradePlan } from '../tradeCalculator';
import type { ParityTolerance } from './alertDecision';
import { buildAlertSnapshot, DEFAULT_SNAPSHOT_CONFIG, type DataIssue, type SnapshotConfig, type SnapshotResult } from './alertSnapshot';
import { etParts, etToEpoch } from './etTime';
import type { Bar } from './indicators';
import { previousTradingDates, sessionFor } from './marketCalendar';
import { compareParity, type ParityField, type ParityRow } from './parity';

/** Same warm-up as the live webhook path (processAlert: `lookbackDays ?? 5`). A test asserts the windows match. */
export const HISTORICAL_LOOKBACK_DAYS = 5;

/**
 * Alpaca serves SIP bars without a real-time subscription only when the requested end is at least 15 minutes old.
 * One extra minute of margin; anything newer is refused before any request is made.
 */
export const SIP_HISTORICAL_MIN_AGE_MS = 16 * 60_000;

export const DIAGNOSTIC_LABEL = 'DIAGNOSTIC ONLY — NO TRADE TICKET / NO LIVE DECISION';
export const DERIVED_LABEL = 'DERIVED FROM INTRABAR HISTORICAL RECONSTRUCTION — NOT AN ACTIVE TRADE';

const MIN = 60_000;
const FIVE = 5 * MIN;
const SYMBOL = /^[A-Z]{1,5}([.-][A-Z]{1,2})?$/;
const ET_STAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

export type Precision = 'EXACT_SECOND' | 'EXACT_SECOND_BRACKETED' | 'APPROXIMATE_MINUTE';
export type CutoffKey = 'EXACT' | 'EARLIEST' | 'LATEST';

export interface HistoricalRequest {
  symbol: string;
  direction: Direction;
  /** ET wall clock: "YYYY-MM-DD HH:MM:SS" (exact second) or "YYYY-MM-DD HH:MM" (approximate minute). */
  alertEt: string;
  label?: string;
  /** EXACT = the seconds are known; MINUTE = only the minute is known. Default: EXACT if seconds were given. */
  precision?: 'EXACT' | 'MINUTE';
}

export interface CheckedRequest {
  symbol: string;
  direction: Direction;
  /** Alert instant (exact) or the start of the alert minute (approximate). */
  alertMs: number;
  alertEt: string;
  label: string;
  precision: Precision;
  cutoffs: { key: CutoffKey; ms: number }[];
}

export type HistoricalRequestCheck = ({ ok: true } & CheckedRequest) | { ok: false; errors: string[] };

/** Parse "YYYY-MM-DD HH:MM[:SS]" as America/New_York wall-clock time. Returns null if malformed or non-existent. */
export function parseEtTimestamp(s: string): number | null {
  const m = ET_STAMP.exec(typeof s === 'string' ? s.trim() : '');
  if (!m) return null;
  const [, date, hh, mm, ss = '00'] = m;
  if (+hh > 23 || +mm > 59 || +ss > 59) return null;
  const t = etToEpoch(date, `${hh}:${mm}:${ss}`);
  // Round-trip check rejects impossible dates (2026-02-30) and the DST gap.
  const p = etParts(t);
  return p.date === date && p.hhmmss === `${hh}:${mm}:${ss}` ? t : null;
}

/** Reconstruction cutoffs for an alert (see the timestamp rules above). */
export function cutoffsFor(alertMs: number, precision: Precision): { key: CutoffKey; ms: number }[] {
  if (precision === 'EXACT_SECOND') return [{ key: 'EXACT', ms: alertMs }];
  const m = Math.floor(alertMs / MIN) * MIN;
  return [{ key: 'EARLIEST', ms: m }, { key: 'LATEST', ms: m + MIN }];
}

/** Validate a historical-test request. `now` enforces the SIP historical age limit on the LATEST cutoff (fail closed). */
export function checkHistoricalRequest(body: unknown, now: number): HistoricalRequestCheck {
  const errors: string[] = [];
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const symbol = typeof b.symbol === 'string' ? b.symbol.trim().toUpperCase() : '';
  if (!SYMBOL.test(symbol)) errors.push('Ticker must be a US stock symbol (1–5 letters, optional .X class suffix).');
  const d = typeof b.direction === 'string' ? b.direction.trim().toUpperCase() : '';
  if (d !== 'LONG' && d !== 'SHORT') errors.push('Direction must be LONG or SHORT.');
  const raw = typeof b.alertEt === 'string' ? b.alertEt.trim() : '';
  const hasSeconds = ET_STAMP.exec(raw)?.[4] !== undefined;
  const p = b.precision === undefined || b.precision === null || b.precision === '' ? (hasSeconds ? 'EXACT' : 'MINUTE') : String(b.precision).toUpperCase();
  if (p !== 'EXACT' && p !== 'MINUTE') errors.push('Precision must be EXACT or MINUTE.');
  if (p === 'MINUTE' && hasSeconds) errors.push('Approximate minute: enter the time as YYYY-MM-DD HH:MM (no seconds), or choose Exact second.');
  const alertMs = parseEtTimestamp(raw);
  let precision: Precision = 'EXACT_SECOND';
  let cutoffs: { key: CutoffKey; ms: number }[] = [];
  if (alertMs === null) {
    errors.push('Alert time must be an ET wall-clock time "YYYY-MM-DD HH:MM:SS" (exact) or "YYYY-MM-DD HH:MM" (approximate minute).');
  } else {
    precision = p === 'MINUTE' ? 'APPROXIMATE_MINUTE' : etParts(alertMs).hhmmss.endsWith(':00') ? 'EXACT_SECOND' : 'EXACT_SECOND_BRACKETED';
    cutoffs = cutoffsFor(alertMs, precision);
    const latest = cutoffs[cutoffs.length - 1].ms;
    if (latest > now - SIP_HISTORICAL_MIN_AGE_MS) {
      const ready = etParts(latest + SIP_HISTORICAL_MIN_AGE_MS);
      errors.push(`Alert time is too recent for historical SIP without a real-time subscription (data must be ≥ ${SIP_HISTORICAL_MIN_AGE_MS / MIN} min old). Run it after ${ready.date} ${ready.hhmmss} ET.`);
    }
  }
  const label = typeof b.label === 'string' ? b.label.trim().slice(0, 80) : '';
  if (errors.length) return { ok: false, errors };
  const et = etParts(alertMs as number);
  const alertEt = precision === 'APPROXIMATE_MINUTE' ? `${et.date} ${et.hhmm} (seconds unknown)` : `${et.date} ${et.hhmmss}`;
  return { ok: true, symbol, direction: d as Direction, alertMs: alertMs as number, alertEt, label, precision, cutoffs };
}

/** Bars window start (09:30 ET N trading days back) — the same start the live path requests. */
export function historicalWindow(alertMs: number, lookbackDays = HISTORICAL_LOOKBACK_DAYS): { startIso: string; endIso: string } {
  const date = etParts(alertMs).date;
  const start = etToEpoch(previousTradingDates(date, lookbackDays).slice(-1)[0] ?? date, '09:30');
  return { startIso: new Date(start).toISOString(), endIso: new Date(alertMs).toISOString() };
}

/** The ACTIVE regular-session 5m bucket that contains `alertMs` (floor to the 5-minute grid from 09:30 ET). */
export function activeBucket(alertMs: number): { startMs: number; endMs: number; label: string } {
  const p = etParts(alertMs);
  const open = etToEpoch(p.date, '09:30');
  const startMs = open + Math.floor((alertMs - open) / FIVE) * FIVE;
  return { startMs, endMs: startMs + FIVE, label: `${etParts(startMs).hhmm}–${etParts(startMs + FIVE).hhmm}` };
}

/** Request windows: completed 5m history ends before the bucket; 1m bars cover the bucket up to the latest cutoff. */
export function requestWindows(req: Pick<CheckedRequest, 'alertMs' | 'cutoffs'>) {
  const b = activeBucket(req.alertMs);
  const latest = Math.min(req.cutoffs[req.cutoffs.length - 1].ms, b.endMs);
  return {
    // Alpaca's `end` is inclusive of a bar's start time, so end 1 s earlier than the first excluded bar start.
    history5m: { startIso: historicalWindow(req.alertMs).startIso, endIso: new Date(b.startMs - 1000).toISOString() },
    intrabar1m: { startIso: new Date(b.startMs).toISOString(), endIso: new Date(Math.max(b.startMs, latest - 1000)).toISOString() },
  };
}

const FIFTEEN_CODES = ['NO_COMPLETED_15M', 'CONFIRM_15M_MISSING', 'CONFIRM_15M_PARTIAL', 'EMA20_15M_UNAVAILABLE'];

export interface IntrabarSnapshot extends SnapshotResult {
  cutoffIso: string;
  cutoffEt: string;
  /** 1m bars (start ET) used for the partial signal candle. */
  minutesUsed: string[];
  minutesExpected: number;
}

/**
 * The adapter. The partial signal candle is aggregated from the 1m bars with bucketStart ≤ t and t + 60 s ≤ cutoff,
 * appended to the completed 5m history, and the UNCHANGED buildAlertSnapshot computes O/H/L/C, ATR, EMA9, EMA20,
 * RSI, RVOL and VWAP with that bar as the newest one. The 15m confirmation comes from a second, unchanged call at the
 * alert time, which only sees completed history (last COMPLETED 15m candle). No data at or after the cutoff is used.
 */
export function intrabarSnapshot(hist5: Bar[], min1: Bar[], alertMs: number, cutoffMs: number, direction: Direction, config: SnapshotConfig = DEFAULT_SNAPSHOT_CONFIG): IntrabarSnapshot {
  const bucket = activeBucket(alertMs);
  const cutoff = Math.min(cutoffMs, bucket.endMs);
  const history = hist5.filter((b) => b.t + FIVE <= bucket.startMs);
  const seen = new Set<number>();
  const mins = min1
    .filter((b) => b.t >= bucket.startMs && b.t + MIN <= cutoff && [b.o, b.h, b.l, b.c, b.v].every(Number.isFinite) && !seen.has(b.t) && seen.add(b.t))
    .sort((a, b) => a.t - b.t);
  const minutesExpected = Math.max(0, Math.round((cutoff - bucket.startMs) / MIN));
  const own: DataIssue[] = [];
  const s15 = buildAlertSnapshot(history, alertMs, direction, config);
  const ap = etParts(alertMs);
  const sess = sessionFor(ap.date);
  const inSession = sess.open && sess.close ? ap.hhmm >= sess.open && ap.hhmm < sess.close : ap.minuteOfDay >= 570 && ap.minuteOfDay < 960;
  if (!inSession) own.push({ kind: 'INCOMPLETE', code: 'OUTSIDE_REGULAR_SESSION', message: `${ap.hhmmss} ET is outside the regular session; there is no active 5m candle.` });
  if (!mins.length) {
    own.push({
      kind: 'INCOMPLETE', code: 'NO_INTRABAR_DATA',
      message: minutesExpected === 0
        ? `The cutoff ${etParts(cutoff).hhmmss} ET is the very start of the ${bucket.label} candle: it had no trades yet. If the alert belongs to the candle that just closed, enter a time inside it.`
        : `No 1-minute SIP bars between ${etParts(bucket.startMs).hhmmss} and ${etParts(cutoff).hhmmss} ET.`,
    });
  } else {
    if (mins[0].t !== bucket.startMs) own.push({ kind: 'REVIEW', code: 'INTRABAR_OPEN_UNCERTAIN', message: `No 1m bar at ${etParts(bucket.startMs).hhmm}; the open is taken from ${etParts(mins[0].t).hhmm}.` });
    if (mins.length < minutesExpected) own.push({ kind: 'REVIEW', code: 'INTRABAR_MINUTES_MISSING', message: `${minutesExpected - mins.length} of ${minutesExpected} 1-minute bars before the cutoff are missing (no trades, or a data gap).` });
  }
  const partial: Bar | null = mins.length
    ? { t: bucket.startMs, o: mins[0].o, h: Math.max(...mins.map((b) => b.h)), l: Math.min(...mins.map((b) => b.l)), c: mins[mins.length - 1].c, v: mins.reduce((a, b) => a + b.v, 0) }
    : null;
  // Evaluated at the bucket end, the unchanged builder treats the partial bar as the newest completed 5m candle.
  const s5 = partial ? buildAlertSnapshot([...history, partial], bucket.endMs, direction, config) : null;

  const issues: DataIssue[] = [
    ...own,
    ...(s5 ? s5.issues : s15.issues.filter((i) => ['CALENDAR_UNAVAILABLE', 'MARKET_CLOSED_DAY', 'EARLY_CLOSE_SESSION'].includes(i.code)))
      .filter((i) => !FIFTEEN_CODES.includes(i.code) && i.code !== 'ALERT_NOT_REPRODUCED' && i.code !== 'SIGNAL_CANDLE_AMBIGUOUS'),
    ...s15.issues.filter((i) => FIFTEEN_CODES.includes(i.code)),
  ];
  const v15 = s15.values;
  if (!v15 && s15.confirm15m && !issues.some((i) => FIFTEEN_CODES.includes(i.code))) {
    issues.push({ kind: 'INCOMPLETE', code: 'CONFIRM_15M_UNAVAILABLE', message: `15m Close / EMA20 for ${s15.confirm15m.label} could not be computed from the completed history (${s15.issues.filter((i) => i.kind === 'INCOMPLETE').map((i) => i.code).join(', ') || 'insufficient data'}).` });
  }
  const complete = !issues.some((i) => i.kind === 'INCOMPLETE') && !!s5?.values && !!v15;
  const values = complete ? { ...s5!.values!, close15m: v15!.close15m, ema20_15m: v15!.ema20_15m } : null;
  const alertConditions = complete
    ? [...s5!.alertConditions.filter((c) => !c.label.startsWith('15m')), ...s15.alertConditions.filter((c) => c.label.startsWith('15m'))]
    : [];
  const failed = alertConditions.filter((c) => !c.pass).map((c) => c.label);
  if (failed.length) issues.push({ kind: 'REVIEW', code: 'ALERT_NOT_REPRODUCED', message: `TrendSpider fired the ${direction} alert, but the reconstructed values do not satisfy: ${failed.join('; ')}.` });

  return {
    values,
    signal: { startIso: new Date(bucket.startMs).toISOString(), endIso: new Date(bucket.endMs).toISOString(), label: bucket.label },
    confirm15m: s15.confirm15m,
    alertEt: ap.hhmmss,
    alertDate: ap.date,
    session: s15.session,
    sessionNote: s15.sessionNote,
    issues,
    alertConditions,
    barsUsed: s5?.barsUsed ?? 0,
    config,
    cutoffIso: new Date(cutoff).toISOString(),
    cutoffEt: etParts(cutoff).hhmmss,
    minutesUsed: mins.map((b) => etParts(b.t).hhmm),
    minutesExpected,
  };
}

export interface DerivedTicket {
  side: Direction;
  action: 'BUY' | 'SELL';
  orderType: TradePlan['orderType'];
  entry: number;
  stop: number;
  target: number;
  shares: number;
  riskPerShare: number;
  riskMethod: TradePlan['riskMethod'];
  plannedRisk: number;
  potentialProfit: number;
  positionValue: number;
  rewardRatio: number;
  limitedBy: TradePlan['limitedBy'];
  /** Calculator status evaluated AS OF the alert (price = signal close, 0 min since alert). Informational only. */
  calcAction: Action;
  calcHeadline: string;
  hardFails: string[];
}

export type DerivedInputs = Pick<NonNullable<SnapshotResult['values']>, 'open' | 'high' | 'low' | 'close' | 'atr' | 'close15m' | 'ema20_15m'>;

/**
 * Run the EXISTING RB v1 calculator on alert-time values. No current price is fetched: the signal close stands in as
 * the price at the alert instant, and minutes since alert = 0. The result is never sent anywhere.
 */
export function deriveTicket(symbol: string, direction: Direction, alertMs: number, v: DerivedInputs, s: RbSettings = RB_V1_DEFAULTS): DerivedTicket | null {
  const r = evaluateTrade(
    {
      ticker: symbol, direction, open: v.open, high: v.high, low: v.low, close: v.close, atr: v.atr,
      currentPrice: v.close, investmentAmount: s.investmentCap, accountEquity: s.accountEquity, riskPct: s.riskPct,
      alertTime: etParts(alertMs).hhmm, close15m: v.close15m, ema20_15m: v.ema20_15m, minutesSinceAlert: 0, hasOpenPosition: false,
    },
    s,
  );
  const p = r.plan;
  if (!p) return null;
  return {
    side: direction, action: direction === 'LONG' ? 'BUY' : 'SELL', orderType: p.orderType,
    entry: p.entry, stop: p.stop, target: p.target, shares: p.shares, riskPerShare: p.riskPerShare, riskMethod: p.riskMethod,
    plannedRisk: p.maxLoss, potentialProfit: p.potentialProfit, positionValue: p.positionValue, rewardRatio: p.rewardRatio, limitedBy: p.limitedBy,
    calcAction: r.action, calcHeadline: r.headline, hardFails: r.hardFails.map((f) => f.reason),
  };
}

export interface ReconstructionBound {
  key: CutoffKey;
  snapshot: IntrabarSnapshot;
  /** Present only when every value is complete (fail closed). */
  derived: DerivedTicket | null;
}

export interface HistoricalResult {
  mode: 'HISTORICAL_DIAGNOSTIC';
  reconstruction: 'INTRABAR';
  label: typeof DIAGNOSTIC_LABEL;
  symbol: string;
  direction: Direction;
  alertEt: string;
  alertIso: string;
  testLabel: string;
  precision: Precision;
  timing: { activeLabel: string; activeStartIso: string; activeEndIso: string; confirm15mLabel: string | null };
  provider: { name: 'Alpaca'; feed: 'sip'; host: string };
  request: { history5m: { startIso: string; endIso: string }; intrabar1m: { startIso: string; endIso: string }; endpoint: 'bars'; currentPriceFetched: false };
  barsReceived: { fiveMin: number; oneMin: number };
  /** One bound (exact) or two (EARLIEST / LATEST) when the alert second cannot be resolved from 1m bars. */
  bounds: ReconstructionBound[];
  /** Notices that apply to the whole test (precision limitation, RVOL semantics). */
  notices: DataIssue[];
}

export function runIntrabarReconstruction(
  hist5: Bar[],
  min1: Bar[],
  req: CheckedRequest,
  meta: { host: string; windows: ReturnType<typeof requestWindows> },
  config: SnapshotConfig = DEFAULT_SNAPSHOT_CONFIG,
): HistoricalResult {
  const bounds = req.cutoffs.map((c) => {
    const snapshot = intrabarSnapshot(hist5, min1, req.alertMs, c.ms, req.direction, config);
    return { key: c.key, snapshot, derived: snapshot.values ? deriveTicket(req.symbol, req.direction, req.alertMs, snapshot.values) : null };
  });
  const b = activeBucket(req.alertMs);
  const notices: DataIssue[] = [];
  if (req.precision === 'EXACT_SECOND_BRACKETED') {
    notices.push({ kind: 'REVIEW', code: 'INTRABAR_TIME_PRECISION_LIMITATION', message: `1-minute bars cannot cut at ${etParts(req.alertMs).hhmmss}. Shown as a bracket: state at ${etParts(req.cutoffs[0].ms).hhmmss} (earliest) and at ${etParts(req.cutoffs[1].ms).hhmmss} (latest, may include trades after the alert).` });
  }
  if (req.precision === 'APPROXIMATE_MINUTE') {
    notices.push({ kind: 'REVIEW', code: 'APPROXIMATE_INTRABAR_RECONSTRUCTION', message: `Seconds unknown: the alert fired somewhere in ${etParts(req.cutoffs[0].ms).hhmm}:00–:59. Shown as a bracket of the earliest and latest possible state.` });
  }
  notices.push({ kind: 'REVIEW', code: 'RVOL_SEMANTICS_UNDER_VALIDATION', message: 'RVOL uses the partial candle volume up to the cutoff ÷ the unchanged SMA(20) baseline. Whether TrendSpider evaluates RVOL on the partial or the completed candle is not yet established.' });
  return {
    mode: 'HISTORICAL_DIAGNOSTIC',
    reconstruction: 'INTRABAR',
    label: DIAGNOSTIC_LABEL,
    symbol: req.symbol,
    direction: req.direction,
    alertEt: req.alertEt,
    alertIso: new Date(req.alertMs).toISOString(),
    testLabel: req.label,
    precision: req.precision,
    timing: { activeLabel: b.label, activeStartIso: new Date(b.startMs).toISOString(), activeEndIso: new Date(b.endMs).toISOString(), confirm15mLabel: bounds[0].snapshot.confirm15m?.label ?? null },
    provider: { name: 'Alpaca', feed: 'sip', host: meta.host },
    request: { ...meta.windows, endpoint: 'bars', currentPriceFetched: false },
    barsReceived: { fiveMin: hist5.length, oneMin: min1.length },
    bounds,
    notices,
  };
}

/* ───────────────────────── comparison (existing tolerances) ───────────────────────── */

export interface BoundedRow {
  field: ParityField;
  trendSpider: number;
  /** One row per bound, same order as result.bounds (compareParity, unchanged). */
  perBound: (ParityRow | null)[];
  /** PASS = within tolerance of at least one bound (which: passedAt). BETWEEN = between the two bounds but within
   *  tolerance of neither (unresolvable at minute precision). MISMATCH otherwise. */
  result: 'PASS' | 'BETWEEN' | 'MISMATCH';
  passedAt: CutoffKey[];
}

export function compareHistorical(r: Pick<HistoricalResult, 'bounds'>, trendSpider: Partial<Record<ParityField, number>>, tol: ParityTolerance): BoundedRow[] {
  const per = r.bounds.map((b) => (b.snapshot.values ? compareParity(b.snapshot.values, trendSpider, tol) : []));
  if (per.every((x) => x.length === 0)) return [];
  const fields = (per.find((x) => x.length) ?? []).map((x) => x.field);
  return fields.map((field) => {
    const rows = per.map((x) => x.find((y) => y.field === field) ?? null);
    const ts = (rows.find((x) => x) as ParityRow).trendSpider;
    const passedAt = rows.flatMap((x, i) => (x && !x.mismatch ? [r.bounds[i].key] : []));
    const autos = rows.filter((x): x is ParityRow => !!x).map((x) => x.automated);
    const between = autos.length === 2 && ts >= Math.min(...autos) && ts <= Math.max(...autos);
    return { field, trendSpider: ts, perBound: rows, result: passedAt.length ? 'PASS' : between ? 'BETWEEN' : 'MISMATCH', passedAt };
  });
}
