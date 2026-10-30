/**
 * Automated alert → final decision (pure). This is the FINAL SAFETY GATE: an active TrendSpider order ticket is
 * produced only when every one of these holds (otherwise the reason is shown and no ticket exists):
 *
 *   1 webhook valid · 2 market data valid · 3 alert-time snapshot constructed · 4 15m confirmation valid ·
 *   5 all RB v1 hard rules pass · 6 not stale · 7 not chased · 8 valid calculator structure ·
 *   9 Opportunity Score ≥ 85 · 10 portfolio rules pass and capital allocated · 11 market data fresh ·
 *   12 no material data mismatch (snapshot checks, price-source check, data-parity check).
 *
 * No trading logic lives here: eligibility, score, rank and allocation come from the existing engine
 * (evaluateTrade / rankCandidates). This module only combines them with data-quality checks and formats the
 * ticket. It never places, sends, modifies or cancels any order.
 */
import type { RankedCandidate } from '../ranker/candidateRanker';
import type { Candidate, LifecycleStatus } from '../ranker/opportunityTypes';
import { checkTimeWindow, RULES_VERSION, SCORING_VERSION, type HardFail } from '../rules';
import { RB_V1_DEFAULTS } from '../settings';
import type { Action, Direction, TradeResult } from '../tradeCalculator';
import type { ParsedAlert } from './alertPayload';
import type { DataIssue, SnapshotResult } from './alertSnapshot';
import { etParts } from './etTime';

/* ───────────────────────── shared record shape (server ↔ client) ───────────────────────── */

export type RecordStatus = 'RECEIVED' | 'ENRICHING' | 'OK' | 'DATA_ERROR';

export interface QuoteSnapshot {
  price: number;
  /** Exchange timestamp of the last trade. */
  tradeIso: string;
  /** When the server fetched it. */
  fetchedIso: string;
}

export interface AutoAlertRecord {
  id: string;
  dedupeKey: string;
  receivedIso: string;
  receivedMs: number;
  status: RecordStatus;
  alert: Omit<ParsedAlert, 'test'>;
  /** Sanitised copy of the webhook body (credentials removed). */
  payload: Record<string, unknown>;
  /** Immutable once status = OK. */
  snapshot: SnapshotResult | null;
  provider: { name: 'Alpaca'; feed: string; host: string };
  /** End of the newest bar the snapshot used (market data "through"). */
  marketDataThroughIso: string | null;
  /** Provider last trade fetched when the alert was processed (alert-time "initial current price"). */
  initialQuote: QuoteSnapshot | null;
  /** Reference calculator result at alert time with the frozen RB v1.1 defaults ($100k, 0.25%, $20k). */
  calcAtAlert: { action: Action; headline: string; entry: number | null; stop: number | null; target: number | null; shares: number | null; plannedRisk: number | null } | null;
  /** Earlier records for the same ticker today (informational; duplicate handling is done against live statuses). */
  sameTickerEarlier: string[];
  errors: string[];
  attempts: number;
  versions: { rules: string; scoring: string; strategy: string };
  processedIso: string | null;
}

/* ───────────────────────── configuration ───────────────────────── */

export interface ParityTolerance {
  /** Absolute tolerance in price dollars for O/H/L/C, 15m Close. */
  priceAbs: number;
  /** Relative tolerances (fractions). */
  atrPct: number;
  emaPct: number;
  vwapPct: number;
  rvolPct: number;
  /** Absolute RSI points. */
  rsiPts: number;
}

export interface AutomationConfig {
  enabled: boolean;
  /** Micro-batching window: alerts arriving within this interval are ranked together before display. */
  batchMs: number;
  /** A batch is released after this long even if one alert is still being enriched (that alert stays SCORING). */
  maxBatchHoldMs: number;
  pollMs: number;
  quotePollMs: number;
  /** Current price older than this (since it was fetched) → STALE DATA, no ticket. */
  maxDataAgeSec: number;
  /** Last trade older than this when fetched → STALE DATA, no ticket. */
  maxTradeAgeSec: number;
  /** TrendSpider vs provider price: mismatch when |Δ| > MAX(priceMismatchMin, priceMismatchPct × price). */
  priceMismatchPct: number;
  priceMismatchMin: number;
  parity: ParityTolerance;
  /** Comparisons needed before data parity is considered validated (informational banner until then). */
  parityRequired: number;
}

