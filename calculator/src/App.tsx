import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { evaluateTrade } from './engine/tradeCalculator';
import { RB_V1_DEFAULTS, type RbSettings } from './engine/settings';
import { SCENARIOS } from './engine/scenarios';
import type { JournalEntry, Outcome } from './engine/journal';
import { rankCandidates, snapshotOf, type StrategyRules } from './engine/ranker/candidateRanker';
import { HARD_FAIL_LABELS, RULES_VERSION, SCORING_VERSION } from './engine/rules';
import type { Candidate, LifecycleStatus, ManualPosition } from './engine/ranker/opportunityTypes';
import { cloneRankerDefaults, migrateRankerSettings, validateRankerSettings, type RankerSettings } from './engine/ranker/rankerSettings';
import { emptyInputs, sampleDay } from './engine/ranker/rankerSamples';
import { emptyForm, formFromInputs, toInputs, type FormState } from './lib/form';
import { parseNum } from './lib/format';
import { download, KEYS, load, save } from './lib/storage';
import { nowEt, previousDate } from './lib/time';
import { InputPanel } from './components/InputPanel';
import { DecisionPanel } from './components/DecisionPanel';
import { RiskPanel } from './components/RiskPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { JournalView } from './components/JournalView';
import { Dashboard } from './components/Dashboard';
import { RankerPage, type RankerActions } from './components/ranker/RankerPage';
import { StrategyVersionBar, type PendingVersionChange, type VersionControls } from './components/StrategyVersionBar';
import { LiveQueuePage, type LiveActions } from './components/live/LiveQueuePage';
import { AutomationSettings } from './components/live/AutomationSettings';
import { ParityView } from './components/live/ParityView';
import { HistoricalSipTest } from './components/live/HistoricalSipTest';
import { buildQueue } from './engine/automation/liveQueue';
import { inputsFromRecord } from './engine/automation/autoCandidate';
import { compareParity, mismatchMessages, paritySummary, type ParityEntry, type ParityRow } from './engine/automation/parity';
import { etParts } from './engine/automation/etTime';
import { freezeShadowScores, shadowLogCsv, type V12ShadowLog } from './engine/automation/v12/shadowLog';
import { v12MaxScore } from './engine/automation/v12/v12Thresholds';
import { alertSnapshotsCsv, freezeAlertSnapshots, pruneAlertSnapshots, type AlertSnapshotMap } from './engine/automation/lifecycle/alertTimeSnapshot';
import { executionStatus } from './engine/automation/lifecycle/executionStatus';
import { brokerExposureSnapshot, brokerSyncOff, executionRevPatch, historyDatesFor, latchReleases, portfolioVerification, reconcileExposure, verifiedHistory, type BrokerExposureInput, type BrokerExposureSnapshot, type ReleasedExposureMap } from './engine/automation/lifecycle/portfolioExposure';
import { latchTerminalEvents, pruneTerminalEvents, type TerminalEventMap } from './engine/automation/lifecycle/terminalEvents';
import { brokerOrdersFrom, reconcileBroker, syncJournalWhenReady, withAlertTimeDecision, type SyncContext, type TradeSync } from './engine/automation/lifecycle/brokerSync';
import { AUTO_KEYS, initialClassifications, loadAutomationConfig, loadParity, useAlertRecords, useBrokerFeed, useBrokerHistory, useBrokerSymbolHistory, useLiveQuotes, usePersistent, useServerFlags, type ClassMap } from './lib/automationClient';
import { applyCrossDay, cr15Gate, crossDayEvidenceVerified, crossDayRequest, planCrossDay, validateReconciledJournal, type Cr15Mode, type CrossDayEvidence, type CrossDayPlan } from './engine/automation/lifecycle/crossDayJournal';
import { ensurePreCr15Backup, readBackup, restorePreCr15 } from './lib/journalBackup';
import { Cr15Panel } from './components/Cr15Panel';
import { LogoutButton } from './auth/LogoutButton'; // CR-16: header Log out (renders only when signed in)
import {
  changedCoreFields,
  coreChanged,
  FROZEN_FINGERPRINT,
  FROZEN_VERSION,
  coreFingerprint,
  nextVersion,
  resolveVersion,
  versionLabel,
  type StrategyVersionState,
} from './engine/strategyVersion';

type Tab = 'live' | 'calc' | 'ranker' | 'journal' | 'dashboard' | 'settings';
type LiveSub = 'queue' | 'parity' | 'historical' | 'automation';

const newId = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function loadRankerSettings(): RankerSettings {
  const merged = migrateRankerSettings(load<RankerSettings | null>(KEYS.rankerSettings, null));
  return validateRankerSettings(merged).length ? cloneRankerDefaults() : merged;
}

