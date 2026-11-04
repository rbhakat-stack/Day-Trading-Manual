/**
 * Live Alert Queue orchestration (pure, deterministic for a given `now`).
 *
 *   records (immutable server snapshots) + the app's candidates/positions + live quotes
 *     → micro-batch release → candidates created once from the frozen snapshot (shared calculator)
 *     → live state re-evaluated with the current price (shared calculator)
 *     → ONE global ranking with the existing Opportunity Ranker (score → portfolio → correlation → capital;
 *       arrival time only breaks exact ties) → final safety gate per alert.
 *
 * Alerts are processed independently and ranked together; nothing is decided by arrival order.
 */
import { rankCandidates, snapshotOf, type RankedCandidate, type ReplacementSuggestion, type StrategyRules } from '../ranker/candidateRanker';
import type { Candidate, ManualPosition } from '../ranker/opportunityTypes';
import type { RankerSettings } from '../ranker/rankerSettings';
import type { RbSettings } from '../settings';
import type { TradeResult } from '../tradeCalculator';
import { existingCandidateFor, priceMismatch, releasedIds, type AlertDecision, type AutomationConfig, type AutoAlertRecord, type LiveQuote } from './alertDecision';
import { candidateFromRecord, livePatch, liveState, type Classification } from './autoCandidate';
import { etParts } from './etTime';
import type { AutoAlertRecordV12, V12Audit } from './v12/audit';
import { decideAlertV12, type V12Decision } from './v12/decideAlertV12';
import { decideActive, decideShadow } from './v12/dispatch';
import { shadowRanking } from './v12/v12Ranking';
import type { AlertSnapshotMap } from './lifecycle/alertTimeSnapshot';
import { chaseKey, type TerminalEventMap } from './lifecycle/terminalEvents';
import { reconcileExposure, type BrokerExposureInput, type BrokerOnlyPosition, type BrokerWorkingEntry, type ExposureAdjustment, type ReleasedExposureMap } from './lifecycle/portfolioExposure';
import { deriveLifecycle, eodStatus, type Lifecycle } from './lifecycle/executionState';

export interface QueueInput {
  records: AutoAlertRecord[];
  candidates: Candidate[];
  positions: ManualPosition[];
  quotes: Record<string, LiveQuote>;
  now: number;
  cfg: AutomationConfig;
  rb: RbSettings;
  rk: RankerSettings;
  classify: (symbol: string) => Classification | null;
  /** Parity mismatches entered on the Data Validation screen, by record id. */
  parity: Record<string, string[]>;
  strategyVersion: string;
  /** Immutable alert-time snapshots (CR-03), read only — used for the separate execution layer. */
  frozen?: AlertSnapshotMap;
  /** Latched terminal events (SETUP FAILED), read only — execution layer only. */
  terminal?: TerminalEventMap;
  /** Read-only broker facts for portfolio exposure (released only when verified; absent = previous behaviour). */
  broker?: BrokerExposureInput;
  /** Releases already proven by earlier verified broker responses (write-once; persisted by the app). */
  releasedExposure?: ReleasedExposureMap;
  /** Broker-only working entries from the last verified broker response (kept while data is unverified). */
  knownBrokerEntries?: BrokerWorkingEntry[];
  /** Broker-only positions from the last verified broker response (kept while data is unverified). */
  knownBrokerPositions?: BrokerOnlyPosition[];
  /** Portfolio verification gate (reason) — set when broker sync is enabled and the portfolio is not verified. */
  portfolioGate?: string | null;
}

export interface QueueRow {
  record: AutoAlertRecord;
  candidate: Candidate | null;
  ranked: RankedCandidate | null;
  live: TradeResult | null;
  quote: LiveQuote | null;
  /** Active decision — decided by the record's own logic version (RB v1.1 for every record while v1.2 is shadow). */
  decision: AlertDecision;
  /** RB v1.2 SHADOW decision (comparison only; never drives the queue). Null for records without a v1.2 audit. */
  shadow: V12Decision | null;
  /** v1.2 execution layer (CR-04/05/06/07/10/13): presentation of the decisions above; never feeds back into them. */
  lifecycle: Lifecycle;
}

export interface QueueOutput {
  candidates: Candidate[];
  rows: QueueRow[];
  /** Pending-order replacement prompts from the existing ranker (never acted on automatically). */
  suggestions: ReplacementSuggestion[];
  changed: boolean;
  /** Broker-verified exposure adjustments used by the allocator (records are unchanged). */
  exposure: Pick<ExposureAdjustment, 'verified' | 'released' | 'voided' | 'added' | 'entries' | 'brokerPositions' | 'entriesSource'>;
}

const LIVE_STATUSES = ['NEW', 'WATCHLIST'];

