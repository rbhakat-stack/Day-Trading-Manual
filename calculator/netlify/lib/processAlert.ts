/**
 * Webhook alert processing (dependency-injected so it is unit-tested without network or Netlify).
 *
 *   validate → deduplicate → store RECEIVED → wait for the signal candle to settle → fetch 5m bars + last trade
 *   (read-only) → buildAlertSnapshot (shared) → evaluateTrade (shared calculator, RB v1.1 defaults, reference only)
 *   → store OK (immutable) — or DATA_ERROR with the reason (never invented values).
 *
 * Ranking, capital allocation and the final ticket are decided in the app with the same shared engine, because the
 * portfolio (pending orders, positions) lives there.
 */
import { dedupeKey, parseAlertPayload, withoutSecrets, type ParsedAlert } from '../../src/engine/automation/alertPayload';
import { buildAlertSnapshot, DEFAULT_SNAPSHOT_CONFIG, type SnapshotConfig } from '../../src/engine/automation/alertSnapshot';
import { DEFAULT_AUTOMATION, type AutoAlertRecord } from '../../src/engine/automation/alertDecision';
import { needsRvolOptionalSnapshot, receiptAudit, withReconstruction, type AutoAlertRecordV12 } from '../../src/engine/automation/v12/audit';
import { inputsFromRecord } from '../../src/engine/automation/autoCandidate';
import { etParts, etToEpoch } from '../../src/engine/automation/etTime';
import { previousTradingDates } from '../../src/engine/automation/marketCalendar';
import { RULES_VERSION, SCORING_VERSION } from '../../src/engine/rules';
import { RB_V1_DEFAULTS } from '../../src/engine/settings';
import { FROZEN_VERSION } from '../../src/engine/strategyVersion';
import { evaluateTrade } from '../../src/engine/tradeCalculator';
import { BarCache, type MarketDataClient } from './alpaca';
import { hashKey, type AlertStore } from './store';
import type { Logger } from './log';

export interface ProcessDeps {
  store: AlertStore;
  data: MarketDataClient;
  log: Logger;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  cache?: BarCache;
  snapshotConfig?: SnapshotConfig;
  /** Wait until this long after the signal candle closed before fetching it (late trade reports). */
  settleMs?: number;
  /** Trading days of history before the alert day (indicator warm-up). */
  lookbackDays?: number;
  /** Overall budget for enrichment (Netlify synchronous functions are limited to ~10 s). */
  deadlineMs?: number;
}

export type ProcessOutcome =
  | { kind: 'REJECTED'; status: 400; errors: string[] }
  | { kind: 'TEST_OK'; status: 200; alert: ParsedAlert }
  | { kind: 'DUPLICATE'; status: 200; id: string }
  | { kind: 'STORED'; status: 200; id: string; record: AutoAlertRecord };

const FIVE = 5 * 60_000;

export async function processAlert(body: unknown, deps: ProcessDeps): Promise<ProcessOutcome> {
  const now = deps.now();
  const parsed = parseAlertPayload(body, now);
  if (!parsed.ok) {
    deps.log('webhook_rejected', { reason: 'validation', errors: parsed.errors });
    return { kind: 'REJECTED', status: 400, errors: parsed.errors };
  }
  const a = parsed.alert;
  if (a.test) {
    deps.log('webhook_test', { symbol: a.symbol, direction: a.direction, alertTime: a.alertTimeIso });
    return { kind: 'TEST_OK', status: 200, alert: a };
  }
  const key = dedupeKey(a);
  const existing = await deps.store.getDedupe(key);
  if (existing) {
    deps.log('webhook_duplicate', { symbol: a.symbol, direction: a.direction, id: existing });
    return { kind: 'DUPLICATE', status: 200, id: existing };
  }
  const date = etParts(a.alertTimeMs).date;
  const id = `${a.symbol}-${a.direction[0]}-${etParts(a.alertTimeMs).hhmmss.replace(/:/g, '')}-${hashKey(key).slice(0, 6)}`;
  await deps.store.setDedupe(key, id);
  const earlier = (await deps.store.list(date)).filter((r) => r.alert.symbol === a.symbol && r.alert.alertTimeMs < a.alertTimeMs).map((r) => r.id);
  const { test: _t, ...alert } = a;
  void _t;
  const rec: AutoAlertRecord = {
    id,
    dedupeKey: key,
    receivedIso: new Date(now).toISOString(),
    receivedMs: now,
    status: 'RECEIVED',
    alert,
    payload: withoutSecrets(body),
    snapshot: null,
    provider: { name: 'Alpaca', feed: deps.data.feed, host: deps.data.host },
    marketDataThroughIso: null,
    initialQuote: null,
    calcAtAlert: null,
    sameTickerEarlier: earlier,
    errors: [],
    attempts: 0,
    versions: { rules: RULES_VERSION, scoring: SCORING_VERSION, strategy: FROZEN_VERSION },
    processedIso: null,
  };
  await v12Receipt(rec, body, now, key, deps);
  await deps.store.put(date, rec);
  deps.log('webhook_received', { id, symbol: a.symbol, direction: a.direction, alertTime: a.alertTimeIso, lastPrice: a.lastPrice });
  const done = await enrichRecord(rec, deps);
  return { kind: 'STORED', status: 200, id, record: done };
}

