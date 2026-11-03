import { useState } from 'react';
import { activeEntries, computeMetrics, isClosedTrade, journalScope, tradeR, type GroupStats, type JournalEntry, type JournalScope } from '../engine/journal';
import { pct, signedR, signedUsd, usd } from '../lib/format';
import { Panel, Stat } from './ui';

const SCOPES: [JournalScope, string][] = [['ALL', 'All trades'], ['RB_STRATEGY', 'RB strategy trades'], ['MANUAL_OVERRIDE', 'Manual overrides']];

export function Dashboard({ entries: rawEntries, failLabels }: { entries: JournalEntry[]; failLabels: Record<string, string> }) {
  // CR-15: a superseded row (an exit recorded as its own trade before reconciliation) is audit-only — never counted.
  const allEntries = activeEntries(rawEntries);
  // Scope filter: manual overrides (trades taken although RB did not ticket them) never mix into strategy-only metrics.
  const [scope, setScope] = useState<JournalScope>('ALL');
  const entries = journalScope(allEntries, scope);
  const dupes = entries.filter((e) => e.possibleDuplicateOf).length;
  const scopeBar = (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Dashboard scope">
      {SCOPES.map(([s, label]) => (
        <button key={s} type="button" aria-pressed={scope === s} onClick={() => setScope(s)} className={`rounded-lg border px-3 py-1.5 text-[13px] font-semibold ${scope === s ? 'border-[#3d7bff] bg-[#2563eb] text-white' : 'border-ink-600 bg-ink-900 text-ink-200 hover:bg-ink-800'}`}>
          {label} ({journalScope(allEntries, s).length})
        </button>
      ))}
      <span className="text-[12px] text-ink-400">Journal data is stored only in this browser. Use Backup JSON regularly.</span>
    </div>
  );
  const m = computeMetrics(entries);
  // R needs a planned risk; when no closed trade in this view has one, R figures are unavailable (never shown as 0R).
  const hasR = entries.some((e) => isClosedTrade(e) && tradeR(e) !== null);
  const r = (x: number) => (hasR ? signedR(x) : '— (no planned risk)');
  const reasons = new Map<string, number>();
  for (const e of entries) for (const code of e.hardFailCodes ?? []) reasons.set(code, (reasons.get(code) ?? 0) + 1);
  if (m.totalEntries === 0) {
    return (
      <div className="space-y-4">
        {allEntries.length > 0 && scopeBar}
        <Panel title="Performance dashboard">
          <p className="py-10 text-center text-sm text-ink-400">{allEntries.length ? 'No journal entries in this view.' : 'No journal entries yet.'}</p>
        </Panel>
      </div>
    );
  }
  const sample =
    m.closedTrades < 20 ? 'Fewer than 20 closed trades: this validates your workflow, not the strategy.'
      : m.closedTrades < 50 ? '20–49 closed trades: still too few to judge the strategy.'
        : m.closedTrades < 100 ? '50–99 closed trades: an early signal only.'
          : '100+ closed trades: more useful evidence. Paper results still differ from live results.';
  return (
    <div className="space-y-4">
      {scopeBar}
      {dupes > 0 && <p className="rounded-lg border border-short/60 bg-short-dim/20 px-4 py-2 text-sm text-[#ffc0c8]">{dupes} broker-synced entr{dupes === 1 ? 'y looks' : 'ies look'} like a trade you also logged manually — it may be counted twice. Resolve it in the Journal.</p>}
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
          <Stat label="Average R" value={r(m.averageR)} big tone={m.averageR > 0 ? 'long' : m.averageR < 0 ? 'short' : undefined} />
          <Stat label="Total R" value={r(m.totalR)} big tone={m.totalR > 0 ? 'long' : m.totalR < 0 ? 'short' : undefined} />
          <Stat label="Total P/L" value={signedUsd(m.totalPnl)} big tone={m.totalPnl > 0 ? 'long' : m.totalPnl < 0 ? 'short' : undefined} />
          <Stat label="Profit factor" value={m.profitFactor === null ? '— (no losses)' : m.profitFactor.toFixed(2)} big />
          <Stat label="Max drawdown" value={usd(m.maxDrawdown)} sub={hasR ? `${m.maxDrawdownR.toFixed(2)}R` : undefined} big tone="short" />
          <Stat label="Average winner" value={m.wins ? signedUsd(m.averageWinner) : '—'} sub={m.wins && hasR ? signedR(m.averageWinnerR) : undefined} tone="long" />
          <Stat label="Average loser" value={m.losses ? signedUsd(m.averageLoser) : '—'} sub={m.losses && hasR ? signedR(m.averageLoserR) : undefined} tone="short" />
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
        <GroupTable title="LONG vs SHORT" rows={m.byDirection} hasR={hasR} />
        <GroupTable title="By time of day (ET)" rows={m.byTimeOfDay} hasR={hasR} />
        <GroupTable title="By ticker" rows={m.byTicker} hasR={hasR} />
      </div>
    </div>
  );
}

function GroupTable({ title, rows, hasR = true }: { title: string; rows: GroupStats[]; hasR?: boolean }) {
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
                <td className={`py-1 text-right ${g.totalR > 0 ? 'text-long' : g.totalR < 0 ? 'text-short' : ''}`}>{hasR ? signedR(g.totalR) : '—'}</td>
                <td className={`py-1 text-right ${g.totalPnl > 0 ? 'text-long' : g.totalPnl < 0 ? 'text-short' : ''}`}>{signedUsd(g.totalPnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