export default function App() {
  const [settings, setSettings] = useState<RbSettings>(() => ({ ...RB_V1_DEFAULTS, ...load<Partial<RbSettings>>(KEYS.settings, {}) }));
  const [form, setForm] = useState<FormState>(() => emptyForm(settings));
  const [calculated, setCalculated] = useState(false);
  const [useMarketEntry, setUseMarketEntry] = useState(false);
  const [actualFill, setActualFill] = useState('');
  const [journal, setJournal] = useState<JournalEntry[]>(() => load<JournalEntry[]>(KEYS.journal, []));
  const [tab, setTab] = useState<Tab>(() => (loadAutomationConfig().enabled ? 'live' : 'calc'));
  const [liveSub, setLiveSub] = useState<LiveSub>('queue');
  const [savedFlash, setSavedFlash] = useState(false);
  const decisionRef = useRef<HTMLDivElement>(null);

  // ── Opportunity Ranker state ──
  const [candidates, setCandidates] = useState<Candidate[]>(() => load<Candidate[]>(KEYS.candidates, []));
  const [positions, setPositions] = useState<ManualPosition[]>(() => load<ManualPosition[]>(KEYS.positions, []));
  const [rankerSettings, setRankerSettings] = useState<RankerSettings>(loadRankerSettings);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const today = nowEt().date;

  // ── Strategy version (RB v1.1 — FROZEN FOR PAPER TESTING) ──
  const [version, setVersion] = useState<StrategyVersionState>(() => resolveVersion(load<StrategyVersionState | null>(KEYS.strategyVersion, null), settings, rankerSettings));
  const [pending, setPending] = useState<(PendingVersionChange & { rb: RbSettings; rk: RankerSettings }) | null>(null);
  const [settingsEpoch, setSettingsEpoch] = useState(0); // remounts settings forms after a cancelled change
  useEffect(() => void save(KEYS.strategyVersion, version), [version]);

  /**
   * THE gate for every settings change. Non-core changes apply directly. Restoring the frozen definition
   * returns to RB v1.1. Any other core change needs an unlocked state AND an explicit new version name.
   */
  const proposeSettings = (rb: RbSettings, rk: RankerSettings): boolean => {
    if (!coreChanged([settings, rankerSettings], [rb, rk])) {
      setSettings(rb);
      setRankerSettings(rk);
      return true;
    }
    if (coreFingerprint(rb, rk) === FROZEN_FINGERPRINT) {
      setSettings(rb);
      setRankerSettings(rk);
      setVersion({ name: FROZEN_VERSION, locked: true });
      setPending(null);
      return true;
    }
    if (version.locked) return false; // strategy definition is read-only until deliberately unlocked
    setPending({ rb, rk, fields: changedCoreFields([settings, rankerSettings], [rb, rk]), suggested: nextVersion(version.name) });
    return false;
  };
  const versionControls: VersionControls = {
    label: versionLabel(version, settings, rankerSettings),
    name: version.name,
    frozen: versionLabel(version, settings, rankerSettings).includes('FROZEN'),
    locked: version.locked,
    pending: pending ? { fields: pending.fields, suggested: pending.suggested } : null,
    setLocked: (locked) => {
      setVersion((v) => ({ ...v, locked }));
      if (locked) {
        setPending(null);
        setSettingsEpoch((n) => n + 1);
      }
    },
    confirmPending: (name) => {
      if (!pending) return;
      setSettings(pending.rb);
      setRankerSettings(pending.rk);
      setVersion((v) => ({ ...v, name }));
      setPending(null);
    },
    cancelPending: () => {
      setPending(null);
      setSettingsEpoch((n) => n + 1);
    },
  };

  useEffect(() => void save(KEYS.settings, settings), [settings]);
  useEffect(() => void save(KEYS.journal, journal), [journal]);
  useEffect(() => void save(KEYS.candidates, candidates), [candidates]);
  useEffect(() => void save(KEYS.positions, positions), [positions]);
  useEffect(() => void save(KEYS.rankerSettings, rankerSettings), [rankerSettings]);

  const inputs = useMemo(() => toInputs(form, useMarketEntry), [form, useMarketEntry]);
  const result = useMemo(() => (calculated ? evaluateTrade(inputs, settings) : null), [calculated, inputs, settings]);
  // Strategy rules shared by Calculator and Ranker (single source: calculator Settings).
  const strategy: StrategyRules = useMemo(
    () => ({ entryWindowStart: settings.entryWindowStart, entryWindowEnd: settings.entryWindowEnd, chaseThresholdAtr: settings.chaseThresholdAtr }),
    [settings.entryWindowStart, settings.entryWindowEnd, settings.chaseThresholdAtr],
  );

  const setField = useCallback(<K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setUseMarketEntry(false); // any change discards a market-entry choice
    setActualFill('');
  }, []);

  const calculate = () => {
    setCalculated(true);
    if (window.matchMedia('(max-width: 1023px)').matches) {
      setTimeout(() => decisionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }
  };

  const clear = () => {
    setForm(emptyForm(settings, form.direction));
    setCalculated(false);
    setUseMarketEntry(false);
    setActualFill('');
  };

  const loadScenario = (id: string) => {
    const s = SCENARIOS.find((x) => x.id === id);
    if (!s) return;
    setForm(formFromInputs(s.inputs));
    setUseMarketEntry(false);
    setActualFill('');
    setCalculated(true);
    setTab('calc');
  };

  const saveToJournal = () => {
    if (!result) return;
    const p = result.ticket ?? result.plan;
    const { date, time } = nowEt();
    const fill = parseNum(actualFill);
    const entry: JournalEntry = {
      id: newId('j'),
      ticker: inputs.ticker,
      date,
      time,
      direction: inputs.direction,
      open: inputs.open,
      high: inputs.high,
      low: inputs.low,
      close: inputs.close,
      atr: inputs.atr,
      alertPrice: inputs.currentPrice,
      decision: result.action,
      orderType: result.ready && p ? p.orderType : result.headline,
      plannedEntry: p?.entry ?? 0,
      actualFill: result.ready && Number.isFinite(fill) && fill > 0 ? fill : null,
      stop: p?.stop ?? 0,
      target: p?.target ?? 0,
      quantity: result.ready && p ? p.shares : 0,
      positionValue: result.ready && p ? p.positionValue : 0,
      expectedRisk: result.ready && p ? p.maxLoss : 0,
      expectedReward: result.ready && p ? p.potentialProfit : 0,
      outcome: result.ready ? 'OPEN' : 'SKIPPED',
      exitPrice: null,
      notes: result.ready ? '' : `${result.headline}${result.hardFails.length ? ` — ${result.hardFails.map((f) => f.reason).join(' | ')}` : ''}`,
      hardFailCodes: result.hardFails.map((f) => f.code),
      rulesVersion: RULES_VERSION,
    };
    setJournal((j) => [...j, entry]);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  };

  /** Calculator → Ranker: transfer everything the calculator already knows. */
  const sendToRanker = () => {
    // Only an eligible, ready ticket can be sent. Hard-failed results never reach the ranker.
    if (!result?.ready || !result.eligible || !result.ticket || result.hardFails.length) return;
    const p = result.ticket;
    const chase = p.entryMethod === 'MARKET' ? 0 : result.chase?.distanceAtr ?? null;
    const exec = {
      open: inputs.open, high: inputs.high, low: inputs.low, close: inputs.close, atr: inputs.atr, currentPrice: inputs.currentPrice,
      entry: p.entry, stop: p.stop, target: p.target, shares: p.shares, positionValue: p.positionValue, plannedRisk: p.maxLoss,
      expectedReward: p.potentialProfit, orderType: p.orderType, calcAction: result.action, calcReady: result.ready,
      chaseDistanceAtr: chase, minutesSinceAlert: inputs.minutesSinceAlert ?? null,
      alertTime: inputs.alertTime, calcHardFails: result.hardFails, rulesVersion: RULES_VERSION,
    };
    const existing = candidates.find(
      (c) => c.date === today && !c.archived && c.ticker === inputs.ticker && c.direction === inputs.direction && ['NEW', 'WATCHLIST', 'PENDING', 'FILLED'].includes(c.status),
    );
    if (existing && (existing.status === 'PENDING' || existing.status === 'FILLED')) {
      alert(`${existing.ticker} ${existing.direction} is already ${existing.status === 'PENDING' ? 'a pending order' : 'an active position'} in today's queue. RB v1 allows one position per ticker.`);
      setSelectedId(existing.id);
      setTab('ranker');
      return;
    }
    if (existing) {
      setCandidates((cs) => cs.map((c) => (c.id === existing.id ? { ...c, ...exec, inputs: { ...c.inputs, close15m: inputs.close15m, ema20_15m: inputs.ema20_15m } } : c)));
      setSelectedId(existing.id);
    } else {
      const c: Candidate = {
        id: newId('cand'), date: today, createdAt: Date.now(),
        ticker: inputs.ticker || 'TICKER', direction: inputs.direction, ...exec,
        inputs: { ...emptyInputs(inputs.ticker), close15m: inputs.close15m, ema20_15m: inputs.ema20_15m },
        scored: false, status: 'NEW', initialScore: null, entryScore: null, finalScore: null,
        actualFill: null, exitPrice: null, notes: '', archived: false, keptAgainst: [],
      };
      setCandidates((cs) => [...cs, c]);
      setSelectedId(c.id);
    }
    setTab('ranker');
    window.scrollTo({ top: 0 });
  };

  // ── Automated Alert Mode (Live Alert Queue) ──
  const [autoCfg, setAutoCfg] = usePersistent(AUTO_KEYS.config, loadAutomationConfig);
  const [autoToken, setAutoToken] = usePersistent<string>(AUTO_KEYS.token, () => load<string>(AUTO_KEYS.token, ''));
  const [classes, setClasses] = usePersistent<ClassMap>(AUTO_KEYS.classifications, initialClassifications);
  const [parityEntries, setParityEntries] = usePersistent<Record<string, ParityEntry>>(AUTO_KEYS.parity, loadParity);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!autoCfg.enabled) return;
    const h = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(h);
  }, [autoCfg.enabled]);
  const autoDate = etParts(clock).date;
  const feed = useAlertRecords(autoCfg, autoToken, autoDate);
  const brokerFeed = useBrokerFeed(autoCfg.enabled, autoToken, autoDate);
  const liveSymbols = useMemo(() => {
    const live = new Set(candidates.filter((c) => c.source === 'AUTO' && ['NEW', 'WATCHLIST', 'PENDING'].includes(c.status)).map((c) => c.ticker));
    for (const r of feed.records) if (r.status === 'OK' && clock - r.alert.alertTimeMs < 15 * 60_000) live.add(r.alert.symbol);
    return [...live];
  }, [candidates, feed.records, clock]);
  const { quotes, error: quoteError } = useLiveQuotes(autoCfg, autoToken, liveSymbols);
  const parityRows = useMemo(() => {
    const out: Record<string, ParityRow[]> = {};
    for (const r of feed.records) {
      const e = parityEntries[r.id];
      if (e && r.snapshot?.values) out[r.id] = compareParity(r.snapshot.values, e.trendSpider, autoCfg.parity);
    }
    return out;
  }, [feed.records, parityEntries, autoCfg.parity]);
  const paritySum = useMemo(() => paritySummary(Object.values(parityEntries), parityRows, autoCfg.parityRequired), [parityEntries, parityRows, autoCfg.parityRequired]);
  // RB v1.2 (CR-03): write-once alert-time snapshots, read by the execution layer only. Older than 90 days are pruned.
  const [alertSnaps, setAlertSnaps] = usePersistent<AlertSnapshotMap>(AUTO_KEYS.alertSnapshots, () => pruneAlertSnapshots(load<AlertSnapshotMap>(AUTO_KEYS.alertSnapshots, {}), Date.now()));
  // Broker-confirmed released portfolio reservations (write-once per candidate execution; audit trail).
  const [releasedExposure, setReleasedExposure] = usePersistent<ReleasedExposureMap>(AUTO_KEYS.releasedExposure, () => load<ReleasedExposureMap>(AUTO_KEYS.releasedExposure, {}));
  // Last VERIFIED broker-only exposure (positions + working entries); kept (reserved) while broker data is unverified.
  const [brokerSnapshot, setBrokerSnapshot] = usePersistent<BrokerExposureSnapshot | null>(AUTO_KEYS.brokerSnapshot, () => load<BrokerExposureSnapshot | null>(AUTO_KEYS.brokerSnapshot, null));
  const knownBrokerEntries = brokerSnapshot?.entries;
  const knownBrokerPositions = brokerSnapshot?.positions;
  // Portfolio verification of THIS evaluation (warning + execution gate). OFF on the server = RB-records-only mode.
  const verification = useMemo(
    () => (autoCfg.enabled && autoToken ? portfolioVerification(brokerFeed, autoDate, clock, brokerSnapshot) : brokerSyncOff(autoCfg.enabled ? 'no app access token in this browser' : 'automation is OFF in this browser')),
    [autoCfg.enabled, autoToken, brokerFeed, autoDate, clock, brokerSnapshot],
  );
  // ONE portfolio exposure model for every decision surface (Live Alert Queue, Opportunity Ranker, score freezing):
  // candidate records + manual positions + VERIFIED read-only Alpaca PAPER facts + safe release records.
  // Entry-day order lists for earlier-dated PENDING / FILLED candidates (bounded; verified responses only).
  const historyDates = useMemo(() => historyDatesFor(candidates, autoDate), [candidates, autoDate]);
  const brokerHistory = useBrokerHistory(autoCfg.enabled, autoToken, historyDates);
  const brokerExposure = useMemo<BrokerExposureInput>(
    () => ({
      verified: portfolioVerification(brokerFeed, autoDate, clock).verified, orders: brokerFeed.orders, positions: brokerFeed.positions,
      openOrders: brokerFeed.openOrders ?? null, history: verifiedHistory(brokerHistory, historyDates, clock),
    }),
    [brokerFeed, autoDate, clock, brokerHistory, historyDates],
  );
  const exposureFor = useCallback(
    (cs: Candidate[]) => reconcileExposure(cs, positions, brokerExposure, {
      classify: (s) => classes[s] ?? null, conservativeRisk: rankerSettings.portfolio.accountEquity * rankerSettings.portfolio.riskPerTradePct, latched: releasedExposure, now: clock,
      knownEntries: knownBrokerEntries, knownPositions: knownBrokerPositions, maxPositionValue: rankerSettings.portfolio.maxPositionValue,
    }),
    [positions, brokerExposure, classes, rankerSettings, releasedExposure, clock, knownBrokerEntries, knownBrokerPositions],
  );
  const rankerExposure = useMemo(() => exposureFor(candidates), [exposureFor, candidates]);
  const ranking = useMemo(
    () => rankCandidates(candidates, rankerExposure.positions, rankerSettings, today, strategy, rankerExposure.exclude),
    [candidates, rankerExposure, rankerSettings, today, strategy],
  );
  // Terminal SETUP FAILED latch (write-once per alert; read by the execution layer only).
  const [terminalEvents, setTerminalEvents] = usePersistent<TerminalEventMap>(AUTO_KEYS.terminalEvents, () => pruneTerminalEvents(load<TerminalEventMap>(AUTO_KEYS.terminalEvents, {}), Date.now()));
  const queue = useMemo(() => {
    if (!autoCfg.enabled) return null;
    return buildQueue({
      records: feed.records,
      candidates,
      positions,
      quotes,
      now: clock,
      cfg: autoCfg,
      rb: settings,
      rk: rankerSettings,
      classify: (s) => classes[s] ?? null,
      parity: Object.fromEntries(Object.entries(parityRows).map(([id, rows]) => [id, mismatchMessages(rows)])),
      strategyVersion: version.name,
      frozen: alertSnaps,
      terminal: terminalEvents,
      // Portfolio exposure from read-only broker facts; only a live, today, fresh response may release capacity.
      broker: brokerExposure,
      releasedExposure,
      knownBrokerEntries,
      knownBrokerPositions,
      portfolioGate: verification.gated ? verification.reason : null,
    });
  }, [autoCfg, feed.records, candidates, positions, quotes, clock, settings, rankerSettings, classes, parityRows, version.name, alertSnaps, terminalEvents, brokerExposure, releasedExposure, knownBrokerEntries, knownBrokerPositions, verification]);
  useEffect(() => {
    const found = [...rankerExposure.released, ...(queue?.exposure.released ?? [])];
    if (found.length) setReleasedExposure((prev) => latchReleases(prev, found).map);
  }, [queue, rankerExposure, setReleasedExposure]);
  // Only a VERIFIED response replaces the last verified broker-only exposure (a close / cancellation is never inferred).
  useEffect(() => {
    const next = brokerExposureSnapshot(rankerExposure, brokerFeed.lastOkMs ?? clock, autoDate);
    if (next && (next.atMs !== brokerSnapshot?.atMs || JSON.stringify([next.date, next.positions, next.entries]) !== JSON.stringify([brokerSnapshot?.date, brokerSnapshot?.positions, brokerSnapshot?.entries]))) setBrokerSnapshot(next);
  }, [rankerExposure, brokerFeed.lastOkMs, clock, autoDate, brokerSnapshot, setBrokerSnapshot]);
  useEffect(() => {
    if (queue) setTerminalEvents((prev) => latchTerminalEvents(prev, queue.rows, clock, autoCfg).map);
  }, [queue, clock, autoCfg, setTerminalEvents]);
  useEffect(() => {
    if (queue) setAlertSnaps((prev) => freezeAlertSnapshots(prev, queue.rows, clock, v12MaxScore(rankerSettings)).map);
  }, [queue, clock, rankerSettings, setAlertSnaps]);
  // Read-only broker reconciliation, computed ONCE and shared by the Broker panel and the Journal sync. The strategy
  // decision comes from the frozen alert-time snapshot when available (never from what was actually traded).
  const brokerTrades = useMemo(
    () => (brokerFeed.status === 'LIVE' && queue ? withAlertTimeDecision(reconcileBroker(brokerOrdersFrom(brokerFeed.orders).orders, queue.rows, brokerFeed.positions), alertSnaps) : null),
    [brokerFeed, queue, alertSnaps],
  );
  // Journal sync: upsert broker-confirmed trades into the browser-local journal (deterministic id = broker order id).
  useEffect(() => {
    if (!brokerTrades?.length) return;
    const recs = new Map(feed.records.map((r) => [r.id, r]));
    const ctx = (t: TradeSync): SyncContext => ({
      snap: t.recordId ? alertSnaps[t.recordId] ?? null : null,
      candidate: t.recordId ? candidates.find((c) => c.id === t.recordId) ?? null : null,
      record: t.recordId ? recs.get(t.recordId) ?? null : null,
    });
    // Gate: only after today's alert feed and broker feed have both loaded (never treat "not loaded yet" as NO ALERT).
    // CR-15 AUTO: an order that is an exit of an existing Journal trade (e.g. a bracket leg of a prior-day entry listed on
    // its own today) is never added as a new opposite-side trade. With CR-15 OFF / PREVIEW nothing is filtered.
    const exits = cr15Gate(serverFlagsRef.current, cr15ModeRef.current).autoWrites ? new Set(cr15PlanRef.current?.exitOrderIds ?? []) : null;
    const trades = exits?.size ? brokerTrades.filter((x) => !exits.has(x.entryOrderId)) : brokerTrades;
    setJournal((j) => syncJournalWhenReady(j, trades, ctx, { date: autoDate, alertsLoadedFor: feed.loadedDate, brokerLoadedFor: brokerFeed.loadedDate }).journal);
  }, [brokerTrades]);

  /* ── CR-15 cross-day Journal reconciliation (effective only when the SERVER flag AND this browser's mode are on) ── */
  const serverFlags = useServerFlags(autoCfg.enabled, autoToken);
  // Saved only when you change it (a browser that never uses CR-15 gets no new storage key).
  const [cr15Mode, setCr15ModeState] = useState<Cr15Mode>(() => load<Cr15Mode>(AUTO_KEYS.cr15Mode, 'OFF'));
  const setCr15Mode = useCallback((m: Cr15Mode) => { setCr15ModeState(m); save(AUTO_KEYS.cr15Mode, m); }, []);
  const cr15On = cr15Gate(serverFlags.cr15, cr15Mode).on;
  const cr15Req = useMemo(() => crossDayRequest(journal, autoDate), [journal, autoDate]);
  const cr15Feed = useBrokerSymbolHistory(cr15On && autoCfg.enabled, autoToken, cr15Req.symbols, cr15Req.from);
  const cr15Evidence = useMemo<CrossDayEvidence | null>(
    () => (cr15On && cr15Req.from ? { verified: crossDayEvidenceVerified(cr15Feed, cr15Req, clock), complete: cr15Feed.complete, from: cr15Req.from, symbols: cr15Req.symbols, orders: cr15Feed.orders, positions: cr15Feed.positions, asOfMs: cr15Feed.lastOkMs ?? 0 } : null),
    [cr15On, cr15Req, cr15Feed, clock],
  );
  const cr15Plan = useMemo(() => (cr15On ? planCrossDay(journal, cr15Evidence) : null), [cr15On, journal, cr15Evidence]);
  const cr15PlanRef = useRef<CrossDayPlan | null>(null);
  cr15PlanRef.current = cr15Plan;
  const serverFlagsRef = useRef<boolean | null>(null);
  serverFlagsRef.current = serverFlags.cr15;
  const cr15ModeRef = useRef<Cr15Mode>('OFF');
  cr15ModeRef.current = cr15Mode;
  const [cr15Message, setCr15Message] = useState<string | null>(null);
  const [cr15Backup, setCr15Backup] = useState(() => readBackup(localStorage));
  /** Backup (verified) → plan from the latest Journal → validate → write; any failure leaves the Journal untouched. */
  const applyCr15 = useCallback((manual: boolean) => {
    const b = ensurePreCr15Backup(localStorage, new Date().toISOString());
    if (!b.ok) { setCr15Message(`Not applied: ${b.error}`); return; }
    setCr15Backup(b.backup);
    setJournal((j) => {
      const plan = planCrossDay(j, cr15Evidence);
      if (!plan.changed) return j;
      const next = applyCrossDay(j, plan, new Date().toISOString());
      const err = validateReconciledJournal(j, next);
      if (err) { setCr15Message(`Not applied: ${err}`); return j; }
      setCr15Message(`${manual ? 'Applied' : 'Auto-reconciled'}: ${plan.trades.filter((x) => x.patch).length} trade(s) updated, ${plan.supersede.length} row(s) superseded. Pre-CR-15 backup verified.`);
      return next;
    });
  }, [cr15Evidence]);
  useEffect(() => {
    if (cr15Gate(serverFlags.cr15, cr15Mode).autoWrites && cr15Plan?.changed && cr15Backup) applyCr15(false);
  }, [cr15Mode, cr15On, cr15Plan, cr15Backup, applyCr15]);
  const restoreCr15 = () => {
    if (!confirm('Restore the exact pre-CR-15 Journal? The current Journal is saved first (pre-restore backup) and CR-15 is switched OFF.')) return;
    setCr15Mode('OFF');
    const r = restorePreCr15(localStorage, new Date().toISOString());
    if (!r.ok) { setCr15Message(`Restore failed: ${r.error}`); return; }
    setJournal(r.journal);
    setCr15Message(`Restored the pre-CR-15 Journal (${r.journal.length} rows). The Journal as it was is saved under the pre-restore key.`);
  };
  // Current execution status of submitted / filled candidates (display only; candidate records are never rewritten).
  const executions = useMemo(
    () => Object.fromEntries(candidates.filter((c) => c.status === 'PENDING' || c.status === 'FILLED').map((c) => [c.id, executionStatus(c, brokerTrades, { verified: verification.verified, asOfMs: brokerFeed.lastOkMs })])),
    [candidates, brokerTrades, verification.verified, brokerFeed.lastOkMs],
  );
  useEffect(() => {
    if (queue?.changed) setCandidates(queue.candidates);
  }, [queue]);
  // RB v1.2 SHADOW: freeze the first v1.2 score per alert (Option A + B tiers, v1.1 score) for later calibration.
  const [shadowLog, setShadowLog] = usePersistent<V12ShadowLog>(AUTO_KEYS.v12ShadowLog, () => load<V12ShadowLog>(AUTO_KEYS.v12ShadowLog, {}));
  useEffect(() => {
    if (queue) setShadowLog((prev) => freezeShadowScores(prev, queue.rows, clock).log);
  }, [queue, clock, setShadowLog]);
  const exportShadowLog = () => {
    const url = URL.createObjectURL(new Blob([shadowLogCsv(shadowLog)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `rb-v1.2-shadow-log-${autoDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /**
   * Calculator ↔ Ranker sync status. The ranker only changes when "Send to Opportunity Ranker" is pressed, so tell
   * the user when the calculator shows a ticker or numbers that the ranker does not have yet.
   */
  const calcSync = useMemo(() => {
    if (!result || !inputs.ticker) return null;
    const match = candidates.find((c) => c.date === today && !c.archived && c.ticker === inputs.ticker && c.direction === inputs.direction);
    const p = result.ticket;
    const sendable = result.ready && result.eligible && !!p && !result.hardFails.length;
    if (match && p && match.entry === p.entry && match.stop === p.stop && match.target === p.target && match.shares === p.shares) return null;
    if (match && !sendable) return null; // the queued candidate stays as sent; the calculator is just showing something else now
    const what = `${inputs.ticker} ${inputs.direction}`;
    if (sendable) {
      return {
        tone: 'warn' as const,
        text: match
          ? `The calculator's numbers for ${what} have changed since it was sent (ranker: entry ${match.entry}, stop ${match.stop}, ${match.shares} sh · calculator: entry ${p!.entry}, stop ${p!.stop}, ${p!.shares} sh).`
          : `The calculator shows ${what} (entry ${p!.entry}), but it has not been sent to the ranker yet.`,
        action: match && ['PENDING', 'FILLED'].includes(match.status) ? null : match ? 'Update in ranker' : 'Send to Opportunity Ranker',
      };
    }
    const why = result.action === 'MARKET_LATE_ENTRY' && !result.ready
      ? 'it is a late-entry review: tick "Use current price as market entry" in the calculator first'
      : `the calculator result is ${result.headline}${result.hardFails[0] ? ` (${result.hardFails[0].reason})` : ''}`;
    return { tone: 'danger' as const, text: `The calculator shows ${what}, which cannot be sent to the ranker because ${why}.`, action: null };
  }, [result, inputs.ticker, inputs.direction, candidates, today]);

  // Any status change made through a generic patch also gets its execution revision (never downgraded).
  const patchCandidate = (id: string, patch: Partial<Candidate>) =>
    setCandidates((cs) => cs.map((c) => (c.id === id ? { ...c, ...(patch.status && patch.executionRev === undefined ? executionRevPatch(c, patch.status, Date.now()) : {}), ...patch } : c)));

  const rankerActions: RankerActions = {
    select: setSelectedId,
    score: (id, rankingInputs, alertTime) =>
      setCandidates((cs) => {
        const next = cs.map((c) => (c.id === id ? { ...c, inputs: rankingInputs, alertTime, scored: true } : c));
        const target = next.find((c) => c.id === id);
        if (target && !target.initialScore) {
          // Freeze the score at first scoring. It is never rewritten afterwards.
          const ex = exposureFor(next);
          const rc = rankCandidates(next, ex.positions, rankerSettings, today, strategy, ex.exclude).ranked.find((r) => r.candidate.id === id);
          if (rc && rc.total !== null) return next.map((c) => (c.id === id ? { ...c, initialScore: snapshotOf(rc, Date.now(), rankerSettings, strategy, version.name) } : c));
        }
        return next;
      }),
    setStatus: (id, status: LifecycleStatus) => {
      const rc = ranking.ranked.find((r) => r.candidate.id === id);
      if (!rc) return;
      if ((status === 'PENDING' || status === 'FILLED') && ['NEW', 'WATCHLIST'].includes(rc.candidate.status) && !rc.recommendation?.startsWith('TRADE')) {
        if (!confirm(`${rc.candidate.ticker} is "${rc.displayStatus}". Mark it as ${status === 'PENDING' ? 'a pending order' : 'filled'} anyway?`)) return;
      }
      const patch: Partial<Candidate> = { status, ...executionRevPatch(rc.candidate, status, Date.now()) };
      if (status === 'FILLED' && !rc.candidate.entryScore) patch.entryScore = snapshotOf(rc, Date.now(), rankerSettings, strategy, version.name);
      const terminal: LifecycleStatus[] = ['TARGET_HIT', 'STOPPED_OUT', 'MANUAL_EXIT', 'SKIPPED', 'STALE', 'CANCELED', 'EXPIRED'];
      if (terminal.includes(status) && !rc.candidate.finalScore) patch.finalScore = snapshotOf(rc, Date.now(), rankerSettings, strategy, version.name);
      patchCandidate(id, patch);
    },
    update: patchCandidate,
    keep: (sg) => setCandidates((cs) => cs.map((c) => (c.id === sg.pendingId ? { ...c, keptAgainst: [...c.keptAgainst, sg.candidateId] } : c))),
    replace: (sg) => {
      if (!confirm(`Cancel the pending ${sg.pendingTicker} order and reserve its capital for ${sg.candidateTicker}?\n\nThis only updates the ranker. You must cancel the ${sg.pendingTicker} stop order in TrendSpider/Alpaca yourself, and place the ${sg.candidateTicker} order yourself.`)) return;
      setCandidates((cs) => cs.map((c) => (c.id === sg.pendingId ? { ...c, status: 'CANCELED' } : c.id === sg.candidateId ? { ...c, status: 'PENDING', ...executionRevPatch(c, 'PENDING', Date.now()) } : c)));
      setSelectedId(sg.candidateId);
    },
    logJournal: (id) => {
      const c = candidates.find((x) => x.id === id);
      if (!c) return;
      const outcome: Outcome = c.status === 'TARGET_HIT' ? 'TARGET_HIT' : c.status === 'STOPPED_OUT' ? 'STOP_HIT' : 'MANUAL_EXIT';
      const e: JournalEntry = {
        id: newId('j'), ticker: c.ticker, date: c.date, time: c.alertTime, direction: c.direction, open: c.open, high: c.high, low: c.low, close: c.close,
        atr: c.atr, alertPrice: c.currentPrice, decision: c.calcAction, orderType: c.orderType, plannedEntry: c.entry, actualFill: c.actualFill,
        stop: c.stop, target: c.target, quantity: c.shares, positionValue: c.positionValue, expectedRisk: c.plannedRisk, expectedReward: c.expectedReward,
        outcome, exitPrice: c.exitPrice,
        notes: `Opportunity Ranker ${c.initialScore?.strategyVersion ?? c.initialScore?.scoringVersion ?? ''}: initial score ${c.initialScore?.total ?? '—'} (${c.initialScore?.tier ?? '—'})${c.entryScore ? `, entry score ${c.entryScore.total}` : ''}. ${c.notes}`.trim(),
        rulesVersion: c.rulesVersion ?? RULES_VERSION,
      };
      setJournal((j) => [...j, e]);
      alert(`${c.ticker} logged to the trade journal.`);
    },
    remove: (id) => {
      setCandidates((cs) => cs.filter((c) => c.id !== id));
      if (selectedId === id) setSelectedId(null);
    },
    archiveToday: () => setCandidates((cs) => cs.map((c) => (c.date === today && !['PENDING', 'FILLED'].includes(c.status) ? { ...c, archived: true } : c))),
    loadSample: () => {
      const hasToday = candidates.some((c) => c.date === today && !c.archived && !c.id.startsWith('sample-'));
      if (hasToday && !confirm('Add the sample day to your existing queue? (Your own candidates are kept.)')) return;
      const { candidates: sample } = sampleDay(today, previousDate(today), rankerSettings);
      setCandidates((cs) => [...cs.filter((c) => !c.id.startsWith('sample-')), ...sample]);
      setSelectedId(sample.find((c) => c.ticker === 'NVDA')?.id ?? null);
    },
    clearToday: () => {
      setCandidates((cs) => cs.filter((c) => !(c.date === today && !c.archived)));
      setSelectedId(null);
    },
    addPosition: (p) => setPositions((ps) => [...ps, p]),
    updatePosition: (id, patch) => setPositions((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p))),
    removePosition: (id) => setPositions((ps) => ps.filter((p) => p.id !== id)),
    setSettings: (rk) => void proposeSettings(settings, rk),
  };

  const liveActions: LiveActions = {
    submit: (id) => rankerActions.setStatus(id, 'PENDING'),
    skip: (id) => rankerActions.setStatus(id, 'SKIPPED'),
    watch: (id) => rankerActions.setStatus(id, 'WATCHLIST'),
    openInCalculator: (row) => {
      const i = inputsFromRecord(row.record, row.quote?.price ?? row.record.initialQuote?.price ?? 0, Date.now(), settings);
      if (!i) return;
      setForm(formFromInputs(i));
      setUseMarketEntry(false);
      setActualFill('');
      setCalculated(true);
      setTab('calc');
    },
    classify: (symbol, c) => setClasses((m) => ({ ...m, [symbol]: c })),
    reprocess: (id) => void feed.reprocess(id).catch((e) => alert((e as Error).message)),
    keep: rankerActions.keep,
    replace: rankerActions.replace,
  };
  const actionableCount = queue?.rows.filter((r) => r.decision.ticket).length ?? 0;

  const queueCount = ranking.ranked.length;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'live', label: `Live Alert Queue${actionableCount ? ` (${actionableCount})` : ''}` },
    { id: 'calc', label: 'Calculator' },
    { id: 'ranker', label: `Opportunity Ranker${queueCount ? ` (${queueCount})` : ''}` },
    { id: 'journal', label: `Journal${journal.length ? ` (${journal.length})` : ''}` },
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <div className="min-h-screen">
      <header className="z-40 border-b lg:sticky lg:top-0 border-ink-700 bg-ink-900/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <h1 className="text-[15px] font-bold tracking-tight text-ink-100 sm:text-lg">RB v1 Trade Execution Calculator</h1>
            <p className="truncate text-xs text-ink-400">
              {tab === 'ranker' ? 'Valid Setup → Quality Score → Portfolio Fit → Trade / Watch / Skip' : 'TrendSpider Alert → Entry → Stop → Target → Position Size'}
            </p>
            <p className="text-[10px] uppercase tracking-wider text-ink-500">
              Strategy: <span className={versionControls.frozen ? 'text-[#a9c1ff]' : 'text-warn'}>{versionControls.label}</span> · calculation code: {RULES_VERSION} / {SCORING_VERSION}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full border border-warn/50 bg-warn-dim/40 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-warn">Paper trading mode</span>
            <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${autoCfg.enabled ? 'border-long/50 text-long' : 'border-ink-600 text-ink-400'}`}>
              Automated alerts {autoCfg.enabled ? 'on' : 'off'}
            </span>
            <LogoutButton />
          </div>
          <nav className="flex w-full gap-1 overflow-x-auto sm:w-auto" aria-label="Sections">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? 'page' : undefined}
                className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ${tab === t.id ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-100'}`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] px-4 py-4">
        {tab === 'calc' && (
          <div className="grid gap-4 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)] xl:grid-cols-[minmax(300px,360px)_minmax(0,1fr)_minmax(300px,360px)]">
            <InputPanel
              form={form}
              setField={setField}
              errors={result?.errors ?? []}
              showErrors={calculated}
              onCalculate={calculate}
              onClear={clear}
              onLoadScenario={loadScenario}
              timeframeMinutes={settings.timeframeMinutes}
            />
            <div ref={decisionRef} className="scroll-mt-4 lg:scroll-mt-28">
              <DecisionPanel
                result={result}
                inputs={inputs}
                settings={settings}
                useMarketEntry={useMarketEntry}
                setUseMarketEntry={setUseMarketEntry}
                actualFill={actualFill}
                setActualFill={setActualFill}
                onSave={saveToJournal}
                savedFlash={savedFlash}
                onSendToRanker={sendToRanker}
              />
            </div>
            <div className="lg:col-span-2 xl:col-span-1">
              <RiskPanel result={result} atr={inputs.atr} investment={inputs.investmentAmount} useMarketEntry={useMarketEntry} />
            </div>
          </div>
        )}
        {tab === 'live' && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-1">
              {([['queue', 'Queue'], ['parity', `Data validation (${paritySum.status.toLowerCase()})`], ['historical', 'Historical SIP Test'], ['automation', 'Automation settings']] as const).map(([id, label]) => (
                <button key={id} type="button" onClick={() => setLiveSub(id)} className={`rounded-md px-3 py-1.5 text-sm ${liveSub === id ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-100'}`}>{label}</button>
              ))}
            </div>
            {liveSub === 'queue' && (
              <LiveQueuePage
                rows={queue?.rows ?? []}
                suggestions={queue?.suggestions ?? []}
                now={clock}
                enabled={autoCfg.enabled && !!autoToken}
                feed={feed}
                quoteError={quoteError}
                parityStatus={paritySum.status}
                versionLabel={versionControls.label}
                actions={liveActions}
                onOpenSettings={() => setLiveSub('automation')}
                shadow={{ maxScore: v12MaxScore(rankerSettings), optionAGrades: rankerSettings.grades, logCount: Object.keys(shadowLog).length, onExportLog: exportShadowLog }}
                broker={brokerFeed}
                exposure={queue?.exposure}
                verification={verification}
                brokerTrades={brokerTrades}
                history={{ count: Object.keys(alertSnaps).length, onExport: () => download(`rb-alert-history-${autoDate}.csv`, alertSnapshotsCsv(alertSnaps), 'text/csv') }}
                pollMs={autoCfg.pollMs}
              />
            )}
            {liveSub === 'parity' && (
              <ParityView records={feed.records} entries={parityEntries} setEntry={(e) => setParityEntries((m) => ({ ...m, [e.recordId]: e }))} tol={autoCfg.parity} summary={paritySum} rowsById={parityRows} />
            )}
            {liveSub === 'historical' && <HistoricalSipTest token={autoToken} tol={autoCfg.parity} />}
            {liveSub === 'automation' && <AutomationSettings cfg={autoCfg} setCfg={setAutoCfg} token={autoToken} setToken={setAutoToken} classes={classes} setClasses={setClasses} />}
          </div>
        )}
        {tab === 'ranker' && calcSync && (
          <div
            role="status"
            className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${calcSync.tone === 'warn' ? 'border-warn/60 bg-warn-dim/30 text-[#ffe2a8]' : 'border-short/50 bg-short-dim/30 text-[#ffc2cd]'}`}
          >
            <span>
              <b className="uppercase tracking-wider">Calculator not in ranker:</b> {calcSync.text}
            </span>
            {calcSync.action ? (
              <button type="button" onClick={sendToRanker} className="rounded-lg border-2 border-[#5b8cff] bg-[#13213f] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[#bcd0ff] hover:bg-[#1a2c55]">
                {calcSync.action} →
              </button>
            ) : (
              <button type="button" onClick={() => setTab('calc')} className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-semibold text-ink-200 hover:bg-ink-700">
                Back to calculator
              </button>
            )}
          </div>
        )}
        {tab === 'ranker' && (
          <RankerPage
            result={ranking}
            candidates={candidates}
            positions={positions}
            settings={rankerSettings}
            version={versionControls}
            settingsEpoch={settingsEpoch}
            selectedId={selectedId ?? ranking.ranked[0]?.candidate.id ?? null}
            today={today}
            actions={rankerActions}
            verification={verification}
            executions={executions}
          />
        )}
        {tab === 'journal' && (
          <JournalView
            cr15={serverFlags.cr15 === true ? (
              <Cr15Panel
                mode={cr15Mode} setMode={setCr15Mode} plan={cr15Plan} journal={journal} feed={cr15Feed} request={cr15Req} backup={cr15Backup} message={cr15Message}
                onApply={() => applyCr15(true)} onRestore={restoreCr15}
                onDownloadBackup={() => cr15Backup && download(`rb-v1-journal-pre-cr15-${cr15Backup.createdIso.slice(0, 10)}.json`, JSON.stringify(JSON.parse(cr15Backup.journalJson), null, 2), 'application/json')}
              />
            ) : undefined}
            entries={journal}
            update={(id, patch) => setJournal((j) => j.map((e) => (e.id === id ? { ...e, ...patch } : e)))}
            remove={(id) => setJournal((j) => j.filter((e) => e.id !== id))}
            replaceAll={setJournal}
          />
        )}
        {tab === 'dashboard' && <Dashboard entries={journal} failLabels={HARD_FAIL_LABELS} />}
        {tab === 'settings' && (
          <div className="mx-auto max-w-3xl space-y-4">
            <StrategyVersionBar v={versionControls} />
            <SettingsPanel key={settingsEpoch} settings={settings} locked={version.locked} onSave={(rb) => proposeSettings(rb, rankerSettings)} />
          </div>
        )}
      </main>

      <footer className="mx-auto max-w-[1500px] px-4 pb-8 pt-2 text-[11px] leading-relaxed text-ink-500">
        Calculations and scores are planning tools, not predictions. A high score does not mean a trade will win. Stop orders may fill at prices different
        from the trigger. Paper-trading fills may differ from live-market execution. This app sends nothing to any broker.
      </footer>
    </div>
  );
}