/**
 * Fill a RECEIVED / DATA_ERROR record. A record whose status is OK is immutable and is returned unchanged.
 */
export async function enrichRecord(rec: AutoAlertRecord, deps: ProcessDeps): Promise<AutoAlertRecord> {
  if (rec.status === 'OK') return rec;
  const date = etParts(rec.alert.alertTimeMs).date;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const cfg = deps.snapshotConfig ?? DEFAULT_SNAPSHOT_CONFIG;
  const started = deps.now();
  const deadline = started + (deps.deadlineMs ?? 8000);
  const r: AutoAlertRecord = { ...rec, status: 'ENRICHING', attempts: rec.attempts + 1, errors: [] };

  // Let the signal candle settle: trades reported a moment late are still added to a just-closed bar.
  const open = etToEpoch(date, '09:30');
  const sigEnd = open + Math.floor((rec.alert.alertTimeMs - open) / FIVE) * FIVE;
  const wait = sigEnd + (deps.settleMs ?? 3000) - deps.now();
  if (wait > 0) await sleep(Math.min(wait, 5000));

  const start = etToEpoch(previousTradingDates(date, deps.lookbackDays ?? 5).slice(-1)[0] ?? date, '09:30');
  const startIso = new Date(start).toISOString();
  const endIso = new Date(rec.alert.alertTimeMs).toISOString();
  const cacheKey = `${rec.alert.symbol}|${startIso}|${new Date(sigEnd).toISOString()}`;
  deps.log('market_data_fetch_started', { id: rec.id, symbol: rec.alert.symbol, startIso, endIso, feed: deps.data.feed });
  try {
    const timeout = <T,>(p: Promise<T>) =>
      Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`market-data deadline exceeded (${deps.deadlineMs ?? 8000} ms)`)), Math.max(1, deadline - deps.now())))]);
    const cached = deps.cache?.get(cacheKey);
    const [bars, trades] = await timeout(Promise.all([cached ? Promise.resolve(cached) : deps.data.getBars5(rec.alert.symbol, startIso, endIso), deps.data.getLatestTrades([rec.alert.symbol])]));
    if (!cached) deps.cache?.set(cacheKey, bars.filter((b) => b.t + FIVE <= sigEnd)); // cache completed bars only
    const quote = trades[rec.alert.symbol] ?? null;
    const snapshot = buildAlertSnapshot(bars, rec.alert.alertTimeMs, rec.alert.direction, cfg);
    r.snapshot = snapshot;
    r.initialQuote = quote;
    const newest = bars.filter((b) => b.t + FIVE <= rec.alert.alertTimeMs).slice(-1)[0];
    r.marketDataThroughIso = newest ? new Date(newest.t + FIVE).toISOString() : null;
    if (!quote) snapshot.issues.push({ kind: 'INCOMPLETE', code: 'NO_CURRENT_PRICE', message: 'The provider returned no last trade for this symbol.' });
    r.status = 'OK';
    if (quote && snapshot.values) {
      const res = evaluateTrade(inputsFromRecord({ ...r }, quote.price, deps.now(), RB_V1_DEFAULTS)!, RB_V1_DEFAULTS);
      const p = res.plan;
      r.calcAtAlert = { action: res.action, headline: res.headline, entry: p?.entry ?? null, stop: p?.stop ?? null, target: p?.target ?? null, shares: p?.shares ?? null, plannedRisk: p?.maxLoss ?? null };
      deps.log('calculator_result', { id: r.id, action: res.action, entry: p?.entry, stop: p?.stop, target: p?.target, shares: p?.shares });
      deps.log('hard_rule_result', { id: r.id, eligible: res.eligible, fails: res.hardFails.map((f) => f.code) });
    }
    const review = snapshot.issues.filter((i) => i.kind === 'REVIEW');
    if (review.length) deps.log('data_mismatch', { id: r.id, codes: review.map((i) => i.code) });
    v12Enrich(r, bars, cfg, deps);
    deps.log('candidate_enriched', { id: r.id, bars: bars.length, signal: snapshot.signal?.label, confirm15m: snapshot.confirm15m?.label, issues: snapshot.issues.map((i) => i.code), ms: deps.now() - started });
  } catch (e) {
    r.status = 'DATA_ERROR';
    r.errors = [(e as Error).message];
    deps.log('market_data_fetch_failed', { id: r.id, symbol: r.alert.symbol, error: (e as Error).message, attempt: r.attempts });
  }
  r.processedIso = new Date(deps.now()).toISOString();
  // Immutability: never overwrite a record that another invocation already completed.
  const current = await deps.store.get(date, r.id);
  if (current?.status === 'OK') return current;
  await deps.store.put(date, r);
  deps.log('record_stored', { id: r.id, status: r.status });
  return r;
}

