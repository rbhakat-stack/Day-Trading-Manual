/**
 * Live Alert Queue table, expanded details, portfolio strip and legends (display only). Values come from the
 * presentation model (queueView.ts), which reads existing engine output; no control here can act on a non-active
 * strategy — tickets and actions come from the ACTIVE decision (`row.decision`) only.
 */
import { Fragment, useState } from 'react';
import type { QueueRow } from '../../engine/automation/liveQueue';
import { fmtEt, mmss } from '../../engine/automation/etTime';
import { V12_SHADOW_GRADES, type Grades } from '../../engine/automation/v12/v12Thresholds';
import type { QualityTier } from '../../engine/ranker/opportunityTypes';
import { FIT_KEYS, SETUP_KEYS } from '../../engine/ranker/opportunityTypes';
import { usd } from '../../lib/format';
import {
  chaseStatus, dataStatus, detailFields, finalState, portfolioStatus, portfolioSummary, qualificationStatus, ROLE_NOTE, ruleSetText,
  TIER_SHORT, TIER_TONE, type Status, type StrategyColumn, type Tone,
} from './queueView';
import type { LiveActions } from './LiveQueuePage';
import { ShadowPanel } from './ShadowV12';

const TONE: Record<Tone, string> = {
  ok: 'border-long/50 bg-long/10 text-long',
  warn: 'border-warn/60 bg-warn-dim/40 text-warn',
  bad: 'border-short/60 bg-short-dim/40 text-short',
  info: 'border-[#5b8cff]/60 bg-[#13213f]/60 text-[#9db8ff]',
  shadow: 'border-[#b48cff]/60 bg-[#1a1530]/60 text-[#cdb3ff]',
  muted: 'border-ink-600 text-ink-400',
};

export const StatusBadge = ({ s, title }: { s: Pick<Status, 'label' | 'tone'>; title?: string }) => (
  <span title={title} className={`inline-block whitespace-nowrap rounded border px-1.5 py-px text-[10px] font-bold uppercase leading-snug tracking-wide ${TONE[s.tone]}`}>{s.label}</span>
);

const TierBadge = ({ t }: { t: QualityTier | null }) => (t ? <StatusBadge s={{ label: TIER_SHORT[t], tone: TIER_TONE[t] }} /> : <span className="text-ink-500">—</span>);

const p = (x: number | null | undefined, dp = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(x < 1 ? 4 : dp));
const money = (x: number | null | undefined, dp = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : usd(x, dp));
const SHADOW_CELL = 'border-l border-dashed border-[#b48cff]/40 bg-[#1a1530]/25';
const groupCell = (c: StrategyColumn) => (c.role === 'ACTIVE' ? 'border-l border-long/30 bg-long/[0.04]' : SHADOW_CELL);

/* ───────────────────────── header strips ───────────────────────── */

/** Which version decides and which are comparison only (from the layout metadata). */
export function StrategyLegend({ layout, logCount, onExport }: { layout: StrategyColumn[]; logCount: number; onExport: () => void }) {
  const active = layout.find((c) => c.role === 'ACTIVE');
  const others = layout.filter((c) => c.role !== 'ACTIVE');
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 text-xs">
      {active && (
        <span>
          <span className="mr-1 text-ink-400">Active decision</span>
          <span className="rounded bg-long/15 px-1.5 py-0.5 font-bold text-long">{active.version} ACTIVE</span>
        </span>
      )}
      {others.map((c) => (
        <span key={c.version}>
          <span className="mr-1 text-ink-400">{c.role === 'SHADOW' ? 'Shadow' : 'Comparison'}</span>
          <span className="rounded border border-dashed border-[#b48cff]/70 px-1.5 py-0.5 font-bold text-[#cdb3ff]">{c.version} {c.role}</span>
        </span>
      ))}
      <span className="text-ink-400">
        Tickets, actions and trade decisions come from {active?.version ?? 'the active version'} only.
        {others.map((c) => ` ${c.version} ${c.role} — ${ROLE_NOTE[c.role]}.`).join('')}
      </span>
      {others.some((c) => c.version === 'RB v1.2' && c.role === 'SHADOW') && (
        <button type="button" onClick={onExport} disabled={!logCount} className="ml-auto rounded border border-ink-600 px-2 py-0.5 text-[11px] text-ink-300 hover:bg-ink-700 disabled:opacity-40">
          Export v1.2 shadow log ({logCount})
        </button>
      )}
    </div>
  );
}

