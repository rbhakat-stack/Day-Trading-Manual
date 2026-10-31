import { useState } from 'react';
import { ticketString, type FreshnessBand, type TrendSpiderTicket } from '../../engine/automation/alertDecision';
import type { QueueRow } from '../../engine/automation/liveQueue';
import type { Classification } from '../../engine/automation/autoCandidate';
import { mmss } from '../../engine/automation/etTime';
import type { ReplacementSuggestion } from '../../engine/ranker/candidateRanker';
import { ACTIVE_LOGIC_VERSION } from '../../engine/automation/v12/dispatch';
import type { Grades } from '../../engine/automation/v12/v12Thresholds';
import { usd } from '../../lib/format';
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
}

const bandTone: Record<FreshnessBand, string> = { FRESH: 'text-long', AGING: 'text-warn', URGENT: 'text-[#ff9f5a]', STALE: 'text-short' };
const p = (x: number | null | undefined, dp = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(x < 1 ? 4 : dp));

export function LiveQueuePage({ rows, suggestions, now, enabled, feed, quoteError, parityStatus, versionLabel, actions, onOpenSettings, shadow, presentation, pollMs }: Props) {
  const layout = queueLayout(presentation ?? presentationFor(ACTIVE_LOGIC_VERSION), { v12MaxScore: shadow.maxScore });
  const [filter, setFilter] = useState<QueueFilter>('ALL');
  const [cols, setCols] = useState<ColumnGroups>({ shadow: true, trade: true, safety: true });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const stronger = suggestions.filter((s) => s.kind === 'STRONGER');
  const actionable = rows.filter((r) => r.decision.ticket);
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
  return (
    <div className="space-y-4">
      <QueueHeader layout={layout} rows={rows} versionLabel={versionLabel} />
      <QueueToolbar
        rows={rows} filter={filter} setFilter={setFilter} feedText={feedText} feedOk={!feed.error && !!feed.lastOkMs} pollSec={pollMs ? Math.round(pollMs / 1000) : null}
        cols={cols} setCols={setCols} allOpen={allOpen} toggleAll={() => setOpen(allOpen ? new Set() : new Set(shown.map((r) => r.record.id)))}
        hasShadow={layout.some((c) => c.role === 'SHADOW')} logCount={shadow.logCount} onExport={shadow.onExportLog}
      />
      {quoteError && <p className="text-sm text-short">Prices: {quoteError}</p>}

      {rows.length > 0 ? (
        <QueueTable rows={shown} now={now} actions={actions} layout={layout} maxScore={shadow.maxScore} optionAGrades={shadow.optionAGrades} cols={cols} open={open} setOpen={setOpen} />
      ) : (
        <Panel title="No alerts yet today">
          <p className="text-sm text-ink-400">Waiting for TrendSpider webhooks. A test alert can be sent as described in AUTOMATION.md.</p>
        </Panel>
      )}

      <QueueLegend grades={shadow.optionAGrades} rows={rows} layout={layout} />

      {parityStatus !== 'VALIDATED' && (
        <p className="rounded-lg border border-warn/40 bg-warn-dim/20 px-4 py-2 text-[13px] text-[#ffe2a8]">
          <b>Data parity: {parityStatus}.</b> Until 20+ alerts have been compared with TrendSpider (Data validation tab) with no mismatch, check every value against your chart before submitting.
        </p>
      )}

      {stronger.length > 0 && <div className="grid gap-3 lg:grid-cols-2">{stronger.map((sg) => <SuggestionCard key={`${sg.pendingId}-${sg.candidateId}`} sg={sg} onKeep={actions.keep} onReplace={actions.replace} />)}</div>}

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
  const elite = r.decision.section === 'ACTION_NOW';
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
    <section className={`rounded-xl border-2 p-4 ${elite ? 'border-long bg-long-dim/20' : 'border-[#5b8cff] bg-[#13213f]/60'}`} aria-label={`${r.record.alert.symbol} trade ticket`}>
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
      <div className="mt-3 rounded-lg border border-ink-600 bg-ink-950 p-3">
        <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.18em] text-ink-300">TrendSpider order</div>
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
      <p className="mt-2 rounded bg-warn-dim/40 px-2 py-1 text-xs font-semibold text-[#ffe2a8]">Manual execution only. Verify the TrendSpider ticket before submitting. Nothing has been placed.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={copy} className="rounded-lg border-2 border-[#5b8cff] px-3 py-2 text-xs font-bold uppercase tracking-wider text-[#bcd0ff] hover:bg-[#1a2c55]">
          {copied ? '✓ Copied' : 'Copy TrendSpider order'}
        </button>
        <button type="button" onClick={() => actions.submit(r.record.id)} className="rounded-lg bg-long px-3 py-2 text-xs font-bold uppercase tracking-wider text-ink-950 hover:brightness-110">Mark order submitted</button>
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
