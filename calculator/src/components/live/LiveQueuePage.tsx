import type { AlertSnapshotMap } from '../../engine/automation/lifecycle/alertTimeSnapshot';
import { useState } from 'react';
import { ticketString, type FreshnessBand, type TrendSpiderTicket } from '../../engine/automation/alertDecision';
import type { QueueOutput, QueueRow } from '../../engine/automation/liveQueue';
import type { Classification } from '../../engine/automation/autoCandidate';
import { fmtEt, mmss } from '../../engine/automation/etTime';
const etTime = (ms: number) => fmtEt(ms).replace(' ET', '');
import type { ReplacementSuggestion } from '../../engine/ranker/candidateRanker';
import { ACTIVE_LOGIC_VERSION } from '../../engine/automation/v12/dispatch';
import type { Grades } from '../../engine/automation/v12/v12Thresholds';
import { usd } from '../../lib/format';
import { retentionState } from '../../engine/automation/lifecycle/alertTimeSnapshot';
import { BrokerSyncPanel } from './BrokerSync';
import { eodStatus, withBrokerFacts } from '../../engine/automation/lifecycle/executionState';
import { brokerEodFacts, type TradeSync } from '../../engine/automation/lifecycle/brokerSync';
import type { PortfolioVerification } from '../../engine/automation/lifecycle/portfolioExposure';
import { PortfolioVerificationBanner } from '../PortfolioVerificationBanner';
import type { BrokerFeed } from '../../lib/automationClient';
import { Panel } from '../ui';
import { SuggestionCard } from '../ranker/FitPanel';
import { QueueHeader, QueueLegend, QueueTable, QueueToolbar, type ColumnGroups, type QueueFilter } from './QueueParts';
import { isDataReview, presentationFor, queueLayout, type PresentationConfig } from './queueView';

export interface LiveActions {
  submit: (id: string) => void;
  skip: (id: string) => void;
  watch: (id: string) => void;
  openInCalculator: (row: QueueRow) => void;
  classify: (symbol: string, c: Classification) => void;
  reprocess: (id: string) => void;
  keep: (sg: ReplacementSuggestion) => void;
  replace: (sg: ReplacementSuggestion) => void;
}

interface Props {
  rows: QueueRow[];
  suggestions: ReplacementSuggestion[];
  now: number;
  enabled: boolean;
  feed: { lastOkMs: number | null; error: string | null };
  quoteError: string | null;
  parityStatus: string;
  versionLabel: string;
  actions: LiveActions;
  onOpenSettings: () => void;
  /** RB v1.2 SHADOW display (comparison only). */
  shadow: { maxScore: number; optionAGrades: Grades; logCount: number; onExportLog: () => void };
  /** Strategy columns (presentation only). Defaults to the layout for ACTIVE_LOGIC_VERSION. */
  presentation?: PresentationConfig;
  /** Alert poll interval (Automation settings) — shown in the Auto Refresh indicator. */
  pollMs?: number;
  /** CR-11 — retained alert-time snapshot history (90 days) and its CSV export. */
  history?: { count: number; onExport: () => void };
  /** Write-once alert-time snapshots (read only; shown as the original recorded assessment). */
  alertSnapshots?: AlertSnapshotMap;
  /** CR-12 — read-only broker feed (paper account), when enabled on the server. */
  broker?: BrokerFeed;
  /** Shared read-only reconciliation result (the same one the Journal sync uses); null when the feed is not live. */
  brokerTrades?: TradeSync[] | null;
  /** Broker-verified portfolio exposure adjustments (capacity released for confirmed closes / added for unrecorded positions). */
  exposure?: QueueOutput['exposure'];
  /** Broker portfolio verification state (warning + ticket gate). */
  verification?: PortfolioVerification;
}

const bandTone: Record<FreshnessBand, string> = { FRESH: 'text-long', AGING: 'text-warn', URGENT: 'text-[#ff9f5a]', STALE: 'text-short' };
const p = (x: number | null | undefined, dp = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(x < 1 ? 4 : dp));

