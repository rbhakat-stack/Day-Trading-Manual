import { useState } from 'react';
import type { BucketStats } from '../../engine/ranker/rankerAnalytics';
import { candidatePnl, candidateR, candidateVersion, closedScoredTrades, performanceByComponent, performanceByScoreBucket, performanceByTimeBucket } from '../../engine/ranker/rankerAnalytics';
import { LIFECYCLE_LABELS, type Candidate } from '../../engine/ranker/opportunityTypes';
import type { RankerSettings } from '../../engine/ranker/rankerSettings';
import { pct, signedR, signedUsd } from '../../lib/format';
import { Panel } from '../ui';

export function AnalyticsView({ candidates, s, today, versionLabel, currentVersion, onArchiveToday }: {
  candidates: Candidate[]; s: RankerSettings; today: string; versionLabel: string; currentVersion: string; onArchiveToday: () => void;
}) {
  const versions = [...new Set(candidates.map(candidateVersion).filter((v): v is string => !!v))].sort();
  const [vf, setVf] = useState<string>(versions.includes(currentVersion) ? currentVersion : 'ALL');
  // Only compare like with like: by default the analytics use candidates scored under the current version.
  const pool = vf === 'ALL' ? candidates : candidates.filter((c) => candidateVersion(c) === vf);
  const closed = closedScoredTrades(pool);
  const byScore = performanceByScoreBucket(pool, s);
  const byComp = performanceByComponent(pool, s);
  const byTime = performanceByTimeBucket(pool, s);
  const history = [...candidates].filter((c) => c.archived || c.date !== today).sort((a, b) => `${b.date} ${b.alertTime}`.localeCompare(`${a.date} ${a.alertTime}`));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="rounded px-2 py-1 text-[11px] font-bold uppercase tracking-wider bg-[#5b8cff]/20 text-[#a9c1ff]">{versionLabel}</span>
        <label className="flex items-center gap-2 text-xs text-ink-300">
          Strategy version
          <select value={vf} onChange={(e) => setVf(e.target.value)} className="rounded border border-ink-600 bg-ink-900 px-2 py-1 text-[13px] text-ink-100">
            {versions.map((v) => <option key={v} value={v}>{v}</option>)}
            <option value="ALL">All versions (mixed — use with care)</option>
          </select>
        </label>
      </div>
      <p className="rounded-lg border border-ink-700 bg-ink-850 px-4 py-2.5 text-sm text-ink-300">
        Consider a broader strategy review after approximately <b>100+ closed paper trades</b>, while individual score buckets should ideally contain at least{' '}
        <b>{s.minSampleForAnalysis} closed trades</b> before drawing strong conclusions. This is guidance only: no setting changes automatically, and a single winning or losing trade is not a reason to change the model.
      </p>
      <p className="rounded-lg border border-warn/40 bg-warn-dim/30 px-4 py-2.5 text-sm text-[#ffe2a8]">
        {closed.length} closed, scored trade(s){vf === 'ALL' ? '' : ` under ${vf}`}. Buckets with fewer than {s.minSampleForAnalysis} closed trades are ANECDOTAL / SAMPLE TOO SMALL: do not change weights based on them.
        Analytics use the <b>initial</b> score frozen when each candidate was first scored. Scores are never rewritten after the outcome.
      </p>
      <Panel title="Do higher-scoring RB v1 setups perform better? — by initial opportunity score">
        <StatsTable rows={byScore} first="Score" />
      </Panel>
      <Panel title="By component (share of the component's maximum at scoring time)">
        <div className="-mx-4 overflow-x-auto">
          <table className="num w-full min-w-[760px] text-[13px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-ink-400">
                <th className="px-2 py-1.5 font-medium">Component</th>
                {['High ≥80%', 'Mid 50–79%', 'Low <50%'].map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}: trades · win% · avg R</th>)}
              </tr>
            </thead>
            <tbody>
              {byComp.map((c) => (
                <tr key={c.key} className="border-t border-ink-700/60">
                  <td className="px-2 py-1.5 font-sans text-ink-200">{c.label}</td>
                  {[c.high, c.mid, c.low].map((b, i) => (
                    <td key={i} className={`px-2 py-1.5 ${b.sufficient ? 'text-ink-100' : 'text-ink-400'}`}>
                      {b.trades ? `${b.trades} · ${pct(b.winRate, 0)} · ${signedR(b.averageR)}` : '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="By time-of-day bucket (validates the time assumptions)">
        <StatsTable rows={byTime} first="Bucket" />
      </Panel>
      <Panel
        title={`History (${history.length})`}
        right={<button type="button" onClick={() => confirm("Archive today's queue into history? Open/pending items stay in your portfolio until you close them.") && onArchiveToday()} className="rounded-md bg-ink-700 px-2.5 py-1 text-xs text-ink-100 hover:bg-ink-600">Archive today's queue</button>}
      >
        {history.length === 0 ? (
          <p className="text-sm text-ink-400">No archived days yet. Each candidate's date separates days automatically; use “Archive today's queue” after the close.</p>
        ) : (
          <div className="-mx-4 overflow-x-auto">
            <table className="num w-full min-w-[760px] text-[13px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-ink-400">
                  {['Date', 'Alert', 'Ticker', 'Side', 'Version', 'Initial score', 'Entry score', 'Outcome', 'P/L', 'R'].map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {history.map((c) => {
                  const pnl = candidatePnl(c);
                  const r = candidateR(c);
                  return (
                    <tr key={c.id} className="border-t border-ink-700/60">
                      <td className="px-2 py-1.5">{c.date}</td>
                      <td className="px-2 py-1.5">{c.alertTime}</td>
                      <td className="px-2 py-1.5 font-semibold">{c.ticker}</td>
                      <td className={`px-2 py-1.5 ${c.direction === 'LONG' ? 'text-long' : 'text-short'}`}>{c.direction}</td>
                      <td className="px-2 py-1.5 font-sans text-xs">{candidateVersion(c) ?? '—'}</td>
                      <td className="px-2 py-1.5">{c.initialScore?.total ?? '—'}</td>
                      <td className="px-2 py-1.5">{c.entryScore?.total ?? '—'}</td>
                      <td className="px-2 py-1.5 font-sans">{LIFECYCLE_LABELS[c.status]}</td>
                      <td className={`px-2 py-1.5 ${pnl === null ? 'text-ink-500' : pnl > 0 ? 'text-long' : 'text-short'}`}>{pnl === null ? '—' : signedUsd(pnl)}</td>
                      <td className={`px-2 py-1.5 ${r === null ? 'text-ink-500' : r > 0 ? 'text-long' : 'text-short'}`}>{r === null ? '—' : signedR(r)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function StatsTable({ rows, first }: { rows: BucketStats[]; first: string }) {
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="num w-full min-w-[620px] text-[13px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-ink-400">
            {[first, 'Trades', 'Win rate', 'Average R', 'Total R', 'Profit factor', 'Sample'].map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.label} className="border-t border-ink-700/60">
              <td className="px-2 py-1.5 font-sans text-ink-200">{b.label}</td>
              <td className="px-2 py-1.5">{b.trades}</td>
              <td className="px-2 py-1.5">{b.trades ? pct(b.winRate, 0) : '—'}</td>
              <td className={`px-2 py-1.5 ${b.averageR > 0 ? 'text-long' : b.averageR < 0 ? 'text-short' : ''}`}>{b.trades ? signedR(b.averageR) : '—'}</td>
              <td className={`px-2 py-1.5 ${b.totalR > 0 ? 'text-long' : b.totalR < 0 ? 'text-short' : ''}`}>{b.trades ? signedR(b.totalR) : '—'}</td>
              <td className="px-2 py-1.5">{b.profitFactor === null ? '—' : b.profitFactor.toFixed(2)}</td>
              <td className={`px-2 py-1.5 font-sans text-xs ${b.sufficient ? 'text-long' : 'text-ink-500'}`}>{b.sufficient ? 'meaningful' : b.trades ? 'anecdotal — sample too small' : 'no data'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