/** Paper portfolio from the allocator's snapshot (never recomputed here). */
export function PortfolioStrip({ rows }: { rows: QueueRow[] }) {
  const s = portfolioSummary(rows);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 text-xs" aria-label="Portfolio summary">
      <span className="font-semibold uppercase tracking-wider text-ink-400">Portfolio</span>
      {s ? (
        <>
          <span>Paper <b className="num text-ink-100">{money(s.pf.equity, 0)}</b></span>
          <span>Slots <b className="num text-ink-100">{s.pf.slotsUsed} / {s.pf.maxPositions}</b></span>
          <span>Heat <b className="num text-ink-100">{money(s.pf.heatCommitted, 0)} / {money(s.pf.heatLimit, 0)}</b> <span className="text-ink-500">(open {money(s.pf.heatOpen, 0)} + pending)</span></span>
          <span>Available <b className="num text-ink-100">{money(s.pf.available, 0)}</b></span>
          {!s.consistent && <span className="text-warn">Rows were evaluated against different portfolio states — see each row.</span>}
        </>
      ) : (
        <span className="text-ink-400">Shown once an alert has been scored by the ranker.</span>
      )}
    </div>
  );
}

const grades = (g: Grades, k: keyof Grades) => g[k];

/** Concise status legend. Thresholds shown are the existing configured grades, not computed here. */
export function StatusLegend({ optionAGrades, layout }: { optionAGrades: Grades; layout: StrategyColumn[] }) {
  const has12 = layout.some((c) => c.version === 'RB v1.2');
  const has11 = layout.some((c) => c.version === 'RB v1.1');
  const th = (k: keyof Grades) => [has11 ? `${grades(optionAGrades, k)} (v1.1)` : '', has12 ? `${grades(V12_SHADOW_GRADES, k)} (v1.2 B)` : ''].filter(Boolean).join(' · ');
  const items: [Status, string][] = [
    [{ label: 'ELITE', tone: 'ok', detail: '' }, `score ≥ ${th('elite')}`],
    [{ label: 'HIGH', tone: 'info', detail: '' }, `≥ ${th('high')} — trade consideration`],
    [{ label: 'WATCHLIST', tone: 'shadow', detail: '' }, `≥ ${th('watchlist')}`],
    [{ label: 'LOW', tone: 'muted', detail: '' }, `≥ ${th('low')}`],
    [{ label: 'SKIP', tone: 'muted', detail: '' }, 'below LOW'],
    [{ label: 'DATA REVIEW', tone: 'warn', detail: '' }, 'data incomplete, mismatched or stale — no ticket'],
    [{ label: 'CHASED', tone: 'bad', detail: '' }, 'price beyond the trigger by more than the chase limit — do not enter'],
    [{ label: 'QUALIFIED', tone: 'ok', detail: '' }, 'TS Qualified: trusted TrendSpider rule set recognised, direction matched'],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-400" aria-label="Status legend">
      {items.map(([s, t]) => (
        <span key={s.label} className="inline-flex items-center gap-1"><StatusBadge s={s} /> {t}</span>
      ))}
    </div>
  );
}

/* ───────────────────────── table ───────────────────────── */

export interface QueueGroup { key: string; title: string; hint: string; rows: QueueRow[] }