export function buildQueue(q: QueueInput): QueueOutput {
  const released = releasedIds(q.records, q.now, q.cfg);
  const byId = new Map(q.candidates.map((c) => [c.id, c]));
  let changed = false;
  const window: StrategyRules = { entryWindowStart: q.rb.entryWindowStart, entryWindowEnd: q.rb.entryWindowEnd, chaseThresholdAtr: q.rb.chaseThresholdAtr };
  const dup = new Map<string, string | null>();
  const lives = new Map<string, TradeResult | null>();

  // Oldest first, so an earlier alert owns the ticker before a later duplicate is considered.
  const recs = [...q.records].sort((a, b) => a.alert.alertTimeMs - b.alert.alertTimeMs || a.receivedMs - b.receivedMs);
  let candidates = [...q.candidates];
  for (const rec of recs) {
    if (!released.has(rec.id) || rec.status !== 'OK') continue;
    const quote = q.quotes[rec.alert.symbol] ?? null;
    const existing = byId.get(rec.id);
    if (!existing) {
      const d = existingCandidateFor(rec, candidates, q.now);
      dup.set(rec.id, d);
      if (d) continue;
      const price = quote?.price ?? rec.initialQuote?.price;
      if (!price) continue;
      const c = candidateFromRecord(rec, price, q.now, q.rb, q.classify(rec.alert.symbol));
      if (!c) continue;
      candidates.push(c);
      byId.set(c.id, c);
      lives.set(rec.id, liveState(rec, price, q.now, q.rb));
      changed = true;
      continue;
    }
    dup.set(rec.id, null);
    // Dynamic state only for candidates still waiting for a decision. Frozen alert-time values are never touched.
    if (LIVE_STATUSES.includes(existing.status)) {
      const price = quote?.price ?? existing.currentPrice;
      const live = liveState(rec, price, q.now, q.rb);
      lives.set(rec.id, live);
      if (live) {
        const patch = livePatch(live, price);
        const cls = !existing.inputs.sector ? q.classify(rec.alert.symbol) : null;
        const next: Candidate = { ...existing, ...patch, ...(cls ? { inputs: { ...existing.inputs, ...cls } } : {}) };
        if (JSON.stringify(next) !== JSON.stringify(existing)) {
          candidates = candidates.map((c) => (c.id === next.id ? next : c));
          byId.set(next.id, next);
          changed = true;
        }
      }
    } else {
      lives.set(rec.id, liveState(rec, quote?.price ?? existing.currentPrice, q.now, q.rb));
    }
  }

  const today = etParts(q.now).date;
  // Alerts whose data cannot be trusted can never receive a ticket, so they must not consume capital, a slot, heat or
  // a correlation slot in the allocation. They are scored separately for display only (no rank).
  const recById = new Map(q.records.map((r) => [r.id, r]));
  const dataBlocked = new Set(
    candidates
      .filter((c) => c.source === 'AUTO' && LIVE_STATUSES.includes(c.status))
      .filter((c) => {
        const rec = recById.get(c.id);
        if (!rec) return false;
        return (rec.snapshot?.issues.length ?? 0) > 0 || (q.parity[rec.id] ?? []).length > 0 || !!priceMismatch(rec.alert.lastPrice, rec.initialQuote?.price ?? null, q.cfg)?.mismatch;
      })
      .map((c) => c.id),
  );
  // Portfolio exposure seen by the allocator: broker-verified closes release capacity; uncertain data releases nothing.
  const exp = reconcileExposure(candidates, q.positions, q.broker, { classify: q.classify, conservativeRisk: q.rk.portfolio.accountEquity * q.rk.portfolio.riskPerTradePct, latched: q.releasedExposure, now: q.now, knownEntries: q.knownBrokerEntries, knownPositions: q.knownBrokerPositions, maxPositionValue: q.rk.portfolio.maxPositionValue });
  const ranking = rankCandidates(candidates.filter((c) => !dataBlocked.has(c.id)), exp.positions, q.rk, today, window, exp.exclude);
  const display = dataBlocked.size ? rankCandidates(candidates, exp.positions, q.rk, today, window, exp.exclude) : ranking;
  const rankedById = new Map(ranking.ranked.map((r) => [r.candidate.id, r]));
  for (const r of display.ranked) if (dataBlocked.has(r.candidate.id)) rankedById.set(r.candidate.id, { ...r, rank: null });

  // Freeze the initial score the first time an automated candidate is completely scored (never rewritten).
  candidates = candidates.map((c) => {
    const r = rankedById.get(c.id);
    if (c.source === 'AUTO' && !c.initialScore && r && r.total !== null) {
      changed = true;
      return { ...c, initialScore: snapshotOf(r, q.now, q.rk, window, q.strategyVersion) };
    }
    return c;
  });

  // RB v1.2 SHADOW (comparison only): pre-pass → which qualified records reach scoring → v1.2 ranking pass over
  // copies of their candidates → final shadow decisions. Nothing here touches the v1.1 ranking, decisions or candidates.
  // A record whose v1.1 snapshot is incomplete only because SIP RVOL could not be calculated has no v1.1 candidate;
  // v1.2 builds a shadow-only candidate from its RVOL-optional rebuild (never added to `candidates`, never persisted).
  const v12Lives = new Map(lives);
  const v12Only: Candidate[] = [];
  for (const rec of q.records as AutoAlertRecordV12[]) {
    const snap = rec.v12?.rvolOptionalSnapshot;
    if (!snap?.values || rec.status !== 'OK' || !released.has(rec.id) || byId.has(rec.id) || dup.get(rec.id)) continue;
    const price = q.quotes[rec.alert.symbol]?.price ?? rec.initialQuote?.price;
    if (!price) continue;
    const r12: AutoAlertRecord = { ...rec, snapshot: snap };
    v12Lives.set(rec.id, liveState(r12, price, q.now, q.rb));
    const c = candidateFromRecord(r12, price, q.now, q.rb, q.classify(rec.alert.symbol));
    if (c) v12Only.push(c);
  }
  const v12Base = (rec: AutoAlertRecord) => ({
    released: released.has(rec.id), candidateStatus: byId.get(rec.id)?.status ?? null, live: v12Lives.get(rec.id) ?? null,
    quote: q.quotes[rec.alert.symbol] ?? null, now: q.now, cfg: q.cfg, duplicateOf: dup.get(rec.id) ?? null, window,
  });
  const audits = new Map<string, V12Audit>();
  const v12Pool = new Set<string>();
  for (const rec of q.records as AutoAlertRecordV12[]) {
    if (!rec.v12) continue;
    audits.set(rec.id, rec.v12);
    if (decideAlertV12({ ...v12Base(rec), record: rec, mode: 'SHADOW', ranked: null }).scoring === 'PENDING_V12_RANKING') v12Pool.add(rec.id);
  }
  const v12Rank = v12Pool.size ? shadowRanking({ candidates: [...exp.candidates, ...v12Only], poolIds: v12Pool, lives: v12Lives, audits, positions: exp.positions, rk: q.rk, today, window }).byId : new Map();

  const eod = eodStatus(q.now, candidates, q.positions);
  const rows: QueueRow[] = q.records.map((rec) => {
    const candidate = byId.get(rec.id) ?? null;
    const ranked = rankedById.get(rec.id) ?? null;
    const quote = q.quotes[rec.alert.symbol] ?? null;
    const live = lives.get(rec.id) ?? null;
    const v12Inputs = { ...v12Base(rec), ranked: v12Rank.get(rec.id) ?? null, optionAGrades: q.rk.grades, v11Total: ranked?.total ?? null };
    const { decision } = decideActive({
      record: rec,
      released: released.has(rec.id),
      candidate,
      ranked,
      live,
      quote,
      now: q.now,
      cfg: q.cfg,
      parityMismatches: q.parity[rec.id] ?? [],
      duplicateOf: dup.get(rec.id) ?? null,
      window,
    }, v12Inputs);
    const shadow = decideShadow(rec as AutoAlertRecordV12, v12Inputs);
    const row = { record: rec, candidate, ranked, live, quote, decision, shadow } as QueueRow;
    row.lifecycle = deriveLifecycle(row, q.frozen?.[rec.id] ?? null, q.now, eod, q.terminal?.[rec.id] ?? null, q.portfolioGate ?? null, q.terminal?.[chaseKey(rec.id)] ?? null);
    return row;
  });

  return { candidates, rows: sortRows(rows), suggestions: ranking.suggestions, changed, exposure: { verified: exp.verified, released: exp.released, voided: exp.voided, added: exp.added, entries: exp.entries, brokerPositions: exp.brokerPositions, entriesSource: exp.entriesSource } };
}

const SECTION_ORDER = ['ACTION_NOW', 'HIGH_PRIORITY', 'DATA_REVIEW', 'SCORING', 'ACTIVE', 'WATCHLIST', 'IGNORE', 'CLOSED'];

/** Global order: section, then the ranker's rank, then score, then freshness (newer first), then arrival time. */
export function sortRows(rows: QueueRow[]): QueueRow[] {
  return [...rows].sort(
    (a, b) =>
      SECTION_ORDER.indexOf(a.decision.section) - SECTION_ORDER.indexOf(b.decision.section) ||
      (a.ranked?.rank ?? 1e9) - (b.ranked?.rank ?? 1e9) ||
      (b.ranked?.total ?? -1) - (a.ranked?.total ?? -1) ||
      b.record.alert.alertTimeMs - a.record.alert.alertTimeMs ||
      a.record.receivedMs - b.record.receivedMs ||
      a.record.id.localeCompare(b.record.id),
  );
}
