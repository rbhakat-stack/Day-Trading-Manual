/**
 * Live Alert Queue header, toolbar, table, expanded row and legend (display only). Values come from the presentation
 * model (queueView.ts), which reads existing engine output; no control here can act on a non-active strategy —
 * tickets and actions come from the ACTIVE decision (`row.decision`) only.
 */
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import type { QueueRow } from '../../engine/automation/liveQueue';
import { fmtEt } from '../../engine/automation/etTime';
import { TRUSTED_RULE_SETS } from '../../engine/automation/v12/ruleSets';
import { V12_SHADOW_GRADES, type Grades } from '../../engine/automation/v12/v12Thresholds';
import type { QualityTier } from '../../engine/ranker/opportunityTypes';
import { FIT_KEYS, SETUP_KEYS } from '../../engine/ranker/opportunityTypes';
import { usd } from '../../lib/format';
import {
  chaseStatus, dataStatus, decisionBadge, detailFields, finalBadge, finalState, isDataReview, portfolioStatus, portfolioSummary, qualificationStatus,
  ruleSetText, scoreTone, TIER_SHORT, TIER_TONE, type Status, type StrategyColumn, type Tone,
} from './queueView';
import type { LiveActions } from './LiveQueuePage';
import { ShadowPanel } from './ShadowV12';

/* ───────────────────────── badges ───────────────────────── */

const FILL: Record<Tone, string> = {
  ok: 'border-[#1f7a4f] bg-[#123d2a] text-[#3ee08f]',
  warn: 'border-[#7a5d16] bg-[#3a2d0c] text-[#ffc542]',
  bad: 'border-[#c2384c] bg-[#a3263a] text-white',
  info: 'border-[#2f5fb8] bg-[#173468] text-[#cfe0ff]',
  shadow: 'border-[#6a46b8] bg-[#3b2470] text-[#e3d4ff]',
  elite: 'border-[#7d52d9] bg-[#4b2a8a] text-[#ecdfff]',
  muted: 'border-ink-600 bg-ink-700 text-ink-200',
};

export const Pill = ({ s, title, wide }: { s: Pick<Status, 'label' | 'tone'>; title?: string; wide?: boolean }) => (
  <span title={title} className={`inline-block whitespace-nowrap rounded-md border px-1.5 py-0.5 text-center text-[11px] font-bold uppercase leading-snug tracking-wide ${wide ? 'min-w-[84px]' : 'min-w-[40px]'} ${FILL[s.tone]}`}>{s.label}</span>
);

const TierPill = ({ t }: { t: QualityTier | null }) => (t ? <Pill s={{ label: TIER_SHORT[t], tone: TIER_TONE[t] }} /> : <span className="text-ink-500">—</span>);
const SidePill = ({ side }: { side: 'LONG' | 'SHORT' }) => <Pill s={{ label: side, tone: side === 'LONG' ? 'ok' : 'bad' }} />;
const SCORE_TEXT: Record<Tone, string> = { ok: 'text-[#3ee08f]', elite: 'text-[#3ee08f]', info: 'text-[#3ee08f]', shadow: 'text-[#ffc542]', warn: 'text-[#ffc542]', muted: 'text-[#ff6b7f]', bad: 'text-[#ff6b7f]' };
const TONE_TEXT: Record<Tone, string> = { ok: 'text-[#3ee08f]', warn: 'text-[#ffc542]', bad: 'text-[#ff6b7f]', info: 'text-[#9db8ff]', shadow: 'text-[#d9c8ff]', elite: 'text-[#d9c8ff]', muted: 'text-ink-200' };

const p = (x: number | null | undefined, dp = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(x < 1 ? 4 : dp));
const money = (x: number | null | undefined, dp = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : usd(x, dp));
const qualText = (q: Status) => (q.label === 'QUALIFIED' ? 'YES' : q.label === '—' ? '—' : 'NO');

/* ───────────────────────── header ───────────────────────── */

