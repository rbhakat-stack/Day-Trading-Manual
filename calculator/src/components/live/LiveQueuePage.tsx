import { Fragment, useState } from 'react';
import { ticketString, type FreshnessBand, type QueueSection, type TrendSpiderTicket } from '../../engine/automation/alertDecision';
import type { QueueRow } from '../../engine/automation/liveQueue';
import type { Classification } from '../../engine/automation/autoCandidate';
import { fmtEt, mmss } from '../../engine/automation/etTime';
import type { ReplacementSuggestion } from '../../engine/ranker/candidateRanker';
import { FIT_KEYS, SETUP_KEYS } from '../../engine/ranker/opportunityTypes';
import { usd } from '../../lib/format';
import { Panel } from '../ui';
import { SuggestionCard } from '../ranker/FitPanel';

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
}

const SECTIONS: { id: QueueSection; title: string; hint: string }[] = [
  { id: 'ACTION_NOW', title: 'Action now — score ≥ 90', hint: 'Eligible, allocated, fresh data. Enter the TrendSpider order manually.' },
  { id: 'HIGH_PRIORITY', title: 'High priority — score 85–89', hint: 'Eligible and allocated after higher-ranked candidates.' },
  { id: 'DATA_REVIEW', title: 'Data review required', hint: 'Data incomplete, mismatched or stale — no ticket until resolved.' },
  { id: 'SCORING', title: 'Scoring', hint: 'Received; waiting for market data and simultaneous alerts (micro-batch).' },
  { id: 'ACTIVE', title: 'Submitted orders and positions', hint: 'You marked these submitted / filled. Never displaced.' },
  { id: 'WATCHLIST', title: 'Watchlist', hint: 'Score 80–84, or ≥ 85 without capital / slot / correlation room, or a crossed trigger needing review.' },
  { id: 'IGNORE', title: 'Ignore / skip', hint: 'Below 80, hard-rule failures, stale, chased, duplicates.' },
  { id: 'CLOSED', title: 'Closed', hint: '' },
];

const bandTone: Record<FreshnessBand, string> = { FRESH: 'text-long', AGING: 'text-warn', URGENT: 'text-[#ff9f5a]', STALE: 'text-short' };
const p = (x: number | null | undefined, dp = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(x < 1 ? 4 : dp));