/** One table for the whole queue (columns align across sections); each queue section is a row group with a header row. */
export function QueueTable({ groups, now, actions, layout, maxScore, optionAGrades }: { groups: QueueGroup[]; now: number; actions: LiveActions; layout: StrategyColumn[]; maxScore: number; optionAGrades: Grades }) {
  const [open, setOpen] = useState<string | null>(null);
  const general = ['Time (ET)', 'Ticker', 'Side', 'Rule set', 'TS Qualified'];
  const trade = ['Entry', 'Stop', 'Target', 'Qty', '$ Risk', 'Current'];
  const safety = ['Chase', 'Data', 'Portfolio', 'Final state'];
  const stratCols = (c: StrategyColumn) => [c.scoreLabel, ...c.tierLabels, ...(c.role === 'ACTIVE' ? ['Decision'] : [])];
  const span = general.length + layout.reduce((n, c) => n + stratCols(c).length, 0) + trade.length + safety.length;
  const th = 'whitespace-nowrap px-1.5 py-1 font-medium';
  return (
    <div className="overflow-x-auto rounded-xl border border-ink-700 bg-ink-850 px-2 py-2">
      <table className="num w-full min-w-[1360px] text-[12px]">
        <thead>
          <tr className="text-left text-[10px] font-bold uppercase tracking-wider">
            <th colSpan={general.length} className="px-1.5 pb-1 text-ink-300">General</th>
            {layout.map((c) => (
              <th key={c.version} colSpan={stratCols(c).length} className={`px-1.5 pb-1 ${c.role === 'ACTIVE' ? 'border-l border-long/30 text-long' : 'border-l border-dashed border-[#b48cff]/40 text-[#cdb3ff]'}`} title={ROLE_NOTE[c.role]}>
                {c.title}
              </th>
            ))}
            <th colSpan={trade.length} className="border-l border-ink-700 px-1.5 pb-1 text-ink-300">Trade</th>
            <th colSpan={safety.length} className="border-l border-ink-700 px-1.5 pb-1 text-ink-300">Safety / execution</th>
          </tr>
          <tr className="text-left text-[10px] uppercase tracking-wider text-ink-400">
            {general.map((h) => <th key={h} className={th}>{h}</th>)}
            {layout.map((c) => stratCols(c).map((h, i) => <th key={`${c.version}-${h}`} className={`${th} ${i === 0 ? groupCell(c) : c.role === 'ACTIVE' ? 'bg-long/[0.04]' : 'bg-[#1a1530]/25'}`}>{h}</th>))}
            {trade.map((h, i) => <th key={h} className={`${th} ${i === 0 ? 'border-l border-ink-700' : ''}`}>{h}</th>)}
            {safety.map((h, i) => <th key={h} className={`${th} ${i === 0 ? 'border-l border-ink-700' : ''}`}>{h}</th>)}
          </tr>
        </thead>
        {groups.map((g) => (
        <tbody key={g.key}>
          <tr className="border-t border-ink-600">
            <td colSpan={span} className="bg-ink-900/70 px-1.5 py-1.5 font-sans">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-200">{g.title} ({g.rows.length})</span>
              {g.hint && <span className="ml-3 text-[11px] text-ink-400">{g.hint}</span>}
            </td>
          </tr>
          {g.rows.map((r) => {
            const id = r.record.id;
            const f = detailFields(r);
            const rs = ruleSetText(r);
            const fin = finalState(r);
            const td = 'px-1.5 py-1.5 align-top';
            return (
              <Fragment key={id}>
                <tr className="cursor-pointer border-t border-ink-700/60 hover:bg-ink-800" onClick={() => setOpen(open === id ? null : id)} aria-expanded={open === id} data-row={id}>
                  <td className={td}>
                    <div>{fmtEt(f.alertTimeMs).replace(' ET', '')}</div>
                    <div className="text-[10px] text-ink-500">age {mmss(r.decision.freshness.ageMs)}</div>
                  </td>
                  <td className={`${td} font-bold text-ink-100`}>{r.record.alert.symbol}</td>
                  <td className={`${td} font-semibold ${r.record.alert.direction === 'LONG' ? 'text-long' : 'text-short'}`}>{r.record.alert.direction}</td>
                  <td className={`${td} font-sans`}>
                    <div className="whitespace-nowrap">{rs.id}</div>
                    {rs.status && <div className="text-[10px] text-ink-500">{rs.status.toLowerCase()}</div>}
                  </td>
                  <td className={td}><StatusBadge s={qualificationStatus(r)} title={qualificationStatus(r).detail} /></td>
                  {layout.map((c) => {
                    const cell = c.cell(r);
                    return (
                      <Fragment key={c.version}>
                        <td className={`${td} ${groupCell(c)} font-bold ${c.role === 'ACTIVE' ? 'text-ink-100' : 'text-[#cdb3ff]'}`}>{cell.score ?? '—'}</td>
                        {cell.tiers.map((t, i) => <td key={i} className={`${td} ${c.role === 'ACTIVE' ? 'bg-long/[0.04]' : 'bg-[#1a1530]/25'}`}><TierBadge t={t} /></td>)}
                        {c.role === 'ACTIVE' && <td className={`${td} bg-long/[0.04] max-w-[150px] font-sans text-[11px] font-semibold leading-tight text-ink-100`}>{cell.decision}</td>}
                      </Fragment>
                    );
                  })}
                  <td className={`${td} border-l border-ink-700`}>{p(f.entry)}</td>
                  <td className={`${td} text-short`}>{p(f.stop)}</td>
                  <td className={`${td} text-long`}>{p(f.target)}</td>
                  <td className={td}>{f.shares ?? '—'}</td>
                  <td className={td}>{money(f.plannedRisk)}</td>
                  <td className={td}>{p(f.currentPrice)}</td>
                  <td className={`${td} border-l border-ink-700`}><StatusBadge s={chaseStatus(r)} title={chaseStatus(r).detail} /></td>
                  <td className={td}><StatusBadge s={dataStatus(r)} title={dataStatus(r).detail} /></td>
                  <td className={td}><StatusBadge s={portfolioStatus(r)} title={portfolioStatus(r).detail} /></td>
                  <td className={`${td} max-w-[170px] font-sans`}>
                    <StatusBadge s={{ label: fin.ticket ? 'TICKET' : 'NO TICKET', tone: fin.ticket ? 'ok' : fin.tone === 'muted' ? 'muted' : fin.tone }} />
                    <div className="mt-0.5 text-[10px] leading-tight text-ink-400">{fin.detail}</div>
                  </td>
                </tr>
                {open === id && (
                  <tr className="bg-ink-900/60">
                    <td colSpan={span} className="px-3 py-3">
                      <QueueDetails r={r} now={now} actions={actions} layout={layout} maxScore={maxScore} optionAGrades={optionAGrades} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
        ))}
      </table>
    </div>
  );
}

/* ───────────────────────── expanded row ───────────────────────── */

export function QueueDetails({ r, now, actions, layout, maxScore, optionAGrades }: { r: QueueRow; now: number; actions: LiveActions; layout: StrategyColumn[]; maxScore: number; optionAGrades: Grades }) {
  const f = detailFields(r);
  const s = r.record.snapshot;
  const v = s?.values;
  const a = r.record.alert;
  const rs = ruleSetText(r);
  const fin = finalState(r);
  const ch = f.chase;
  const canAct = r.candidate && ['NEW', 'WATCHLIST'].includes(r.candidate.status);
  const pm = a.lastPrice !== null && r.record.initialQuote ? a.lastPrice - r.record.initialQuote.price : null;
  const ages = r.quote ? { data: (now - r.quote.receivedMs) / 1000, trade: (Date.parse(r.quote.fetchedIso) - Date.parse(r.quote.tradeIso)) / 1000 } : null;
  const active = layout.find((c) => c.role === 'ACTIVE');
  return (
    <div className="space-y-3 font-sans text-[12.5px]" data-details={r.record.id}>
      {r.decision.reasons.length > 0 && <ul className="list-disc space-y-0.5 pl-5 text-[#ffd6a8]">{r.decision.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-long">{active?.version ?? ''} ACTIVE actions</span>
        {r.decision.ticket && <button type="button" onClick={() => actions.submit(r.record.id)} className="rounded bg-long px-2.5 py-1 text-xs font-bold text-ink-950">Mark order submitted</button>}
        {canAct && <button type="button" onClick={() => actions.watch(r.record.id)} className="rounded border border-ink-600 px-2.5 py-1 text-xs">Watch</button>}
        {canAct && <button type="button" onClick={() => actions.skip(r.record.id)} className="rounded border border-ink-600 px-2.5 py-1 text-xs">Skip trade</button>}
        {v && <button type="button" onClick={() => actions.openInCalculator(r)} className="rounded border border-ink-600 px-2.5 py-1 text-xs">Open in manual Calculator</button>}
        {(r.record.status === 'DATA_ERROR' || r.record.status === 'RECEIVED') && <button type="button" onClick={() => actions.reprocess(r.record.id)} className="rounded border border-warn px-2.5 py-1 text-xs text-warn">Retry market data</button>}
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Box title="Alert & mapping">
          <KV rows={[
            ['Alert time', `${fmtEt(f.alertTimeMs)}${f.timeSource === 'RECEIVED' ? ' (server receipt)' : ''}`],
            ['Received', fmtEt(f.receivedMs)],
            ['Signal candle', f.signalCandle ?? '—'],
            ['Mapped candle', f.mappedCandle ?? '—'],
            ['Receipt lag', f.lagSec !== null ? `${f.lagSec} s after close` : '—'],
            ['Mapping status', f.mappingStatus ?? '—'],
            ['Rule set', rs.status ? `${rs.id} (${rs.status})` : rs.id],
          ]} />
          <div className="mt-1.5 flex items-center justify-between"><span className="text-ink-400">TS Qualified</span><StatusBadge s={qualificationStatus(r)} /></div>
        </Box>
        <Box title="Trade construction">
          <KV rows={[
            ['Entry', p(f.entry)], ['Stop', p(f.stop)], ['Target', p(f.target)], ['Quantity', f.shares === null ? '—' : String(f.shares)], ['Dollar risk', money(f.plannedRisk)],
            ['ATR(14) 5m', p(f.atr, 4)], ['Current price', p(f.currentPrice)],
            ['Chase distance', ch ? `${ch.distance >= 0 ? '+' : ''}${ch.distance.toFixed(2)} (${ch.distanceAtr.toFixed(2)} ATR)` : '—'],
            ['Allowed chase', ch ? `${ch.thresholdAtr} ATR = ${money(ch.thresholdDollars)}` : '—'],
          ]} />
          <div className="mt-1.5 flex items-center justify-between"><span className="text-ink-400">Chase status</span><StatusBadge s={chaseStatus(r)} /></div>
        </Box>
        <Box title="Data & diagnostics">
          <div className="mb-1 flex items-center justify-between"><span className="text-ink-400">Data status</span><StatusBadge s={dataStatus(r)} /></div>
          <KV rows={[
            ['SIP RVOL', f.sipRvol === null ? 'unavailable — non-blocking' : `${f.sipRvol.toFixed(2)} — diagnostic only`],
            ['v1.1 hard fails', f.hardFails.length ? f.hardFails.join(', ') : 'none'],
            ['Parity warnings', f.parity.length ? f.parity.map((w) => w.replace(/^PARITY_(WARNING|NOTE)[_:]?/, '')).join(', ') : 'none'],
          ]} />
          {f.issues.length > 0 && <ul className="mt-1.5 list-disc pl-4 text-[11px] text-warn">{f.issues.map((i) => <li key={i.code}>{i.kind}: {i.message}</li>)}</ul>}
          {f.errors.length > 0 && <ul className="mt-1.5 list-disc pl-4 text-[11px] text-short">{f.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
        </Box>
        <Box title="Portfolio & execution">
          <div className="mb-1 flex items-center justify-between"><span className="text-ink-400">Portfolio</span><StatusBadge s={portfolioStatus(r)} /></div>
          <KV rows={[
            ['Slots', f.portfolio ? `${f.portfolio.slotsUsed} / ${f.portfolio.maxPositions} used` : '—'],
            ['Heat (open + pending)', f.portfolio ? `${money(f.portfolio.heatCommitted)} / ${money(f.portfolio.heatLimit)}` : '—'],
            ['Heat (open)', f.portfolio ? money(f.portfolio.heatOpen) : '—'],
            ['Portfolio detail', portfolioStatus(r).detail],
          ]} />
          <div className="mt-2 rounded border border-ink-700 p-2">
            <div className="text-[10px] uppercase tracking-wider text-ink-400">Final execution state ({active?.version ?? 'active'})</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5"><StatusBadge s={{ label: fin.ticket ? 'TICKET' : 'NO TICKET', tone: fin.ticket ? 'ok' : fin.tone }} /><b className="text-ink-100">{fin.label}</b></div>
            <div className="text-[11px] text-ink-400">{fin.detail}</div>
          </div>
        </Box>
      </div>
      <details className="rounded-lg border border-ink-700 bg-ink-850 p-2.5">
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
                ['Market data through', r.record.marketDataThroughIso ? fmtEt(Date.parse(r.record.marketDataThroughIso)) : '—'],
                ['15m confirmation candle', s?.confirm15m ? `${s.confirm15m.label} (${s.confirm15m.bars5}/3 bars)` : '—'],
                ['Data provider', `${r.record.provider.name} · feed ${r.record.provider.feed.toUpperCase()}`],
                ['TrendSpider last price', a.lastPrice === null ? 'not supplied' : `$${p(a.lastPrice)}`],
                ['Provider price at alert', r.record.initialQuote ? `$${p(r.record.initialQuote.price)}` : '—'],
                ['Price difference', pm === null ? '—' : `$${Math.abs(pm).toFixed(2)}`],
                ['Current price age', ages ? `${ages.data.toFixed(1)} s (last trade ${ages.trade.toFixed(0)} s before fetch)` : '—'],
                ['Position value', r.candidate ? usd(r.candidate.positionValue, 0) : '—'],
                ['Calculator / ranker version', `${r.record.versions.rules} / ${r.record.versions.scoring}`],
                ['Strategy version', r.candidate?.initialScore?.strategyVersion ?? r.record.versions.strategy],
                ['Alert conditions reproduced', s?.alertConditions.length ? `${s.alertConditions.filter((c) => c.pass).length} / ${s.alertConditions.length}` : '—'],
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

const Box = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="rounded-lg border border-ink-700 bg-ink-850 p-2.5">
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