export function QueueHeader({ layout, rows, versionLabel }: { layout: StrategyColumn[]; rows: QueueRow[]; versionLabel: string }) {
  const rs = TRUSTED_RULE_SETS.filter((r) => r.active).map((r) => r.id);
  const flow = layout.map((c) => `${c.version} (${c.role})`).join(' & ');
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-ink-700 pb-4">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[26px] font-bold tracking-tight text-ink-100">Live Alert Queue</h2>
          <span className="rounded-md border border-[#1f7a4f] bg-[#123d2a] px-2.5 py-0.5 text-[12px] font-bold uppercase tracking-wide text-[#3ee08f]">Automated alerts on</span>
        </div>
        <p className="mt-1 text-[14px] text-ink-300" title={versionLabel}>
          TrendSpider alerts{rs.length ? ` (${rs.join(' / ')})` : ''} → Alpaca SIP → {flow}
        </p>
        <p className="mt-0.5 text-[11px] text-ink-500">Automated analysis only — manual execution. Nothing is sent to TrendSpider, SignalStack, Alpaca or any broker.</p>
      </div>
      <PortfolioCard rows={rows} />
    </div>
  );
}

/** Paper portfolio from the allocator's snapshot (never recomputed here). */
export function PortfolioCard({ rows }: { rows: QueueRow[] }) {
  const s = portfolioSummary(rows);
  const pf = s?.pf;
  return (
    <div className="rounded-xl border border-ink-600 bg-ink-900/70 px-5 py-3" aria-label="Portfolio summary">
      <div className="flex items-center divide-x divide-ink-600">
        <div className="pr-5 text-[15px] text-ink-200"><b className="text-ink-100">Portfolio:</b> Paper ({pf ? money(pf.equity, 0) : '—'})</div>
        <div className="px-5 text-center">
          <div className="text-[12px] text-ink-300">Slots</div>
          <div className={`font-sans text-[21px] font-bold tabular-nums ${pf && pf.slotsUsed >= pf.maxPositions ? 'text-[#ff6b7f]' : 'text-[#3ee08f]'}`}>{pf ? `${pf.slotsUsed} / ${pf.maxPositions}` : '—'}</div>
        </div>
        <div className="pl-5 text-center">
          <div className="text-[12px] text-ink-300">Heat</div>
          <div className={`font-sans text-[21px] font-bold tabular-nums ${pf && pf.heatCommitted >= pf.heatLimit ? 'text-[#ff6b7f]' : 'text-[#3ee08f]'}`}>{pf ? `${money(pf.heatCommitted)} / ${money(pf.heatLimit, 0)}` : '—'}</div>
        </div>
      </div>
      {!s && <div className="mt-1 text-[11px] text-ink-500">Shown once an alert has been scored.</div>}
      {s && !s.consistent && <div className="mt-1 text-[11px] text-warn">Rows were evaluated against different portfolio states.</div>}
    </div>
  );
}

/* ───────────────────────── toolbar ───────────────────────── */

export type QueueFilter = 'ALL' | 'LONG' | 'SHORT' | 'DATA_REVIEW';
export interface ColumnGroups { shadow: boolean; trade: boolean; safety: boolean }