export function LiveQueuePage({ rows, suggestions, now, enabled, feed, quoteError, parityStatus, versionLabel, actions, onOpenSettings }: Props) {
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
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold tracking-tight text-ink-100">Live Alert Queue</h2>
          <p className="text-xs text-ink-400">
            Automated analysis only — <b className="text-ink-200">manual execution</b>. Nothing is sent to TrendSpider, SignalStack, Alpaca or any broker. Values are <i>Automated Market Data Values</i>, not TrendSpider values.
          </p>
          <p className="mt-0.5 text-[10px] font-bold uppercase tracking-wider text-[#a9c1ff]">{versionLabel}</p>
        </div>
        <div className="text-right text-xs text-ink-400">
          <div>Feed: {feed.error ? <span className="text-short">{feed.error}</span> : feed.lastOkMs ? `updated ${Math.max(0, Math.round((now - feed.lastOkMs) / 1000))} s ago` : 'connecting…'}</div>
          {quoteError && <div className="text-short">Prices: {quoteError}</div>}
          <div>Data parity: <span className={parityStatus === 'VALIDATED' ? 'text-long' : 'text-warn'}>{parityStatus}</span></div>
        </div>
      </div>

      {parityStatus !== 'VALIDATED' && (
        <p className="rounded-lg border border-warn/50 bg-warn-dim/30 px-4 py-2 text-sm text-[#ffe2a8]">
          <b>Data parity not yet validated.</b> Until 20+ alerts have been compared with TrendSpider (Data validation tab) with no mismatch, check every value against your chart before submitting.
        </p>
      )}

      {stronger.length > 0 && <div className="grid gap-3 lg:grid-cols-2">{stronger.map((sg) => <SuggestionCard key={`${sg.pendingId}-${sg.candidateId}`} sg={sg} onKeep={actions.keep} onReplace={actions.replace} />)}</div>}

      {actionable.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {actionable.map((r) => <ActionCard key={r.record.id} r={r} actions={actions} />)}
        </div>
      )}

      {SECTIONS.map((s) => {
        const xs = rows.filter((r) => r.decision.section === s.id);
        if (!xs.length) return null;
        return (
          <Panel key={s.id} title={`${s.title} (${xs.length})`} right={<span className="text-[11px] text-ink-400">{s.hint}</span>}>
            <QueueTable rows={xs} now={now} actions={actions} />
          </Panel>
        );
      })}
      {rows.length === 0 && (
        <Panel title="No alerts yet today">
          <p className="text-sm text-ink-400">Waiting for TrendSpider webhooks. A test alert can be sent as described in AUTOMATION.md.</p>
        </Panel>
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

/* ───────────────────────── table + expandable details ───────────────────────── */

function QueueTable({ rows, now, actions }: { rows: QueueRow[]; now: number; actions: LiveActions }) {
  const [open, setOpen] = useState<string | null>(null);
  const head = ['Rank', 'Ticker', 'Side', 'Score', 'Decision', 'Alert', 'Age', 'Entry', 'Stop', 'Target', 'Qty', 'Value', 'Planned risk', 'Current', 'To trigger', 'Status'];
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="num w-full min-w-[1100px] text-[12.5px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-ink-400">{head.map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const c = r.candidate;
            const ch = r.live?.chase;
            const id = r.record.id;
            return (
              <Fragment key={id}>
                <tr className="cursor-pointer border-t border-ink-700/60 hover:bg-ink-800" onClick={() => setOpen(open === id ? null : id)} aria-expanded={open === id}>
                  <td className="px-2 py-1.5 font-bold">{r.ranked?.rank ? `#${r.ranked.rank}` : '—'}</td>
                  <td className="px-2 py-1.5 font-semibold">{r.record.alert.symbol}</td>
                  <td className={`px-2 py-1.5 ${r.record.alert.direction === 'LONG' ? 'text-long' : 'text-short'}`}>{r.record.alert.direction}</td>
                  <td className="px-2 py-1.5 font-bold">{r.ranked?.total ?? '—'}</td>
                  <td className="px-2 py-1.5 font-sans">
                    <div className="font-semibold">{r.decision.decision}</div>
                    <div className="text-[11px] text-ink-400">{r.decision.detail}</div>
                  </td>
                  <td className="px-2 py-1.5">{fmtEt(r.record.alert.alertTimeMs).replace(' ET', '')}</td>
                  <td className={`px-2 py-1.5 ${bandTone[r.decision.freshness.band]}`}>{mmss(r.decision.freshness.ageMs)}</td>
                  <td className="px-2 py-1.5">{p(c?.entry)}</td>
                  <td className="px-2 py-1.5">{p(c?.stop)}</td>
                  <td className="px-2 py-1.5">{p(c?.target)}</td>
                  <td className="px-2 py-1.5">{c?.shares ?? '—'}</td>
                  <td className="px-2 py-1.5">{c ? usd(c.positionValue, 0) : '—'}</td>
                  <td className="px-2 py-1.5">{c ? usd(c.plannedRisk) : '—'}</td>
                  <td className="px-2 py-1.5">{p(r.quote?.price ?? c?.currentPrice)}</td>
                  <td className="px-2 py-1.5">{ch ? `${ch.distance >= 0 ? '+' : ''}${ch.distance.toFixed(2)} (${ch.distanceAtr.toFixed(2)} ATR)` : '—'}</td>
                  <td className="px-2 py-1.5 font-sans text-[11px]">{c?.status ?? r.record.status}</td>
                </tr>
                {open === id && (
                  <tr className="bg-ink-900/60">
                    <td colSpan={head.length} className="px-3 py-3">
                      <Details r={r} now={now} actions={actions} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Details({ r, now, actions }: { r: QueueRow; now: number; actions: LiveActions }) {
  const v = r.record.snapshot?.values;
  const s = r.record.snapshot;
  const a = r.record.alert;
  const [cls, setCls] = useState({ sector: r.candidate?.inputs.sector ?? '', industry: r.candidate?.inputs.industry ?? '', theme: r.candidate?.inputs.theme ?? '' });
  const pm = a.lastPrice !== null && r.record.initialQuote ? a.lastPrice - r.record.initialQuote.price : null;
  const ages = r.quote ? { data: (now - r.quote.receivedMs) / 1000, trade: (Date.parse(r.quote.fetchedIso) - Date.parse(r.quote.tradeIso)) / 1000 } : null;
  const canAct = r.candidate && ['NEW', 'WATCHLIST'].includes(r.candidate.status);
  return (
    <div className="space-y-3 font-sans text-[12.5px]">
      {r.decision.reasons.length > 0 && <ul className="list-disc space-y-0.5 pl-5 text-[#ffd6a8]">{r.decision.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>}
      <div className="flex flex-wrap gap-2">
        {r.decision.ticket && <button type="button" onClick={() => actions.submit(r.record.id)} className="rounded bg-long px-2.5 py-1 text-xs font-bold text-ink-950">Mark order submitted</button>}
        {canAct && <button type="button" onClick={() => actions.watch(r.record.id)} className="rounded border border-ink-600 px-2.5 py-1 text-xs">Watch</button>}
        {canAct && <button type="button" onClick={() => actions.skip(r.record.id)} className="rounded border border-ink-600 px-2.5 py-1 text-xs">Skip trade</button>}
        {v && <button type="button" onClick={() => actions.openInCalculator(r)} className="rounded border border-ink-600 px-2.5 py-1 text-xs">Open in manual Calculator</button>}
        {(r.record.status === 'DATA_ERROR' || r.record.status === 'RECEIVED') && <button type="button" onClick={() => actions.reprocess(r.record.id)} className="rounded border border-warn px-2.5 py-1 text-xs text-warn">Retry market data</button>}
      </div>
      {r.decision.detail === 'SCORING INCOMPLETE' && (
        <div className="flex flex-wrap items-end gap-2 rounded border border-warn/40 p-2">
          <span className="text-xs text-warn">Classify {a.symbol} once (remembered):</span>
          {(['sector', 'industry', 'theme'] as const).map((k) => (
            <input key={k} placeholder={k} value={cls[k]} onChange={(e) => setCls({ ...cls, [k]: e.target.value })} className="w-36 rounded border border-ink-600 bg-ink-900 px-2 py-1" />
          ))}
          <button type="button" disabled={!cls.sector.trim()} onClick={() => actions.classify(a.symbol, { sector: cls.sector.trim(), industry: cls.industry.trim(), theme: cls.theme.trim() })} className="rounded bg-[#3d6df2] px-2.5 py-1 text-xs font-bold text-white disabled:opacity-40">Save</button>
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-4">
        <Box title="Alert-time indicators (automated market data values)">
          {v ? (
            <KV rows={[['Signal candle', s?.signal?.label ?? '—'], ['O / H / L / C', `${p(v.open)} / ${p(v.high)} / ${p(v.low)} / ${p(v.close)}`], ['ATR(14) 5m', p(v.atr, 4)], ['EMA9 / EMA20', `${p(v.ema9, 3)} / ${p(v.ema20, 3)}`], ['RSI14', p(v.rsi, 1)], ['RVOL20', p(v.rvol, 2)], [`VWAP (${s?.config.vwapMode})`, p(v.vwap, 3)], ['VWAP (other mode)', p(v.vwapAlternative, 3)], ['15m candle', s?.confirm15m?.label ?? '—'], ['15m Close / EMA20', `${p(v.close15m)} / ${p(v.ema20_15m, 3)}`]]} />
          ) : (
            <p className="text-warn">No complete snapshot.</p>
          )}
          {s?.issues.length ? <ul className="mt-2 list-disc pl-4 text-[11px] text-warn">{s.issues.map((i) => <li key={i.code}>{i.kind}: {i.message}</li>)}</ul> : null}
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
          <KV
            rows={[
              ['Alert time', `${fmtEt(a.alertTimeMs)}${a.timeSource === 'RECEIVED' ? ' (server receipt — TrendSpider sent no time)' : ''}`],
              ['Alert received', fmtEt(r.record.receivedMs)],
              ['Market data through', r.record.marketDataThroughIso ? fmtEt(Date.parse(r.record.marketDataThroughIso)) : '—'],
              ['Signal candle', s?.signal?.label ?? '—'],
              ['15m confirmation candle', s?.confirm15m ? `${s.confirm15m.label} (${s.confirm15m.bars5}/3 bars)` : '—'],
              ['Data provider', `${r.record.provider.name} · feed ${r.record.provider.feed.toUpperCase()}`],
              ['TrendSpider last price', a.lastPrice === null ? 'not supplied' : `$${p(a.lastPrice)}`],
              ['Provider price at alert', r.record.initialQuote ? `$${p(r.record.initialQuote.price)}` : '—'],
              ['Price difference', pm === null ? '—' : `$${Math.abs(pm).toFixed(2)}`],
              ['Current price age', ages ? `${ages.data.toFixed(1)} s (last trade ${ages.trade.toFixed(0)} s before fetch)` : '—'],
              ['Calculator version', r.record.versions.rules],
              ['Ranker version', r.record.versions.scoring],
              ['Strategy version', r.candidate?.initialScore?.strategyVersion ?? r.record.versions.strategy],
              ['Alert conditions reproduced', s?.alertConditions.length ? `${s.alertConditions.filter((c) => c.pass).length} / ${s.alertConditions.length}` : '—'],
            ]}
          />
        </Box>
      </div>
      {r.live?.plan && (
        <Box title="Calculation (shared RB v1.1 calculator)">
          <p className="num">
            Buffer {p(r.live.plan.buffer)} → Entry {p(r.live.plan.entry)} · structural {p(r.live.plan.structuralRisk, 4)} vs ATR {p(r.live.plan.atrRisk, 4)} → R {p(r.live.plan.riskPerShare)} ({r.live.plan.riskMethod}) · Stop {p(r.live.plan.stop)} · Target {p(r.live.plan.target)} · shares MIN({r.live.plan.riskShares}, {r.live.plan.investmentShares}) = {r.live.plan.shares} · {r.live.headline}
          </p>
        </Box>
      )}
    </div>
  );
}

const Box = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="rounded-lg border border-ink-700 bg-ink-850 p-2.5">
    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-400">{title}</div>
    {children}
  </div>
);

const KV = ({ rows }: { rows: [string, string][] }) => (
  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
    {rows.map(([k, v]) => (
      <Fragment key={k}>
        <dt className="text-ink-400">{k}</dt>
        <dd className="num text-right text-ink-100">{v}</dd>
      </Fragment>
    ))}
  </dl>
);
