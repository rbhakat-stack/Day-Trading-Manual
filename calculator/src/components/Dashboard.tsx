import { computeMetrics, type GroupStats, type JournalEntry } from '../engine/journal';
import { pct, signedR, signedUsd, usd } from '../lib/format';
import { Panel, Stat } from './ui';

export function Dashboard({ entries, failLabels }: { entries: JournalEntry[]; failLabels: Record<string, string> }) {
  const m = computeMetrics(entries);
  const reasons = new Map<string, number>();
  for (const e of entries) for (const code of e.hardFailCodes ?? []) reasons.set(code, (reasons.get(code) ?? 0) + 1);
  if (m.totalEntries === 0) {
    return (
      <Panel title="Performance dashboard">
        <p className="py-10 text-center text-sm text-ink-400">No journal entries yet.</p>
      </Panel>
    );
  }
  const sample =
    m.closedTrades < 20 ? 'Fewer than 20 closed trades: this validates your workflow, not the strategy.'
      : m.closedTrades < 50 ? '20–49 closed trades: still too few to judge the strategy.'
        : m.closedTrades < 100 ? '50–99 closed trades: an early signal only.'
          : '100+ closed trades: more useful evidence. Paper results still differ from live results.';
  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-ink-700 bg-ink-850 px-4 py-2.5 text-sm text-ink-300">{sample}</p>
      <Panel title="Summary">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4 lg:grid-cols-6">
          <Stat label="Total entries" value={m.totalEntries} />
          <Stat label="Closed trades" value={m.closedTrades} />
          <Stat label="Wins" value={m.wins} tone="long" />
          <Stat label="Losses" value={m.losses} tone="short" />
          <Stat label="Skipped" value={m.skipped} />
          <Stat label="Never triggered" value={m.neverTriggered} />
          <Stat label="Win rate" value={pct(m.winRate, 1)} big />
          <Stat label="Average R" value={signedR(m.averageR)} big tone={m.averageR > 0 ? 'long' : m.averageR < 0 ? 'short' : undefined} />
          <Stat label="Total R" value={signedR(m.totalR)} big tone={m.totalR > 0 ? 'long' : m.totalR < 0 ? 'short' : undefined} />
          <Stat label="Total P/L" value={signedUsd(m.totalPnl)} big tone={m.totalPnl > 0 ? 'long' : m.totalPnl < 0 ? 'short' : undefined} />
          <Stat label="Profit factor" value={m.profitFactor === null ? '— (no losses)' : m.profitFactor.toFixed(2)} big />
          <Stat label="Max drawdown" value={usd(m.maxDrawdown)} sub={`${m.maxDrawdownR.toFixed(2)}R`} big tone="short" />
          <Stat label="Average winner" value={m.wins ? signedUsd(m.averageWinner) : '—'} sub={m.wins ? signedR(m.averageWinnerR) : undefined} tone="long" />
          <Stat label="Average loser" value={m.losses ? signedUsd(m.averageLoser) : '—'} sub={m.losses ? signedR(m.averageLoserR) : undefined} tone="short" />
          <Stat label="Avg planned risk" value={usd(m.averagePlannedRisk)} />
          <Stat label="Avg actual loss" value={usd(m.averageActualLoss)} />
          <Stat label="Open / pending" value={m.open} />
          <Stat label="Canceled" value={m.canceled} />
        </div>
      </Panel>
      {reasons.size > 0 && (
        <Panel title="Not-eligible reasons (central hard rules)">
          <ul className="grid gap-1 text-sm sm:grid-cols-2">
            {[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([code, n]) => (
              <li key={code} className="flex justify-between gap-3 border-b border-ink-700/60 py-1">
                <span className="text-ink-200">{failLabels[code] ?? code}</span>
                <span className="num text-ink-100">{n}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <GroupTable title="LONG vs SHORT" rows={m.byDirection} />
        <GroupTable title="By time of day (ET)" rows={m.byTimeOfDay} />
        <GroupTable title="By ticker" rows={m.byTicker} />
      </div>
    </div>
  );
}

function GroupTable({ title, rows }: { title: string; rows: GroupStats[] }) {
  return (
    <Panel title={title}>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-400">No closed trades.</p>
      ) : (
        <table className="num w-full text-[13px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-ink-400">
              <th className="py-1 font-medium">Group</th>
              <th className="py-1 text-right font-medium">Trades</th>
              <th className="py-1 text-right font-medium">Win %</th>
              <th className="py-1 text-right font-medium">Total R</th>
              <th className="py-1 text-right font-medium">P/L</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <tr key={g.key} className="border-t border-ink-700/60">
                <td className="py-1 font-sans text-ink-200">{g.key}</td>
                <td className="py-1 text-right">{g.trades}</td>
                <td className="py-1 text-right">{pct(g.winRate, 0)}</td>
                <td className={`py-1 text-right ${g.totalR > 0 ? 'text-long' : g.totalR < 0 ? 'text-short' : ''}`}>{signedR(g.totalR)}</td>
                <td className={`py-1 text-right ${g.totalPnl > 0 ? 'text-long' : g.totalPnl < 0 ? 'text-short' : ''}`}>{signedUsd(g.totalPnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
