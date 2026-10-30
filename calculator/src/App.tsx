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
import { KEYS, load, save } from './lib/storage';
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
import { buildQueue } from './engine/automation/liveQueue';
import { inputsFromRecord } from './engine/automation/autoCandidate';
import { compareParity, mismatchMessages, paritySummary, type ParityEntry, type ParityRow } from './engine/automation/parity';
import { etParts } from './engine/automation/etTime';
import { AUTO_KEYS, initialClassifications, loadAutomationConfig, loadParity, useAlertRecords, useLiveQuotes, usePersistent, type ClassMap } from './lib/automationClient';
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
type LiveSub = 'queue' | 'parity' | 'automation';

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
  const ranking = useMemo(() => rankCandidates(candidates, positions, rankerSettings, today, strategy), [candidates, positions, rankerSettings, today, strategy]);

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
    });
  }, [autoCfg, feed.records, candidates, positions, quotes, clock, settings, rankerSettings, classes, parityRows, version.name]);
  useEffect(() => {
    if (queue?.changed) setCandidates(queue.candidates);
  }, [queue]);

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

  const patchCandidate = (id: string, patch: Partial<Candidate>) => setCandidates((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const rankerActions: RankerActions = {
    select: setSelectedId,
    score: (id, rankingInputs, alertTime) =>
      setCandidates((cs) => {
        const next = cs.map((c) => (c.id === id ? { ...c, inputs: rankingInputs, alertTime, scored: true } : c));
        const target = next.find((c) => c.id === id);
        if (target && !target.initialScore) {
          // Freeze the score at first scoring. It is never rewritten afterwards.
          const rc = rankCandidates(next, positions, rankerSettings, today, strategy).ranked.find((r) => r.candidate.id === id);
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
      const patch: Partial<Candidate> = { status };
      if (status === 'FILLED' && !rc.candidate.entryScore) patch.entryScore = snapshotOf(rc, Date.now(), rankerSettings, strategy, version.name);
      const terminal: LifecycleStatus[] = ['TARGET_HIT', 'STOPPED_OUT', 'MANUAL_EXIT', 'SKIPPED', 'STALE', 'CANCELED', 'EXPIRED'];
      if (terminal.includes(status) && !rc.candidate.finalScore) patch.finalScore = snapshotOf(rc, Date.now(), rankerSettings, strategy, version.name);
      patchCandidate(id, patch);
    },
    update: patchCandidate,
    keep: (sg) => setCandidates((cs) => cs.map((c) => (c.id === sg.pendingId ? { ...c, keptAgainst: [...c.keptAgainst, sg.candidateId] } : c))),
    replace: (sg) => {
      if (!confirm(`Cancel the pending ${sg.pendingTicker} order and reserve its capital for ${sg.candidateTicker}?\n\nThis only updates the ranker. You must cancel the ${sg.pendingTicker} stop order in TrendSpider/Alpaca yourself, and place the ${sg.candidateTicker} order yourself.`)) return;
      setCandidates((cs) => cs.map((c) => (c.id === sg.pendingId ? { ...c, status: 'CANCELED' } : c.id === sg.candidateId ? { ...c, status: 'PENDING' } : c)));
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
              {([['queue', 'Queue'], ['parity', `Data validation (${paritySum.status.toLowerCase()})`], ['automation', 'Automation settings']] as const).map(([id, label]) => (
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
              />
            )}
            {liveSub === 'parity' && (
              <ParityView records={feed.records} entries={parityEntries} setEntry={(e) => setParityEntries((m) => ({ ...m, [e.recordId]: e }))} tol={autoCfg.parity} summary={paritySum} rowsById={parityRows} />
            )}
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
          />
        )}
        {tab === 'journal' && (
          <JournalView
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
