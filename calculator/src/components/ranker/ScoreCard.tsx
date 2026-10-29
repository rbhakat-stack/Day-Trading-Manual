import type { RankedCandidate } from '../../engine/ranker/candidateRanker';
import { FIT_KEYS, SETUP_KEYS, type Recommendation } from '../../engine/ranker/opportunityTypes';
import { usd } from '../../lib/format';
import { Panel, toneClasses } from '../ui';
import { fmtScore, recTone, REC_HELP, ScoreBar } from './shared';

export function DecisionCard({ r }: { r: RankedCandidate | null }) {
  if (!r) {
    return (
      <section className="flex min-h-[12rem] flex-col items-center justify-center rounded-xl border border-ink-700 bg-ink-850 p-6 text-center">
        <div className="text-3xl font-black text-ink-600">— / 100</div>
        <p className="mt-2 text-sm text-ink-400">Select or send a candidate to see its opportunity score.</p>
      </section>
    );
  }
  const c = r.candidate;
  const status = r.displayStatus;
  const t = toneClasses[recTone(status)];
  const unscored = r.total === null;
  const belowThreshold = r.tier !== null && r.tier !== 'ELITE' && r.tier !== 'HIGH_PRIORITY';
  return (
    <section className={`rounded-xl border-2 p-5 ${t.card}`} aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-300">
            {c.ticker} · <span className={c.direction === 'LONG' ? 'text-long' : 'text-short'}>{c.direction}</span> · alert {c.alertTime} ET
          </div>
          <div className={`mt-1 text-3xl font-black leading-tight tracking-tight sm:text-4xl ${t.text}`}>{status}</div>
          {r.recommendation && <p className="mt-1 max-w-md text-sm text-ink-300">{REC_HELP[r.recommendation as Recommendation]}</p>}
          {!r.strategyEligible && (
            <ul className="mt-2 space-y-1">
              {r.hardFails.filter((f) => f.code !== 'NO_POSITION_SLOT' && f.code !== 'CAPITAL_LIMIT' && f.code !== 'PORTFOLIO_HEAT_LIMIT' && f.code !== 'CORRELATION_LIMIT').map((f, i) => (
                <li key={i} className="rounded-md bg-short-dim px-2 py-1 text-xs text-[#ffc2cd]">
                  <span className="font-bold uppercase tracking-wider text-short">{f.label}</span> — {f.reason}
                </li>
              ))}
            </ul>
          )}
          {r.strategyEligible && !r.complete && (
            <p className="mt-2 rounded-md bg-warn-dim px-2 py-1 text-xs text-[#ffe2a8]">
              <span className="font-bold uppercase tracking-wider text-warn">Missing input — score incomplete:</span> {r.missing.join(', ')}
            </p>
          )}
          {r.strategyEligible && r.eligible === false && r.complete && (
            <p className="mt-2 inline-block rounded-md bg-short-dim px-2 py-1 text-xs font-bold uppercase tracking-wider text-short">
              Portfolio hard rule failed — a score cannot override it
            </p>
          )}
        </div>
        <div className="text-right">
          <div className={`num text-5xl font-black leading-none ${unscored ? 'text-ink-600' : r.eligible ? 'text-ink-100' : 'text-ink-400 line-through decoration-short/70'}`}>
            {unscored ? '—' : fmtScore(r.total)}
            <span className="text-xl font-semibold text-ink-400"> / 100</span>
          </div>
          {unscored && <div className="mt-1 text-xs font-semibold uppercase tracking-wider text-ink-400">{r.strategyEligible ? 'No score until inputs are complete' : 'Not scored — not eligible'}</div>}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Mini label="Rank (relative)" value={r.rank ? `#${r.rank} of ${r.rankOf}` : '—'} sub={r.rank ? 'active candidates' : 'not ranked'} />
        <Mini label="Required capital" value={usd(c.positionValue, 0)} sub={Number.isFinite(r.capitalRequiredPct) ? `${(r.capitalRequiredPct * 100).toFixed(0)}% of available` : 'no capital available'} />
        <Mini label="Setup quality" value={unscored ? '—' : `${fmtScore(r.setup)} / 70`} />
        <Mini label="Portfolio fit" value={unscored ? '—' : `${fmtScore(r.fit)} / 30`} />
      </div>
      <div className={`mt-3 rounded-lg border px-3 py-2 text-sm ${!r.eligible || belowThreshold || unscored ? 'border-short/50 bg-short-dim/40' : 'border-long/50 bg-long-dim/40'}`}>
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-300">Eligibility (absolute): </span>
        <span className={`font-bold ${!r.eligible || belowThreshold || unscored ? 'text-short' : 'text-long'}`}>{r.eligibilityLabel}</span>
        {belowThreshold && r.rank === 1 && <span className="ml-2 text-xs text-ink-300">Ranking #1 does not make a below-threshold setup tradeable.</span>}
      </div>
    </section>
  );
}

function Mini({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-ink-900/70 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-400">{label}</div>
      <div className="num text-lg font-semibold text-ink-100">{value}</div>
      {sub && <div className="text-[11px] text-ink-400">{sub}</div>}
    </div>
  );
}

export function BreakdownCard({ r }: { r: RankedCandidate }) {
  const comp = (keys: typeof SETUP_KEYS) => r.components.filter((x) => keys.includes(x.key));
  return (
    <div className="space-y-4">
      <Panel title="Hard rules — pass / fail (cannot be overcome by score)">
        <ul className="grid gap-1 sm:grid-cols-2">
          {r.hardRules.map((h) => (
            <li key={h.key} className="flex items-start gap-2 text-sm">
              <span className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-black ${h.pass ? 'bg-long-dim text-long' : 'bg-short text-ink-950'}`}>
                {h.pass ? '✓' : '✕'}
              </span>
              <span className={h.pass ? 'text-ink-300' : 'font-semibold text-short'}>
                {h.label}
                {!h.pass && <span className="block text-xs font-normal text-[#ffc2cd]">{h.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title={`Quality score — ranks candidates only after hard rules pass`}>
        {r.total === null && (
          <p className="mb-2 text-sm text-warn">
            {r.strategyEligible ? `SCORING INCOMPLETE — missing: ${r.missing.join(', ')}. Component values below are not a score.` : 'NOT ELIGIBLE — CANNOT BE RANKED. Component values below are shown for learning only and are not a score.'}
          </p>
        )}
        <div className="grid gap-5 md:grid-cols-2">
          <ComponentList title={`Setup quality ${fmtScore(r.setup)} / 70`} items={comp(SETUP_KEYS)} />
          <ComponentList title={`Portfolio fit ${fmtScore(r.fit)} / 30`} items={comp(FIT_KEYS)} />
        </div>
      </Panel>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Why this ranks highly">
          {r.reasonsFor.length ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink-200">{r.reasonsFor.map((x, i) => <li key={i}>{x}</li>)}</ul>
          ) : (
            <p className="text-sm text-ink-400">No standout strengths.</p>
          )}
        </Panel>
        <Panel title="What reduces the score">
          {r.reasonsAgainst.length ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-[#ffd6a8]">{r.reasonsAgainst.map((x, i) => <li key={i}>{x}</li>)}</ul>
          ) : (
            <p className="text-sm text-ink-400">Nothing material.</p>
          )}
        </Panel>
      </div>

      <details className="rounded-xl border border-ink-700 bg-ink-850">
        <summary className="cursor-pointer select-none px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-300 hover:text-ink-100">
          Show score calculation
        </summary>
        <div className="num space-y-3 border-t border-ink-700 px-4 py-3 text-[12.5px] text-ink-200">
          {r.components.map((x) => (
            <div key={x.key}>
              <div className="font-sans text-xs font-semibold uppercase tracking-wider text-ink-400">{x.label} — {x.na ?? `${fmtScore(x.points)} / ${x.max}`}</div>
              <ul className="mt-0.5 space-y-0.5">{x.calc.map((l, i) => <li key={i}>{l}</li>)}</ul>
            </div>
          ))}
          <div className="font-sans text-xs text-ink-400">Distances are divided by the 5-minute ATR so stocks at different prices are comparable. All weights and bands are RB v1 paper-testing assumptions.</div>
        </div>
      </details>
    </div>
  );
}

function ComponentList({ title, items }: { title: string; items: RankedCandidate['components'] }) {
  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-200">{title}</div>
      <ul className="space-y-2.5">
        {items.map((x) => {
          const frac = x.max > 0 ? x.points / x.max : 0;
          return (
            <li key={x.key}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="text-ink-200">{x.label}</span>
                {x.na ? (
                  <span className="text-xs font-bold uppercase tracking-wider text-short">N/A</span>
                ) : (
                  <span className="num font-semibold text-ink-100">{fmtScore(x.points)}<span className="text-ink-500">/{x.max}</span></span>
                )}
              </div>
              <ScoreBar points={x.na ? 0 : x.points} max={x.max} tone={x.missing || x.na ? 'bg-ink-500' : frac >= 0.8 ? 'bg-long' : frac >= 0.5 ? 'bg-[#5b8cff]' : 'bg-warn'} />
              <div className={`mt-0.5 text-xs ${x.na ? 'font-semibold text-short' : x.missing ? 'text-warn' : 'text-ink-400'}`}>{x.summary}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