/* ── RB v1.2 SHADOW audit (additive; RB_V1_2_ARCHITECTURE.md §15). v1.1 stays the active path: nothing below can
   change, reject or delay the v1.1 record, and any failure only marks the audit. ── */

/**
 * Receipt-time audit plus the v1.2 dedupe key. While v1.1 is active the v1.2 key is RECORDED, not enforced: a record
 * whose v1.2 key already exists (a redelivery of the same candle) is still stored exactly as v1.1 would, and only its
 * audit is linked to the earlier record (`duplicateOf`), so the v1.2 shadow decision treats it as a duplicate. Both
 * keys are enforced at promotion.
 */
async function v12Receipt(rec: AutoAlertRecordV12, body: unknown, receivedMs: number, v11Key: string, deps: ProcessDeps): Promise<void> {
  try {
    const audit = receiptAudit({ body, symbol: rec.alert.symbol, direction: rec.alert.direction, receivedMs, v11Key });
    const owner = await deps.store.getDedupe(audit.dedupeKeys.v12);
    if (owner) audit.duplicateOf = owner;
    else await deps.store.setDedupe(audit.dedupeKeys.v12, rec.id);
    rec.v12 = audit;
    deps.log('v12_shadow_audit', { id: rec.id, qualification: audit.qualification.status, ruleSet: audit.qualification.ruleSet.status, mapping: audit.signalMapping.status, lagSec: audit.signalMapping.lagSec, duplicateOf: audit.duplicateOf });
  } catch (e) {
    rec.v12 = undefined;
    deps.log('v12_audit_failed', { id: rec.id, stage: 'receipt', error: (e as Error).message });
  }
}

function v12Enrich(r: AutoAlertRecordV12, bars: Parameters<typeof withReconstruction>[2], cfg: SnapshotConfig, deps: ProcessDeps): void {
  if (!r.v12) return;
  try {
    // SIP RVOL is diagnostic in v1.2: if a missing SIP RVOL emptied the v1.1 snapshot, rebuild the same bars with RVOL
    // optional (any other missing input still leaves the rebuild incomplete).
    const rvolOptional = needsRvolOptionalSnapshot(r.snapshot) ? buildAlertSnapshot(bars, r.alert.alertTimeMs, r.alert.direction, { ...cfg, optionalIndicators: ['RVOL20'] }) : null;
    r.v12 = withReconstruction(r.v12, r, bars, r.alert.direction, DEFAULT_AUTOMATION.parity, rvolOptional);
  } catch (e) {
    r.v12 = { ...r.v12, error: (e as Error).message };
    deps.log('v12_audit_failed', { id: r.id, stage: 'enrichment', error: (e as Error).message });
  }
}