/**
 * Defaults (documented in calculator/AUTOMATION.md):
 *  • priceMismatch: MAX($0.02, 0.10% × price) — about one to two typical spreads of a liquid S&P 500 stock plus a few
 *    seconds of movement. It is well below the 0.25 ATR chase limit, so a mismatch is caught before it can flip a decision.
 *  • maxDataAgeSec 5 s (spec) · maxTradeAgeSec 60 s (a liquid S&P 500 name trades every few seconds on SIP).
 *  • parity: prices ±$0.02, ATR ±5%, EMA/VWAP ±0.05%, RVOL ±15%, RSI ±2 points.
 */
export const DEFAULT_AUTOMATION: AutomationConfig = {
  enabled: false,
  batchMs: 3000,
  maxBatchHoldMs: 15000,
  pollMs: 3000,
  quotePollMs: 3000,
  maxDataAgeSec: 5,
  maxTradeAgeSec: 60,
  priceMismatchPct: 0.001,
  priceMismatchMin: 0.02,
  parity: { priceAbs: 0.02, atrPct: 0.05, emaPct: 0.0005, vwapPct: 0.0005, rvolPct: 0.15, rsiPts: 2 },
  parityRequired: 20,
};

/* ───────────────────────── freshness ───────────────────────── */

export type FreshnessBand = 'FRESH' | 'AGING' | 'URGENT' | 'STALE';

export interface Freshness {
  ageMs: number;
  remainingMs: number;
  band: FreshnessBand;
}

export function freshness(alertMs: number, now: number, maxMinutes = RB_V1_DEFAULTS.alertWindowMinutes): Freshness {
  const ageMs = Math.max(0, now - alertMs);
  const remainingMs = maxMinutes * 60_000 - ageMs;
  const m = ageMs / 60_000;
  const band: FreshnessBand = m >= maxMinutes ? 'STALE' : m >= 8 ? 'URGENT' : m >= 5 ? 'AGING' : 'FRESH';
  return { ageMs, remainingMs, band };
}

/* ───────────────────────── micro-batching ───────────────────────── */

/**
 * Which records may be shown/ranked now. Records are grouped into clusters (consecutive arrivals ≤ batchMs apart).
 * A cluster is released when no further alert arrived for batchMs AND all its members are processed — or, after
 * maxBatchHoldMs, its processed members are released anyway (a slow one stays SCORING). This prevents an alert that
 * arrived 500 ms earlier from briefly showing as #1 before a better simultaneous alert is scored.
 */
export function releasedIds(records: Pick<AutoAlertRecord, 'id' | 'receivedMs' | 'status'>[], now: number, cfg: Pick<AutomationConfig, 'batchMs' | 'maxBatchHoldMs'>): Set<string> {
  const sorted = [...records].sort((a, b) => a.receivedMs - b.receivedMs);
  const out = new Set<string>();
  let cluster: typeof sorted = [];
  const flush = () => {
    if (!cluster.length) return;
    const last = cluster[cluster.length - 1].receivedMs;
    const first = cluster[0].receivedMs;
    const done = (r: (typeof sorted)[number]) => r.status === 'OK' || r.status === 'DATA_ERROR';
    const quiet = now - last >= cfg.batchMs;
    if (quiet && cluster.every(done)) cluster.forEach((r) => out.add(r.id));
    else if (now - first >= cfg.maxBatchHoldMs) cluster.filter(done).forEach((r) => out.add(r.id));
    cluster = [];
  };
  for (const r of sorted) {
    if (cluster.length && r.receivedMs - cluster[cluster.length - 1].receivedMs > cfg.batchMs) flush();
    cluster.push(r);
  }
  flush();
  return out;
}