const ENTRY_FLAG_LABELS: Record<string, string> = {
  EXCEEDS_SINGLE_POSITION_LIMIT: 'exceeds the RB single-position limit',
  EXCEEDS_PER_TRADE_RISK: 'exceeds the RB per-trade risk limit',
  RISK_ESTIMATED: 'no verified bracket stop — risk estimated at the per-trade limit',
  NOTIONAL_ESTIMATED: 'order price or quantity unknown — notional estimated',
  EXCEEDS_POSITION: 'quantity beyond the open position',
  SAME_TICKER_RB_CANDIDATE: 'an RB candidate in this ticker does not match it',
};

/** One broker-only working entry, as shown in the exposure note. */
export function entryNote(e: NonNullable<Props['exposure']>['entries'][number], source: NonNullable<Props['exposure']>['entriesSource']): string {
  const usd = (x: number) => `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const flags = e.flags.map((f) => ENTRY_FLAG_LABELS[f] ?? f);
  return `${e.ticker} broker-only working ${e.direction} entry (${e.qty.toLocaleString('en-US')} sh, ${usd(e.notional)} potential) not in RB — reserved, ${usd(e.plannedRisk)} risk${e.riskBasis === 'BRACKET_STOP' ? ' to its bracket stop' : ' (estimate)'}`
    + (flags.length ? ` · ⚠ ${flags.join(' · ')}` : '')
    + (source === 'LAST_KNOWN' ? ' · kept from the last verified broker response (broker data unavailable)' : '');
}

export function LiveQueuePage({ rows: allRows, suggestions, now, enabled, feed, quoteError, parityStatus, versionLabel, actions, onOpenSettings, shadow, presentation, pollMs, history, broker, brokerTrades, exposure, verification, alertSnapshots }: Props) {
  // CR-11 — archived alerts (previous session / ≥ 12 h) leave the queue; they stay in history and exports.
  const rows = allRows.filter((r) => retentionState(r.record.alert.alertTimeMs, now) !== 'ARCHIVED');
  const layout = queueLayout(presentation ?? presentationFor(ACTIVE_LOGIC_VERSION), { v12MaxScore: shadow.maxScore });
  const [filter, setFilter] = useState<QueueFilter>('ALL');
  const [cols, setCols] = useState<ColumnGroups>({ shadow: true, trade: true, safety: true });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const stronger = suggestions.filter((s) => s.kind === 'STRONGER');
  // Tickets the execution layer withholds (15:30 cutoff, terminal SETUP FAILED) are never shown as orders to place.
  const actionable = rows.filter((r) => r.decision.ticket && !r.lifecycle?.entryWindowClosed && !r.lifecycle?.setupFailed && !r.lifecycle?.portfolioUnverified && !r.lifecycle?.chaseLatched && !r.lifecycle?.observationWithheld);
  // CR-13 — v1.1 tickets past the 15:30 entry cutoff: shown as historical, never as an order to place.
  const cutoff = rows.filter((r) => r.lifecycle?.entryWindowClosed);
  if (!enabled) {
    return (
      <Panel title="Live Alert Queue">
        <p className="text-sm text-ink-300">
          Automated Alert Mode is <b>OFF</b>. The manual Calculator and Opportunity Ranker work exactly as before. Turn automation on in{' '}
          <button type="button" className="font-semibold text-[#9db8ff] underline" onClick={onOpenSettings}>Automation settings</button> after completing the setup in <code>AUTOMATION.md</code>.
        </p>
      </Panel>
    );
  }
  const shown = rows.filter((r) => filter === 'ALL' || (filter === 'DATA_REVIEW' ? isDataReview(r) : r.record.alert.direction === filter));
  const feedText = feed.error ? feed.error : feed.lastOkMs ? `updated ${Math.max(0, Math.round((now - feed.lastOkMs) / 1000))} s ago` : 'connecting…';
  const allOpen = shown.length > 0 && shown.every((r) => open.has(r.record.id));
  // CR-13 — portfolio-level EOD check: RB lifecycle + manual positions (from the queue) plus, when the read-only broker
  // feed is live, the broker's open positions and unfilled orders. Shown even when the queue is empty. Flag only.
  const eodBase = rows[0]?.lifecycle?.eod ?? eodStatus(now, [], []);
  const eod = broker?.status === 'LIVE' ? withBrokerFacts(eodBase, now, brokerEodFacts(broker)) : eodBase;
  return (
    <div className="space-y-4">
      <QueueHeader layout={layout} rows={rows} versionLabel={versionLabel} />
      <QueueToolbar
        rows={rows} filter={filter} setFilter={setFilter} feedText={feedText} feedOk={!feed.error && !!feed.lastOkMs} pollSec={pollMs ? Math.round(pollMs / 1000) : null}
        cols={cols} setCols={setCols} allOpen={allOpen} toggleAll={() => setOpen(allOpen ? new Set() : new Set(shown.map((r) => r.record.id)))}
        hasShadow={layout.some((c) => c.role === 'SHADOW')} logCount={shadow.logCount} onExport={shadow.onExportLog}
      />
      {quoteError && <p className="text-sm text-short">Prices: {quoteError}</p>}
      <PortfolioVerificationBanner v={verification} />
      {exposure && (exposure.released.length > 0 || exposure.added.length > 0 || exposure.entries.length > 0 || exposure.brokerPositions.length > 0) && (
        <p className="rounded-lg border border-ink-600 bg-ink-850 px-4 py-2 text-[12.5px] text-ink-200" data-section="exposure">
          <b>Portfolio reconciled with Alpaca PAPER (read-only):</b>{' '}
          {[
            ...exposure.released.map((x) => `${x.ticker} ${x.status} not reserving — ${x.reason}`),
            ...exposure.added.map((x) => `${x.ticker} broker position (${x.qty}) not in RB — counted conservatively ($${x.plannedRisk} risk)`),
            ...(exposure.entriesSource === 'LAST_KNOWN' ? exposure.brokerPositions.map((x) => `${x.ticker} broker position (${x.qty}) not in RB — kept from the last verified broker response ($${x.plannedRisk} risk)`) : []),
            ...exposure.entries.map((e) => entryNote(e, exposure.entriesSource)),
          ].join('; ')}
          . Records are unchanged; update the candidate in the Opportunity Ranker when convenient.
        </p>
      )}
      {eod && eod.phase !== 'OPEN' && (
        <p role="status" className={`rounded-lg border px-4 py-2 text-[13px] font-semibold ${eod.actionRequired ? 'border-short bg-short-dim/30 text-[#ffc0c8]' : 'border-warn/40 bg-warn-dim/20 text-[#ffe2a8]'}`}>
          {eod.phase}: {eod.message}{eod.openTickers.length || eod.pendingTickers.length ? ` (${[...eod.openTickers.map((t) => `${t} open`), ...eod.pendingTickers.map((t) => `${t} pending`)].join(', ')})` : ''} <span className="font-normal">Flag only — RB never places, cancels or closes broker orders.</span>
        </p>
      )}

      {rows.length > 0 ? (
        <QueueTable rows={shown} now={now} actions={actions} layout={layout} maxScore={shadow.maxScore} optionAGrades={shadow.optionAGrades} cols={cols} open={open} setOpen={setOpen} snapshots={alertSnapshots} />
      ) : (
        <Panel title="No alerts yet today">
          <p className="text-sm text-ink-400">Waiting for TrendSpider webhooks. A test alert can be sent as described in AUTOMATION.md.</p>
        </Panel>
      )}

      <QueueLegend grades={shadow.optionAGrades} rows={rows} layout={layout} />
      {history && (
        <p className="text-[12px] text-ink-400">
          History: {history.count} frozen alert snapshot(s) retained (90 days; server records are never deleted).{' '}
          <button type="button" onClick={history.onExport} disabled={!history.count} className="font-semibold text-[#9db8ff] underline disabled:opacity-40">Export history CSV</button>
        </p>
      )}

      {parityStatus !== 'VALIDATED' && (
        <p className="rounded-lg border border-warn/40 bg-warn-dim/20 px-4 py-2 text-[13px] text-[#ffe2a8]">
          <b>Data parity: {parityStatus}.</b> Until 20+ alerts have been compared with TrendSpider (Data validation tab) with no mismatch, check every value against your chart before submitting.
        </p>
      )}

      <BrokerSyncPanel rows={allRows} feed={broker} now={now} liveTrades={brokerTrades} />

      {stronger.length > 0 && <div className="grid gap-3 lg:grid-cols-2">{stronger.map((sg) => <SuggestionCard key={`${sg.pendingId}-${sg.candidateId}`} sg={sg} onKeep={actions.keep} onReplace={actions.replace} />)}</div>}

      {cutoff.length > 0 && (
        <div className="space-y-2" data-section="entry-cutoff">
          <h3 className="rounded-lg bg-short px-3 py-2 text-[15px] font-black uppercase tracking-wide text-ink-950">
            NO TICKET — ENTRY WINDOW CLOSED · DO NOT EXECUTE — AFTER 3:30 PM ENTRY CUTOFF
          </h3>
          <p className="text-[12px] text-ink-300">These alerts arrived before 15:30 ET. Any ticket they carried is historical and must not be placed now.</p>
          <ul className="space-y-1">
            {cutoff.map((r) => (
              <li key={r.record.id} className="rounded-lg border-2 border-short bg-short-dim/20 px-3 py-2 text-[13px] text-ink-100" data-cutoff-row={r.record.alert.symbol}>
                <b>{r.record.alert.symbol}</b> {r.record.alert.direction} · alert {etTime(r.record.alert.alertTimeMs)} ET
                {r.candidate ? <span className="text-ink-400 line-through"> · historical {r.record.alert.direction === 'LONG' ? 'BUY' : 'SELL'} STOP {r.candidate.shares} @ {p(r.candidate.entry)}</span> : null}
                <b className="ml-2 text-short">DO NOT EXECUTE</b>
              </li>
            ))}
            {cutoff.filter((r) => r.decision.ticket).map((r) => <li key={`${r.record.id}-card`}><ActionCard r={r} actions={actions} /></li>)}
          </ul>
        </div>
      )}

      {actionable.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-300">Trade tickets — {layout.find((c) => c.role === 'ACTIVE')?.version ?? 'active'} (manual execution)</h3>
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {actionable.map((r) => <ActionCard key={r.record.id} r={r} actions={actions} />)}
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── large actionable card ───────────────────────── */

function ActionCard({ r, actions }: { r: QueueRow; actions: LiveActions }) {
  const t = r.decision.ticket as TrendSpiderTicket;
  const [copied, setCopied] = useState(false);
  const fr = r.decision.freshness;
  const closed = !!r.lifecycle?.entryWindowClosed;
  const elite = r.decision.section === 'ACTION_NOW' && !closed;
  const L = r.record.alert.direction === 'LONG';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ticketString(t));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy the TrendSpider order:', ticketString(t));
    }
  };
  return (
    <section className={`rounded-xl border-2 p-4 ${closed ? 'border-short bg-short-dim/20' : elite ? 'border-long bg-long-dim/20' : 'border-[#5b8cff] bg-[#13213f]/60'}`} aria-label={`${r.record.alert.symbol} ${closed ? 'historical ticket — do not execute' : 'trade ticket'}`} data-cutoff={closed || undefined}>
      {closed && <div className="mb-3 rounded-lg bg-short px-3 py-2 text-center text-[16px] font-black uppercase tracking-wide text-ink-950">DO NOT EXECUTE — AFTER 3:30 PM ENTRY CUTOFF</div>}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-2xl font-black tracking-tight text-ink-100">
            {r.record.alert.symbol} <span className={L ? 'text-long' : 'text-short'}>— {r.record.alert.direction}</span>
          </div>
          <div className={`text-sm font-bold uppercase tracking-wider ${elite ? 'text-long' : 'text-[#9db8ff]'}`}>
            Score {r.ranked?.total} · {r.decision.decision} · rank #{r.ranked?.rank}
          </div>
        </div>
        <div className={`text-right ${bandTone[fr.band]}`}>
          <div className="num text-2xl font-black">{mmss(fr.remainingMs)}</div>
          <div className="text-[10px] font-bold uppercase tracking-wider">{fr.band} · age {mmss(fr.ageMs)}</div>
        </div>
      </div>
      <div className={`mt-3 rounded-lg border border-ink-600 bg-ink-950 p-3 ${closed ? 'opacity-50 line-through' : ''}`}>
        <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.18em] text-ink-300">{closed ? 'RB v1.1 ticket — historical, not an order' : 'TrendSpider order'}</div>
        <dl className="num grid grid-cols-2 gap-x-4 gap-y-1 text-lg">
          <Field k="Action" v={t.action} tone={t.action === 'BUY' ? 'text-long' : 'text-short'} />
          <Field k="Order type" v={t.orderType} />
          <Field k="Quantity" v={String(t.quantity)} />
          <Field k="Price" v={`$${p(t.price)}`} />
          <Field k="Stop Loss" v={`$${p(t.stopLoss)}`} tone="text-short" />
          <Field k="Take Profit" v={`$${p(t.takeProfit)}`} tone="text-long" />
        </dl>
      </div>
      <div className="mt-2 text-xs text-ink-400">
        Planned risk {usd(r.candidate?.plannedRisk ?? 0)} (a stop can fill worse — not a guaranteed maximum loss) · position {usd(r.candidate?.positionValue ?? 0, 0)} · current {p(r.quote?.price)}
      </div>
      {r.lifecycle && r.lifecycle.finalActionability !== 'READY' && <p className="mt-2 rounded bg-short-dim/40 px-2 py-1 text-xs font-bold text-[#ffc0c8]">{r.lifecycle.finalActionability}: {r.lifecycle.reason}</p>}
      <p className="mt-2 rounded bg-warn-dim/40 px-2 py-1 text-xs font-semibold text-[#ffe2a8]">Manual execution only. Verify the TrendSpider ticket before submitting. Nothing has been placed.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {!closed && <button type="button" onClick={copy} className="rounded-lg border-2 border-[#5b8cff] px-3 py-2 text-xs font-bold uppercase tracking-wider text-[#bcd0ff] hover:bg-[#1a2c55]">
          {copied ? '✓ Copied' : 'Copy TrendSpider order'}
        </button>}
        {!closed && <button type="button" onClick={() => actions.submit(r.record.id)} className="rounded-lg bg-long px-3 py-2 text-xs font-bold uppercase tracking-wider text-ink-950 hover:brightness-110">Mark order submitted</button>}
        <button type="button" onClick={() => actions.watch(r.record.id)} className="rounded-lg border border-ink-600 px-3 py-2 text-xs font-semibold text-ink-200 hover:bg-ink-700">Watch</button>
        <button type="button" onClick={() => actions.skip(r.record.id)} className="rounded-lg border border-ink-600 px-3 py-2 text-xs font-semibold text-ink-300 hover:bg-short-dim hover:text-short">Skip trade</button>
      </div>
    </section>
  );
}

const Field = ({ k, v, tone = 'text-ink-100' }: { k: string; v: string; tone?: string }) => (
  <>
    <dt className="font-sans text-sm text-ink-400">{k}</dt>
    <dd className={`text-right font-bold ${tone}`}>{v}</dd>
  </>
);