export function QueueToolbar(props: {
  rows: QueueRow[]; filter: QueueFilter; setFilter: (f: QueueFilter) => void; feedText: string; feedOk: boolean; pollSec: number | null;
  cols: ColumnGroups; setCols: (c: ColumnGroups) => void; allOpen: boolean; toggleAll: () => void; hasShadow: boolean; logCount: number; onExport: () => void;
}) {
  const { rows } = props;
  const [menu, setMenu] = useState(false);
  const counts: Record<QueueFilter, number> = {
    ALL: rows.length,
    LONG: rows.filter((r) => r.record.alert.direction === 'LONG').length,
    SHORT: rows.filter((r) => r.record.alert.direction === 'SHORT').length,
    DATA_REVIEW: rows.filter(isDataReview).length,
  };
  const chips: [QueueFilter, string][] = [['ALL', 'All'], ['LONG', 'LONG'], ['SHORT', 'SHORT'], ['DATA_REVIEW', 'Data Review']];
  const btn = 'rounded-lg border border-ink-600 bg-ink-900 px-4 py-2 text-[14px] text-ink-100 hover:bg-ink-800';
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap gap-2">
        {chips.map(([f, label]) => (
          <button key={f} type="button" onClick={() => props.setFilter(f)} aria-pressed={props.filter === f}
            className={`rounded-lg border px-4 py-2 text-[14px] font-semibold ${props.filter === f ? 'border-[#3d7bff] bg-[#2563eb] text-white' : 'border-ink-600 bg-ink-900 text-ink-100 hover:bg-ink-800'}`}>
            {label} ({counts[f]})
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-2 flex items-center gap-2 text-[14px] text-ink-200" title={`Polls the alert feed automatically (interval from Automation settings) · ${props.feedText}`}>
          <span className={`inline-flex h-5 w-9 items-center rounded-full px-0.5 ${props.feedOk ? 'justify-end bg-[#22c55e]' : 'justify-start bg-[#a3263a]'}`} aria-hidden="true"><span className="h-4 w-4 rounded-full bg-white" /></span>
          Auto Refresh{props.pollSec ? ` (${props.pollSec}s)` : ''}
          <span className={`text-[11px] ${props.feedOk ? 'text-ink-400' : 'text-short'}`}>{props.feedText}</span>
        </span>
        {props.hasShadow && <button type="button" onClick={props.onExport} disabled={!props.logCount} className={`${btn} disabled:opacity-40`}>Export v1.2 log ({props.logCount})</button>}
        <div className="relative">
          <button type="button" onClick={() => setMenu(!menu)} className={btn} aria-expanded={menu}>⚙ Columns</button>
          {menu && (
            <div className="absolute right-0 z-20 mt-1 w-60 rounded-lg border border-ink-600 bg-ink-900 p-2 text-[13px] shadow-xl">
              {([['shadow', 'RB v1.2 (SHADOW)', props.hasShadow], ['trade', 'Entry · Stop · Target · Qty · $ Risk · Price', true], ['safety', 'Chase · Data · Portfolio', true]] as const).filter((x) => x[2]).map(([k, label]) => (
                <label key={k} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-ink-800">
                  <input type="checkbox" checked={props.cols[k]} onChange={(e) => props.setCols({ ...props.cols, [k]: e.target.checked })} /> {label}
                </label>
              ))}
              <p className="px-2 pt-1 text-[11px] text-ink-500">General, the active strategy and Final State always show.</p>
            </div>
          )}
        </div>
        <button type="button" onClick={props.toggleAll} className={btn}>{props.allOpen ? 'Collapse All' : 'Expand All'}</button>
      </div>
    </div>
  );
}

/* ───────────────────────── table ───────────────────────── */

export function QueueTable({ rows, now, actions, layout, maxScore, optionAGrades, cols, open, setOpen }: {
  rows: QueueRow[]; now: number; actions: LiveActions; layout: StrategyColumn[]; maxScore: number; optionAGrades: Grades;
  cols: ColumnGroups; open: Set<string>; setOpen: (ids: Set<string>) => void;
}) {
  const [asc, setAsc] = useState(false);
  const sorted = useMemo(() => [...rows].sort((a, b) => (asc ? 1 : -1) * (a.record.alert.alertTimeMs - b.record.alert.alertTimeMs) || a.record.id.localeCompare(b.record.id)), [rows, asc]);
  const strat = layout.filter((c) => c.role === 'ACTIVE' || cols.shadow);
  const stratCols = (c: StrategyColumn) => [c.scoreLabel, ...c.tierLabels, ...(c.role === 'ACTIVE' ? ['Decision'] : [])];
  const trade = cols.trade ? ['Entry', 'Stop', 'Target', 'Qty', '$ Risk', 'Cur Price'] : [];
  const safety = [...(cols.safety ? ['Chase', 'Data', 'Portfolio'] : []), 'Final State'];
  const span = 6 + strat.reduce((n, c) => n + stratCols(c).length, 0) + trade.length + safety.length;
  const toggle = (id: string) => { const n = new Set(open); if (n.has(id)) n.delete(id); else n.add(id); setOpen(n); };
  const th = 'whitespace-nowrap px-1.5 py-2 text-[12.5px] font-semibold text-ink-200';
  const edge = (c: StrategyColumn) => (c.role === 'ACTIVE' ? 'border-ink-600' : 'border-dashed border-[#6a46b8]/70');
  return (
    <div className="overflow-x-auto rounded-xl border border-ink-700 bg-ink-850">
      <table className="w-full min-w-[1300px] font-sans text-[13px] tabular-nums">
        <thead className="bg-ink-900">
          <tr className="text-center">
            <th rowSpan={2} className="w-8" />
            <th rowSpan={2} className={`${th} text-left`}>
              <button type="button" onClick={() => setAsc(!asc)} className="inline-flex items-center gap-1 hover:text-white" title="Sort by alert time">Time (ET) <span className="text-ink-400">{asc ? '▲' : '▼'}</span></button>
            </th>
            {['Ticker', 'Side', 'Rule Set', 'TS Qualified'].map((h) => <th key={h} rowSpan={2} className={th}>{h}</th>)}
            {strat.map((c) => (
              <th key={c.version} colSpan={stratCols(c).length} className={`${th} border-x border-b border-b-ink-700 ${edge(c)} ${c.role === 'ACTIVE' ? 'text-ink-100' : 'text-[#d9c8ff]'}`} title={c.role === 'ACTIVE' ? 'Executable decision' : 'Comparison only, not used for execution'}>
                {c.title}
              </th>
            ))}
            {trade.map((h) => <th key={h} rowSpan={2} className={th}>{h}</th>)}
            {safety.map((h) => <th key={h} rowSpan={2} className={th}>{h}</th>)}
          </tr>
          <tr className="text-center">
            {strat.map((c) => stratCols(c).map((h, i, a) => (
              <th key={`${c.version}-${h}`} className={`${th} text-[12px] font-medium text-ink-300 ${i === 0 ? `border-l ${edge(c)}` : ''} ${i === a.length - 1 ? `border-r ${edge(c)}` : ''}`}>{h}</th>
            )))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const id = r.record.id;
            const isOpen = open.has(id);
            const f = detailFields(r);
            const q = qualificationStatus(r);
            const dec = decisionBadge(r);
            const fin = finalBadge(r);
            const td = 'whitespace-nowrap px-1.5 py-2.5 text-center align-middle';
            return (
              <Fragment key={id}>
                <tr className={`cursor-pointer border-t border-ink-700/70 hover:bg-ink-800/80 ${isOpen ? 'bg-[#13213f]/50 outline outline-2 -outline-offset-2 outline-[#3d7bff]' : ''}`} onClick={() => toggle(id)} aria-expanded={isOpen} data-row={id}>
                  <td className="pl-3 text-center">
                    <span className={`inline-flex h-6 w-6 items-center justify-center rounded border text-[12px] ${isOpen ? 'border-[#3d7bff] bg-[#1a2c55] text-white' : 'border-ink-600 text-ink-300'}`}>{isOpen ? '⌄' : '›'}</span>
                  </td>
                  <td className={`${td} text-left text-ink-100`}>{fmtEt(f.alertTimeMs).replace(' ET', '')}</td>
                  <td className={`${td} font-bold text-ink-100`}>{r.record.alert.symbol}</td>
                  <td className={td}><SidePill side={r.record.alert.direction} /></td>
                  <td className={`${td} text-ink-200`} title={ruleSetText(r).status}>{ruleSetText(r).id}</td>
                  <td className={td}><Pill s={{ label: qualText(q), tone: q.label === 'QUALIFIED' ? 'ok' : q.tone }} title={q.detail} /></td>
                  {strat.map((c) => {
                    const cell = c.cell(r);
                    const tone = c.role === 'ACTIVE' && cell.tiers[0] ? SCORE_TEXT[scoreTone(cell.tiers[0])] : 'text-ink-100';
                    return (
                      <Fragment key={c.version}>
                        <td className={`${td} border-l ${edge(c)} text-[15px] font-bold ${tone}`}>{cell.score ?? '—'}</td>
                        {cell.tiers.map((t, i) => <td key={i} className={`${td} ${c.role !== 'ACTIVE' && i === cell.tiers.length - 1 ? `border-r ${edge(c)}` : ''}`}><TierPill t={t} /></td>)}
                        {c.role === 'ACTIVE' && <td className={`${td} border-r ${edge(c)}`}><Pill s={dec} wide title={`${r.decision.decision} — ${r.decision.detail}`} /></td>}
                      </Fragment>
                    );
                  })}
                  {cols.trade && (
                    <>
                      <td className={`${td} text-ink-100`}>{p(f.entry)}</td>
                      <td className={`${td} text-ink-100`}>{p(f.stop)}</td>
                      <td className={`${td} text-ink-100`}>{p(f.target)}</td>
                      <td className={`${td} text-ink-100`}>{f.shares ?? '—'}</td>
                      <td className={`${td} text-ink-100`}>{money(f.plannedRisk)}</td>
                      <td className={`${td} text-ink-100`}>{p(f.currentPrice)}</td>
                    </>
                  )}
                  {cols.safety && (
                    <>
                      <td className={td}><Pill s={chaseStatus(r)} title={chaseStatus(r).detail} /></td>
                      <td className={td}><Pill s={dataStatus(r)} title={dataStatus(r).detail} /></td>
                      <td className={td}><Pill s={portfolioStatus(r)} title={portfolioStatus(r).detail} /></td>
                    </>
                  )}
                  <td className={td}><Pill s={fin} wide title={`${r.decision.decision} — ${r.decision.detail}`} /></td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={span} className="border-t border-ink-700 bg-ink-900/40 px-3 py-3">
                      <QueueDetails r={r} now={now} actions={actions} layout={layout} maxScore={maxScore} optionAGrades={optionAGrades} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {sorted.length === 0 && (
            <tr><td colSpan={span} className="px-3 py-6 text-center text-ink-400">No alerts match this filter.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────────────────── expanded row ───────────────────────── */

const ICONS = {
  mapping: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  trade: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  data: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  portfolio: 'M12 3l9 5-9 5-9-5 9-5zm-9 9l9 5 9-5M3 16l9 5 9-5',
};

function Panel4({ icon, title, rows }: { icon: keyof typeof ICONS; title: string; rows: [string, ReactNode][] }) {
  return (
    <div className="px-4 py-2">
      <div className="mb-2 flex items-center gap-2 text-[15px] font-semibold text-ink-100">
        <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-ink-200" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[icon]} /></svg>
        {title}
      </div>
      <dl className="divide-y divide-ink-700/80">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[minmax(130px,44%)_1fr] items-center gap-2 py-1.5 text-[13.5px]">
            <dt className="text-ink-300">{k}</dt>
            <dd className="tabular-nums text-ink-100">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function QueueDetails({ r, now, actions, layout, maxScore, optionAGrades }: { r: QueueRow; now: number; actions: LiveActions; layout: StrategyColumn[]; maxScore: number; optionAGrades: Grades }) {
  const f = detailFields(r);
  const s = r.record.snapshot;
  const v = s?.values;
  const a = r.record.alert;
  const rs = ruleSetText(r);
  const q = qualificationStatus(r);
  const fin = finalState(r);
  const ch = f.chase;
  const cs = chaseStatus(r);
  const ds = dataStatus(r);
  const ps = portfolioStatus(r);
  const dec = decisionBadge(r);
  const canAct = r.candidate && ['NEW', 'WATCHLIST'].includes(r.candidate.status);
  const pm = a.lastPrice !== null && r.record.initialQuote ? a.lastPrice - r.record.initialQuote.price : null;
  const ages = r.quote ? { data: (now - r.quote.receivedMs) / 1000, trade: (Date.parse(r.quote.fetchedIso) - Date.parse(r.quote.tradeIso)) / 1000 } : null;
  const active = layout.find((c) => c.role === 'ACTIVE');
  const finTone: Tone = fin.ticket ? 'ok' : fin.tone;
  const why = !fin.ticket && r.decision.reasons.length > 0;
  const comparison = layout.filter((c) => c.role !== 'ACTIVE');
  return (
    <div className="space-y-3 font-sans" data-details={r.record.id}>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 rounded-xl border-2 border-[#3d7bff] bg-ink-900 px-5 py-3">
        <div className="flex items-center gap-3 pr-6 sm:border-r sm:border-ink-600">
          <span className="text-[28px] font-black tracking-tight text-ink-100">{a.symbol}</span>
          <SidePill side={a.direction} />
        </div>
        {layout.map((c, i) => {
          const cell = c.cell(r);
          return (
            <div key={c.version} className={`text-[14px] ${i > 0 ? 'sm:border-l sm:border-ink-600 sm:pl-8' : ''}`}>
              <div className="text-[16px] font-semibold"><span className="text-[#5b9bff]">{c.version}</span> <span className={c.role === 'ACTIVE' ? 'text-ink-100' : 'text-[#d9c8ff]'}>({c.role})</span></div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-ink-200">
                <span>Score: <b className={c.role === 'ACTIVE' && cell.tiers[0] ? SCORE_TEXT[scoreTone(cell.tiers[0])] : 'text-ink-100'}>{cell.score ?? '—'}</b> / {c.version === 'RB v1.2' ? maxScore : 100}</span>
                {c.tierLabels.map((l, k) => <span key={l} className="flex items-center gap-1.5">{l}: <TierPill t={cell.tiers[k]} /></span>)}
                {cell.decision && <span>Decision: <b className={TONE_TEXT[dec.tone]}>{cell.decision}</b></span>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid gap-y-2 rounded-xl border border-ink-700 bg-ink-850 py-2 md:grid-cols-2 xl:grid-cols-4 xl:divide-x xl:divide-ink-700">
        <Panel4 icon="mapping" title="Alert & Mapping" rows={[
          [`Alert time (${f.timeSource === 'RECEIVED' ? 'server' : 'payload'})`, fmtEt(f.alertTimeMs)],
          ['Signal candle', f.signalCandle ?? '—'],
          ['Mapped candle (v1.2)', f.mappedCandle ?? '—'],
          ['Receipt lag', f.lagSec !== null ? `${f.lagSec} s after candle close` : '—'],
          ['Mapping status', f.mappingStatus ?? '—'],
          ['Rule set', rs.status ? `${rs.id} (${rs.status})` : rs.id],
          ['TS Qualified', <b key="q" className={TONE_TEXT[q.label === 'QUALIFIED' ? 'ok' : q.tone]}>{q.label === 'QUALIFIED' ? 'YES' : q.label === '—' ? '—' : `NO — ${q.label}`}</b>],
        ]} />
        <Panel4 icon="trade" title="Trade Construction" rows={[
          ['Entry', p(f.entry)], ['Stop', p(f.stop)], ['Target', p(f.target)], ['Quantity', f.shares === null ? '—' : String(f.shares)],
          ['Dollar risk (planned)', money(f.plannedRisk)], ['ATR (signal)', p(f.atr, 4)],
          ['Chase distance', ch ? `${ch.distance >= 0 ? '+' : ''}${ch.distance.toFixed(2)} (${ch.distanceAtr >= 0 ? '+' : ''}${ch.distanceAtr.toFixed(2)} ATR)` : '—'],
          ['Allowed chase distance', ch ? `${ch.thresholdAtr} ATR = ${money(ch.thresholdDollars)}` : '—'],
          ['Chase status', <b key="c" className={TONE_TEXT[cs.tone]}>{cs.label === 'PASS' && ch && !ch.crossed ? 'NOT CROSSED' : cs.label}</b>],
        ]} />
        <Panel4 icon="data" title="Data & Diagnostics" rows={[
          ['Data status', <b key="d" className={TONE_TEXT[ds.tone]}>{ds.label === 'PASS' ? 'PASS' : `${ds.label}: ${ds.detail}`}</b>],
          ['SIP RVOL (diagnostic)', f.sipRvol === null ? 'unavailable — non-blocking' : f.sipRvol.toFixed(2)],
          ['RB v1.1 hard fails', f.hardFails.length ? f.hardFails.join(', ') : 'none'],
          ['Parity warnings', f.parity.length ? f.parity.map((w) => w.replace(/^PARITY_(WARNING|NOTE)[_:]?/, '')).join(', ') : 'none'],
          ['Issues', f.issues.length || f.errors.length ? [...f.issues.map((i) => i.message), ...f.errors].join(' · ') : 'none'],
        ]} />
        <Panel4 icon="portfolio" title="Portfolio & Execution" rows={[
          ['Portfolio slots', f.portfolio ? `${f.portfolio.slotsUsed} / ${f.portfolio.maxPositions} used` : '—'],
          ['Portfolio heat', f.portfolio ? `${money(f.portfolio.heatCommitted)} / ${money(f.portfolio.heatLimit, 0)}` : '—'],
          ['Portfolio status', <b key="p" className={TONE_TEXT[ps.tone]} title={ps.detail}>{ps.label}{ps.label === 'BLOCKED' ? ` — ${ps.detail}` : ''}</b>],
          ['Final execution state', <b key="f" className={TONE_TEXT[finTone]}>{fin.ticket ? 'READY — TICKET' : `NO TICKET – ${fin.label}`}</b>],
        ]} />
      </div>

      {why && (
        <div className="flex items-start gap-3 rounded-xl border-2 border-[#b8901e] bg-[#2a2109]/70 px-4 py-2.5 text-[14px] text-ink-100">
          <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[#ffc542] text-[12px] font-bold text-[#ffc542]">i</span>
          <p>
            <b>Why {dec.label}?</b> <span className="text-ink-200">{[...new Set(r.decision.reasons)].join(' ')}</span>
            {comparison.map((c) => { const cell = c.cell(r); return cell.score !== null ? <span key={c.version} className="text-ink-200"> {c.version} ({c.role}) scores {cell.score}{cell.tiers[0] ? ` (${TIER_SHORT[cell.tiers[0]]})` : ''} — comparison only.</span> : null; })}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[#3ee08f]">{active?.version ?? ''} active actions</span>
        {r.decision.ticket && <button type="button" onClick={() => actions.submit(r.record.id)} className="rounded bg-long px-2.5 py-1 text-xs font-bold text-ink-950">Mark order submitted</button>}
        {canAct && <button type="button" onClick={() => actions.watch(r.record.id)} className="rounded border border-ink-600 px-2.5 py-1 text-xs">Watch</button>}
        {canAct && <button type="button" onClick={() => actions.skip(r.record.id)} className="rounded border border-ink-600 px-2.5 py-1 text-xs">Skip trade</button>}
        {v && <button type="button" onClick={() => actions.openInCalculator(r)} className="rounded border border-ink-600 px-2.5 py-1 text-xs">Open in manual Calculator</button>}
        {(r.record.status === 'DATA_ERROR' || r.record.status === 'RECEIVED') && <button type="button" onClick={() => actions.reprocess(r.record.id)} className="rounded border border-warn px-2.5 py-1 text-xs text-warn">Retry market data</button>}
      </div>

      <details className="rounded-lg border border-ink-700 bg-ink-850 p-2.5 text-[12.5px]">
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-ink-400">More detail — indicators, hard rules, score breakdown, provenance, shadow comparison</summary>
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 lg:grid-cols-4">
            <Box title="Alert-time indicators (automated market data values)">
              {v ? (
                <KV rows={[['O / H / L / C', `${p(v.open)} / ${p(v.high)} / ${p(v.low)} / ${p(v.close)}`], ['EMA9 / EMA20', `${p(v.ema9, 3)} / ${p(v.ema20, 3)}`], ['RSI14', p(v.rsi, 1)], ['RVOL20', p(v.rvol, 2)], [`VWAP (${s?.config.vwapMode})`, p(v.vwap, 3)], ['VWAP (other mode)', p(v.vwapAlternative, 3)], ['15m candle', s?.confirm15m?.label ?? '—'], ['15m Close / EMA20', `${p(v.close15m)} / ${p(v.ema20_15m, 3)}`]]} />
              ) : (
                <p className="text-warn">No complete snapshot.</p>
              )}
            </Box>
            <Box title="Hard rules">
              {r.ranked ? (
                <ul className="space-y-0.5">{r.ranked.hardRules.map((h) => <li key={h.key} className={h.pass ? 'text-ink-300' : 'text-short'}>{h.pass ? '✓' : '✕'} {h.label}{!h.pass && <span className="block text-[11px]">{h.detail}</span>}</li>)}</ul>
              ) : (
                <p className="text-ink-400">Not evaluated.</p>
              )}
              <div className="mt-2 text-[11px] uppercase tracking-wider text-ink-400">Final safety gate</div>
              <ul className="space-y-0.5">{r.decision.gate.map((g) => <li key={g.label} className={g.pass === false ? 'text-short' : g.pass ? 'text-ink-300' : 'text-ink-500'}>{g.pass === false ? '✕' : g.pass ? '✓' : '·'} {g.label}</li>)}</ul>
            </Box>
            <Box title={`Score breakdown ${r.ranked?.total ?? '—'} / 100`}>
              {r.ranked ? (
                <KV rows={[...SETUP_KEYS, ...FIT_KEYS].map((k) => { const x = r.ranked!.components.find((c) => c.key === k)!; return [x.label, x.na ?? `${x.points} / ${x.max}`]; })} />
              ) : (
                <p className="text-ink-400">Not scored.</p>
              )}
            </Box>
            <Box title="Show data validation (provenance)">
              <KV rows={[
                ['Received', fmtEt(f.receivedMs)],
                ['Market data through', r.record.marketDataThroughIso ? fmtEt(Date.parse(r.record.marketDataThroughIso)) : '—'],
                ['15m confirmation candle', s?.confirm15m ? `${s.confirm15m.label} (${s.confirm15m.bars5}/3 bars)` : '—'],
                ['Data provider', `${r.record.provider.name} · feed ${r.record.provider.feed.toUpperCase()}`],
                ['TrendSpider last price', a.lastPrice === null ? 'not supplied' : `$${p(a.lastPrice)}`],
                ['Provider price at alert', r.record.initialQuote ? `$${p(r.record.initialQuote.price)}` : '—'],
                ['Price difference', pm === null ? '—' : `$${Math.abs(pm).toFixed(2)}`],
                ['Current price', p(f.currentPrice)],
                ['Current price age', ages ? `${ages.data.toFixed(1)} s (last trade ${ages.trade.toFixed(0)} s before fetch)` : '—'],
                ['Position value', r.candidate ? usd(r.candidate.positionValue, 0) : '—'],
                ['Calculator / ranker version', `${r.record.versions.rules} / ${r.record.versions.scoring}`],
                ['Strategy version', r.candidate?.initialScore?.strategyVersion ?? r.record.versions.strategy],
                ['Alert conditions reproduced', s?.alertConditions.length ? `${s.alertConditions.filter((c) => c.pass).length} / ${s.alertConditions.length}` : '—'],
                ['Final decision', `${r.decision.decision} — ${r.decision.detail}`],
              ]} />
            </Box>
          </div>
          {layout.some((c) => c.version === 'RB v1.2' && c.role !== 'ACTIVE') && <ShadowPanel r={r} maxScore={maxScore} optionAGrades={optionAGrades} />}
          {r.live?.plan && (
            <Box title="Calculation (shared RB calculator)">
              <p className="num">
                Buffer {p(r.live.plan.buffer)} → Entry {p(r.live.plan.entry)} · structural {p(r.live.plan.structuralRisk, 4)} vs ATR {p(r.live.plan.atrRisk, 4)} → R {p(r.live.plan.riskPerShare)} ({r.live.plan.riskMethod}) · Stop {p(r.live.plan.stop)} · Target {p(r.live.plan.target)} · shares MIN({r.live.plan.riskShares}, {r.live.plan.investmentShares}) = {r.live.plan.shares} · {r.live.headline}
              </p>
            </Box>
          )}
        </div>
      </details>
    </div>
  );
}

const Box = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="rounded-lg border border-ink-700 bg-ink-900/60 p-2.5">
    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-300">{title}</div>
    {children}
  </div>
);

const KV = ({ rows }: { rows: [string, string][] }) => (
  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
    {rows.map(([k, val]) => (
      <Fragment key={k}>
        <dt className="text-ink-400">{k}</dt>
        <dd className="num text-right text-ink-100">{val}</dd>
      </Fragment>
    ))}
  </dl>
);

/* ───────────────────────── legend ───────────────────────── */

/** Legend. Ranges are the configured active grades; the chase limit is the calculator's own threshold when a row has one. */
export function QueueLegend({ grades, rows, layout }: { grades: Grades; rows: QueueRow[]; layout: StrategyColumn[] }) {
  const chase = rows.map((r) => r.live?.chase?.thresholdAtr).find((x) => x !== undefined);
  const tiers: [QualityTier, string][] = [
    ['ELITE', `≥ ${grades.elite}`], ['HIGH_PRIORITY', `${grades.high}–${grades.elite - 1}`], ['WATCHLIST', `${grades.watchlist}–${grades.high - 1}`],
    ['LOW_PRIORITY', `${grades.low}–${grades.watchlist - 1}`], ['SKIP', `< ${grades.low}`],
  ];
  const shadow = layout.find((c) => c.version === 'RB v1.2' && c.role !== 'ACTIVE');
  return (
    <div className="space-y-1 border-t border-ink-700 pt-3" aria-label="Status legend">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[14px] text-ink-200">
        <b className="text-ink-100">Legend:</b>
        {tiers.map(([t, range]) => <span key={t} className="inline-flex items-center gap-1.5"><TierPill t={t} /> {range}</span>)}
        <span className="text-ink-600">|</span>
        <span><b className="text-[#ffc542]">DATA REVIEW</b> = Data integrity issue</span>
        <span className="text-ink-600">|</span>
        <span><b className="text-[#ff6b7f]">CHASED</b> = Price beyond allowable chase{chase !== undefined ? ` (${chase} × ATR)` : ''}</span>
        <span className="text-ink-600">|</span>
        <span><b className="text-ink-100">TS Qualified</b> = TrendSpider setup conditions passed</span>
      </div>
      <p className="text-[11px] text-ink-500">
        Score ranges are {layout.find((c) => c.role === 'ACTIVE')?.version ?? 'active'} grades. TS Qualified means a trusted rule set was recognised and its direction matched.
        {shadow ? ` ${shadow.version} ${shadow.role} Option B: ELITE ≥ ${V12_SHADOW_GRADES.elite} · HIGH ≥ ${V12_SHADOW_GRADES.high} · WATCHLIST ≥ ${V12_SHADOW_GRADES.watchlist} · LOW ≥ ${V12_SHADOW_GRADES.low} — comparison only, not used for execution.` : ''}
      </p>
    </div>
  );
}