/* ───────────────────────── duplicates ───────────────────────── */

const ACTIVE: LifecycleStatus[] = ['PENDING', 'FILLED'];
const LIVE: LifecycleStatus[] = ['NEW', 'WATCHLIST'];

/**
 * One position or pending order per ticker, and one live candidate per ticker. Returns the id of the existing
 * candidate that makes `rec` a DUPLICATE / EXISTING CANDIDATE, or null. An earlier candidate that is stale or
 * finished (skipped, canceled, closed …) does not block a new, fresh alert.
 */
export function existingCandidateFor(rec: AutoAlertRecord, candidates: Candidate[], now: number): string | null {
  const same = candidates.filter((c) => c.ticker === rec.alert.symbol && c.id !== rec.id && !c.archived && c.date === etParts(rec.alert.alertTimeMs).date);
  const active = same.find((c) => ACTIVE.includes(c.status));
  if (active) return active.id;
  const live = same.find((c) => LIVE.includes(c.status) && freshness(alertMsOf(c), now).band !== 'STALE' && alertMsOf(c) < rec.alert.alertTimeMs);
  return live ? live.id : null;
}

function alertMsOf(c: Candidate): number {
  return c.alertMs ?? c.createdAt;
}

/* ───────────────────────── ticket ───────────────────────── */

export interface TrendSpiderTicket {
  action: 'BUY' | 'SELL';
  orderType: 'STOP';
  quantity: number;
  price: number;
  stopLoss: number;
  takeProfit: number;
}

/** Fresh RB v1 breakouts are always BUY STOP (LONG) or SELL STOP (SHORT). Never Market, never Limit. */
export function ticketFor(direction: Direction, c: Pick<Candidate, 'shares' | 'entry' | 'stop' | 'target'>): TrendSpiderTicket {
  return { action: direction === 'LONG' ? 'BUY' : 'SELL', orderType: 'STOP', quantity: c.shares, price: c.entry, stopLoss: c.stop, takeProfit: c.target };
}

const p2 = (x: number) => (x >= 1 ? x.toFixed(2) : x.toFixed(4));

/** e.g. "BUY | STOP | 233 | 85.54 | SL 85.37 | TP 85.88" — informational; never sent anywhere. */
export const ticketString = (t: TrendSpiderTicket) => `${t.action} | ${t.orderType} | ${t.quantity} | ${p2(t.price)} | SL ${p2(t.stopLoss)} | TP ${p2(t.takeProfit)}`;

/* ───────────────────────── checks ───────────────────────── */

export function priceMismatch(trendSpider: number | null, provider: number | null, cfg: Pick<AutomationConfig, 'priceMismatchPct' | 'priceMismatchMin'>) {
  if (trendSpider === null || provider === null) return null;
  const diff = Math.abs(trendSpider - provider);
  const tol = Math.max(cfg.priceMismatchMin, cfg.priceMismatchPct * provider);
  return { diff, tol, mismatch: diff > tol + 1e-9 };
}

export interface LiveQuote extends QuoteSnapshot {
  /** Client clock when the quote response arrived. */
  receivedMs: number;
}

export function quoteAges(q: LiveQuote | null, now: number) {
  if (!q) return null;
  return { dataAgeSec: (now - q.receivedMs) / 1000, tradeAgeSec: Math.max(0, (Date.parse(q.fetchedIso) - Date.parse(q.tradeIso)) / 1000) };
}

/* ───────────────────────── decision ───────────────────────── */

export type FinalDecision =
  | 'SCORING'
  | 'TRADE NOW — ELITE'
  | 'HIGH PRIORITY — TRADE CONSIDERATION'
  | 'WATCHLIST'
  | 'SKIP'
  | 'NOT ELIGIBLE'
  | 'DATA REVIEW REQUIRED'
  | 'ORDER SUBMITTED'
  | 'IN POSITION'
  | 'CLOSED';

