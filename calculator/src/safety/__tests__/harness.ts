/**
 * S1 safety harness — drives the REAL decision interfaces exactly as App.tsx does, at one evaluation instant:
 *   Live Alert Queue  : buildQueue → freezeAlertSnapshots → latchTerminalEvents (the app's effects, fed into the next pass)
 *   Opportunity Ranker: reconcileExposure(candidates) → rankCandidates(candidates, positions, …, exclude)   (App.tsx:314–323)
 *                       → gateRankingByAuthorization(ranking, executionAuthorizations(queue rows), now)      (App.tsx, S2a)
 *   `ranked` is what the Ranker page displays (gated); `rawRanked` is the ungated quality ranking.
 * Nothing here re-implements a rule; the helpers only read what the two surfaces would display.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../../engine/automation/alertDecision';
import { buildQueue, type QueueRow } from '../../engine/automation/liveQueue';
import { freezeAlertSnapshots, type AlertSnapshotMap } from '../../engine/automation/lifecycle/alertTimeSnapshot';
import { latchTerminalEvents, type TerminalEventMap } from '../../engine/automation/lifecycle/terminalEvents';
import { reconcileExposure } from '../../engine/automation/lifecycle/portfolioExposure';
import { etParts } from '../../engine/automation/etTime';
import { rankCandidates, type RankedCandidate } from '../../engine/ranker/candidateRanker';
import { KNOWN_CLASSIFICATIONS } from '../../engine/ranker/correlationRules';
import type { Candidate, ManualPosition } from '../../engine/ranker/opportunityTypes';
import { cloneRankerDefaults } from '../../engine/ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../engine/settings';
import type { AutoAlertRecordV12 } from '../../engine/automation/v12/audit';
import { executionAuthorizations } from '../../engine/automation/lifecycle/executionState';
import { gateRankingByAuthorization } from '../../components/portfolioGate';

export interface Fixture {
  _provenance: Record<string, string>;
  stepsMs: number[];
  records: AutoAlertRecordV12[];
  quotes: Record<string, ([number, string] | null)[]>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const loadFixture = (name: string): Fixture => JSON.parse(readFileSync(resolve(HERE, 'fixtures', `${name}.json`), 'utf8')) as Fixture;

export const RK = cloneRankerDefaults();
export const STRATEGY = { entryWindowStart: RB_V1_DEFAULTS.entryWindowStart, entryWindowEnd: RB_V1_DEFAULTS.entryWindowEnd, chaseThresholdAtr: RB_V1_DEFAULTS.chaseThresholdAtr };
export const classify = (s: string) => KNOWN_CLASSIFICATIONS[s] ?? { sector: `Sector-${s}`, industry: `Industry-${s}`, theme: '' };

export interface Step { now: number; quotes: Record<string, LiveQuote> }
export interface State { candidates: Candidate[]; frozen: AlertSnapshotMap; terminal: TerminalEventMap }
export interface Pass {
  now: number;
  rows: QueueRow[];
  row: (id: string) => QueueRow | undefined;
  ranked: (id: string) => RankedCandidate | undefined;
  rawRanked: (id: string) => RankedCandidate | undefined;
  state: State;
}

/** Fixture quotes at every step: latest REAL round-lot trade (fetched 300 ms before `now`, received 100 ms before). */
export function fixtureSteps(fx: Fixture, from = 0, to = fx.stepsMs.length): Step[] {
  return fx.stepsMs.slice(from, to).map((now, k) => {
    const i = from + k;
    const quotes: Record<string, LiveQuote> = {};
    for (const [sym, arr] of Object.entries(fx.quotes)) {
      const q = arr[i];
      if (q) quotes[sym] = { price: q[0], tradeIso: q[1], fetchedIso: new Date(now - 300).toISOString(), receivedMs: now - 100 };
    }
    return { now, quotes };
  });
}

/** A synthetic quote: data `ageMs` old, last trade `tradeAgeMs` before the fetch. */
export const synthQuote = (price: number, now: number, ageMs = 500, tradeAgeMs = 1000): LiveQuote =>
  ({ price, tradeIso: new Date(now - ageMs - tradeAgeMs).toISOString(), fetchedIso: new Date(now - ageMs).toISOString(), receivedMs: now - ageMs });

export interface RunOpts {
  start?: State;
  positions?: ManualPosition[];
  portfolioGate?: string | null;
  /** Mutate candidates before a pass (user actions such as "Mark order submitted"). */
  before?: (now: number, cs: Candidate[]) => Candidate[];
}

/** The app loop over `steps`; every pass returns what both surfaces would show at that instant. */
export function runApp(records: AutoAlertRecord[], steps: Step[], o: RunOpts = {}): Pass[] {
  let { candidates, frozen, terminal } = o.start ?? { candidates: [] as Candidate[], frozen: {} as AlertSnapshotMap, terminal: {} as TerminalEventMap };
  const positions = o.positions ?? [];
  return steps.map(({ now, quotes }) => {
    if (o.before) candidates = o.before(now, candidates);
    const recs = records
      .filter((r) => r.receivedMs <= now)
      .map((r) => (Date.parse(r.firstProcessedIso ?? r.processedIso ?? r.receivedIso) > now ? { ...r, status: 'RECEIVED' as const } : r));
    const q = buildQueue({ records: recs, candidates, positions, quotes, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: RK, classify, parity: {}, strategyVersion: 'RB v1.1', frozen, terminal, portfolioGate: o.portfolioGate ?? null });
    candidates = q.candidates;
    frozen = freezeAlertSnapshots(frozen, q.rows, now, 91).map;
    terminal = latchTerminalEvents(terminal, q.rows, now, DEFAULT_AUTOMATION).map;
    const ex = reconcileExposure(candidates, positions, null, { classify, conservativeRisk: RK.portfolio.accountEquity * RK.portfolio.riskPerTradePct, now, maxPositionValue: RK.portfolio.maxPositionValue });
    const ranking = rankCandidates(candidates, ex.positions, RK, etParts(now).date, STRATEGY, ex.exclude);
    const view = gateRankingByAuthorization(ranking, executionAuthorizations(q.rows, now), now, DEFAULT_AUTOMATION.maxDataAgeSec * 1000);
    const byId = new Map(q.rows.map((r) => [r.record.id, r]));
    const rk = new Map(view.ranked.map((r) => [r.candidate.id, r]));
    const raw = new Map(ranking.ranked.map((r) => [r.candidate.id, r]));
    return { now, rows: q.rows, row: (id) => byId.get(id), ranked: (id) => rk.get(id), rawRanked: (id) => raw.get(id), state: { candidates, frozen, terminal } };
  });
}

/** The Live Alert Queue offers an order to place (the same predicate as LiveQueuePage's action cards). */
export const queueAuthorizes = (r: QueueRow | undefined): boolean =>
  !!r && !!r.decision.ticket && r.lifecycle.finalActionability === 'READY' && !r.lifecycle.entryWindowClosed && !r.lifecycle.setupFailed && !r.lifecycle.portfolioUnverified;

/** The Opportunity Ranker shows an actionable TRADE NOW recommendation. */
export const rankerAuthorizes = (r: RankedCandidate | undefined): boolean => !!r?.recommendation?.startsWith('TRADE NOW');

export const et = (ms: number) => new Date(ms - 5 * 3600_000).toISOString().slice(11, 19);
export const comps = (r: RankedCandidate | null | undefined) => Object.fromEntries((r?.components ?? []).map((k) => [k.key, k.points]));