export type QueueSection = 'SCORING' | 'ACTION_NOW' | 'HIGH_PRIORITY' | 'DATA_REVIEW' | 'WATCHLIST' | 'IGNORE' | 'ACTIVE' | 'CLOSED';

export interface AlertDecision {
  decision: FinalDecision;
  /** Short qualifier, e.g. "DATA INCOMPLETE — DO NOT TRADE", "STALE — DO NOT TRADE", "BLOCKED — CORRELATED EXPOSURE". */
  detail: string;
  section: QueueSection;
  reasons: string[];
  ticket: TrendSpiderTicket | null;
  freshness: Freshness;
  /** The 12 gate checks (for Show Data Validation). */
  gate: { label: string; pass: boolean | null }[];
  flags: string[];
}

export interface DecideArgs {
  record: AutoAlertRecord;
  released: boolean;
  candidate: Candidate | null;
  ranked: RankedCandidate | null;
  /** Live dynamic calculator evaluation (current price, age). */
  live: TradeResult | null;
  quote: LiveQuote | null;
  now: number;
  cfg: AutomationConfig;
  parityMismatches: string[];
  duplicateOf: string | null;
  window?: { entryWindowStart: string; entryWindowEnd: string };
}

const CLOSED_STATUSES: LifecycleStatus[] = ['TARGET_HIT', 'STOPPED_OUT', 'MANUAL_EXIT', 'SKIPPED', 'CANCELED', 'EXPIRED', 'STALE'];

export function decideAlert(a: DecideArgs): AlertDecision {
  const { record: rec, cfg, now } = a;
  const fr = freshness(rec.alert.alertTimeMs, now);
  const snap = rec.snapshot;
  const incomplete = snap?.issues.filter((i) => i.kind === 'INCOMPLETE') ?? [];
  const review: DataIssue[] = snap?.issues.filter((i) => i.kind === 'REVIEW') ?? [];
  const ages = quoteAges(a.quote, now);
  const pm = priceMismatch(rec.alert.lastPrice, rec.initialQuote?.price ?? null, cfg);
  const hard: HardFail[] = a.ranked?.hardFails ?? [];
  const strategyFails = a.ranked && !a.ranked.strategyEligible ? hard.filter((f) => !['NO_POSITION_SLOT', 'CAPITAL_LIMIT', 'PORTFOLIO_HEAT_LIMIT', 'CORRELATION_LIMIT'].includes(f.code)) : [];
  const action = a.live?.action ?? null;
  const tier = a.ranked?.tier ?? null;
  const rec10 = a.ranked?.recommendation ?? null;
  const dataFresh = !!ages && ages.dataAgeSec <= cfg.maxDataAgeSec && ages.tradeAgeSec <= cfg.maxTradeAgeSec;

  const gate = [
    { label: '1 Webhook valid', pass: true },
    { label: '2 Market data valid', pass: rec.status === 'OK' && !incomplete.length },
    { label: '3 Alert-time snapshot constructed', pass: !!snap?.values },
    { label: '4 15m confirmation valid', pass: snap?.values ? !hard.some((f) => f.code === 'HTF_CONFIRMATION_FAILED') : null },
    { label: '5 All RB v1 hard rules pass', pass: a.ranked ? a.ranked.strategyEligible : null },
    { label: '6 Not stale', pass: action ? action !== 'SKIP_STALE' && fr.band !== 'STALE' : null },
    { label: '7 Not chased', pass: action ? action !== 'SKIP_CHASED' : null },
    { label: '8 Valid calculator structure', pass: a.live ? !a.live.hardFails.some((f) => f.code === 'INVALID_TRADE_STRUCTURE') && !!a.live.plan?.structureValid : null },
    { label: '9 Opportunity Score ≥ 85', pass: tier ? tier === 'ELITE' || tier === 'HIGH_PRIORITY' : null },
    { label: '10 Portfolio rules pass, capital allocated', pass: rec10 ? rec10.startsWith('TRADE NOW') : null },
    { label: `11 Market data fresh (≤ ${cfg.maxDataAgeSec} s, last trade ≤ ${cfg.maxTradeAgeSec} s)`, pass: dataFresh },
    { label: '12 No material data mismatch', pass: !review.length && !pm?.mismatch && !a.parityMismatches.length },
  ];
  const out = (decision: FinalDecision, detail: string, section: QueueSection, reasons: string[], ticket: TrendSpiderTicket | null = null, flags: string[] = []): AlertDecision => ({ decision, detail, section, reasons, ticket, freshness: fr, gate, flags });

  // 0 still in the micro-batch / being enriched
  if (!a.released || rec.status === 'RECEIVED' || rec.status === 'ENRICHING') return out('SCORING', 'Processing — waiting for simultaneous alerts', 'SCORING', ['Alerts arriving together are scored and ranked together before display.']);

  // 1 lifecycle the user controls (manual submission / fills) — never re-decided
  const st = a.candidate?.status;
  if (st === 'PENDING') return out('ORDER SUBMITTED', 'PENDING — marked submitted by you; not necessarily filled', 'ACTIVE', ['Capital and planned risk are reserved. Update to FILLED manually when TrendSpider/Alpaca shows the fill.']);
  if (st === 'FILLED') return out('IN POSITION', 'FILLED — governed by its stop and target', 'ACTIVE', ['Filled positions are never displaced or re-ranked.']);
  if (st && CLOSED_STATUSES.includes(st)) return out('CLOSED', st.replace(/_/g, ' '), 'CLOSED', []);

  // 2 data-independent time rules (alert outside the session/window is never tradeable)
  const tw = checkTimeWindow(etParts(rec.alert.alertTimeMs).hhmm, a.window ?? RB_V1_DEFAULTS);
  if (tw) return out('NOT ELIGIBLE', tw.label, 'IGNORE', [tw.reason]);

  // 3 data failures
  if (rec.status === 'DATA_ERROR') return out('DATA REVIEW REQUIRED', 'DATA ERROR — MANUAL REVIEW REQUIRED', 'DATA_REVIEW', rec.errors.length ? rec.errors : ['Market data could not be retrieved.']);
  if (!snap || incomplete.length || !snap.values) return out('DATA REVIEW REQUIRED', 'DATA INCOMPLETE — DO NOT TRADE', 'DATA_REVIEW', incomplete.map((i) => i.message));

  // 4 one live candidate / position per ticker
  if (a.duplicateOf) return out('NOT ELIGIBLE', 'DUPLICATE / EXISTING CANDIDATE', 'IGNORE', [`${rec.alert.symbol} already has a live candidate, pending order or position. RB v1 never pyramids.`], null, ['DUPLICATE']);

  // 5 data trust
  const mism: string[] = [...review.map((i) => i.message), ...a.parityMismatches.map((m) => `Data parity: ${m}`)];
  if (pm?.mismatch) mism.push(`PRICE SOURCE MISMATCH: TrendSpider $${rec.alert.lastPrice} vs provider $${rec.initialQuote?.price} (Δ $${pm.diff.toFixed(2)} > $${pm.tol.toFixed(2)}).`);
  if (mism.length) return out('DATA REVIEW REQUIRED', 'DATA MISMATCH — MANUAL REVIEW', 'DATA_REVIEW', mism);

  // 6 hard rules (shared engine)
  if (!a.ranked || !a.candidate) return out('DATA REVIEW REQUIRED', 'NOT SCORED', 'DATA_REVIEW', ['The candidate could not be built from the snapshot.']);
  // Late entry (crossed by ≤ 0.25 ATR): the shared ranker treats an unconfirmed late entry as not tradeable. That is a
  // review state, not a failed setup — and it is never converted into a Market/Limit/pullback order automatically.
  const lateOnly = action === 'MARKET_LATE_ENTRY' && !a.live?.hardFails.length && strategyFails.every((f) => f.reason.includes('MARKET LATE ENTRY'));
  if (lateOnly) {
    return out('WATCHLIST', 'TRIGGER CROSSED — MANUAL REVIEW', 'WATCHLIST', ['Price is already past the entry by ≤ 0.25 ATR. RB v1 does not convert a missed breakout into a Market, Limit or pullback order automatically. Review it in the Calculator (late-entry recalculation) if you want to act.']);
  }
  if (strategyFails.length) {
    const top = strategyFails[0];
    const detail = top.code === 'STALE_SETUP' ? 'STALE — DO NOT TRADE' : top.code === 'CHASED_SETUP' ? 'DO NOT CHASE' : top.label;
    return out('NOT ELIGIBLE', detail, 'IGNORE', strategyFails.map((f) => `${f.label}: ${f.reason}`));
  }
  if (a.ranked.missing.length) return out('DATA REVIEW REQUIRED', 'SCORING INCOMPLETE', 'DATA_REVIEW', [`Missing: ${a.ranked.missing.join(', ')}. Enter the classification once; it is remembered per ticker.`]);
  if (fr.band === 'STALE') return out('NOT ELIGIBLE', 'STALE — DO NOT TRADE', 'IGNORE', [`No trigger within ${RB_V1_DEFAULTS.alertWindowMinutes} minutes of the alert.`]);

  // 7 score tiers (absolute thresholds from the shared ranker)
  if (tier === 'SKIP' || tier === 'LOW_PRIORITY') return out('SKIP', `Score ${a.ranked.total} — below the 80 watchlist threshold`, 'IGNORE', [a.ranked.eligibilityLabel]);
  if (tier === 'WATCHLIST') return out('WATCHLIST', `Score ${a.ranked.total} — below the 85 trade threshold`, 'WATCHLIST', [a.ranked.eligibilityLabel]);

  // ≥ 85 from here
  if (!rec10?.startsWith('TRADE NOW')) return out('WATCHLIST', rec10 ?? 'NOT ALLOCATED', 'WATCHLIST', a.ranked.reasonsAgainst.slice(0, 3));
  if (!dataFresh) {
    return out('DATA REVIEW REQUIRED', 'STALE DATA — REFRESHING', 'DATA_REVIEW', [
      ages ? `Current price is ${ages.dataAgeSec.toFixed(1)} s old (limit ${cfg.maxDataAgeSec} s); last trade ${ages.tradeAgeSec.toFixed(0)} s before fetch (limit ${cfg.maxTradeAgeSec} s).` : 'No current price yet.',
      'TRADE NOW is never shown from stale current-price data.',
    ]);
  }
  if (action === 'MARKET_LATE_ENTRY') {
    return out('WATCHLIST', 'TRIGGER CROSSED — MANUAL REVIEW', 'WATCHLIST', ['Price is already past the entry by ≤ 0.25 ATR. RB v1 does not convert a missed breakout into a Market, Limit or pullback order automatically. Review it in the Calculator (late-entry recalculation) if you want to act.']);
  }
  if (action !== 'BUY_STOP' && action !== 'SELL_STOP') return out('DATA REVIEW REQUIRED', `Calculator state ${action ?? 'unknown'}`, 'DATA_REVIEW', ['Unexpected calculator state — no ticket.']);

  const ticket = ticketFor(rec.alert.direction, a.candidate);
  return tier === 'ELITE'
    ? out('TRADE NOW — ELITE', `Score ${a.ranked.total} · rank #${a.ranked.rank}`, 'ACTION_NOW', [], ticket)
    : out('HIGH PRIORITY — TRADE CONSIDERATION', `Score ${a.ranked.total} · rank #${a.ranked.rank}`, 'HIGH_PRIORITY', [], ticket);
}

export const VERSIONS = { rules: RULES_VERSION, scoring: SCORING_VERSION };
