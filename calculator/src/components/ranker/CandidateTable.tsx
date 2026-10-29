import type { RankedCandidate } from '../../engine/ranker/candidateRanker';
import { price, usd } from '../../lib/format';
import { Panel, toneClasses } from '../ui';
import { fmtScore, recTone } from './shared';

export function CandidateTable({ ranked, selectedId, onSelect }: { ranked: RankedCandidate[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const heads = ['Rank', 'Ticker', 'Side', 'Score', 'Setup', 'Fit', 'Entry', 'Stop', 'Target', 'Shares', 'Position', 'Risk', 'RVOL', 'RSI', 'ATR', 'Sector', 'Alert', 'vs Entry', 'Status'];
  return (
    <Panel title={`Active candidates — today (${ranked.length})`} right={<span className="text-[11px] text-ink-400">Rank is relative; eligibility is absolute (≥ 85 to trade). Arrival time only breaks exact ties.</span>}>
      {ranked.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-400">No candidates today. Send one from the Calculator or load the sample day.</p>
      ) : (
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full min-w-[1250px] text-[13px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-ink-400">
                {heads.map((h) => <th key={h} className="whitespace-nowrap px-2 py-1.5 font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {ranked.map((r) => {
                const c = r.candidate;
                const dp = c.entry >= 1 ? 2 : 4;
                const t = toneClasses[recTone(r.displayStatus)];
                const sel = c.id === selectedId;
                return (
                  <tr
                    key={c.id}
                    onClick={() => onSelect(c.id)}
                    className={`cursor-pointer border-t border-ink-700/70 ${sel ? 'bg-[#1a2a4a]' : 'hover:bg-ink-800'} ${!r.eligible ? 'opacity-70' : ''}`}
                    aria-selected={sel}
                  >
                    <td className="num px-2 py-1.5 font-bold text-ink-100">{r.rank ? `#${r.rank}` : '—'}</td>
                    <td className="num px-2 py-1.5 font-semibold text-ink-100">{c.ticker}</td>
                    <td className={`px-2 py-1.5 font-semibold ${c.direction === 'LONG' ? 'text-long' : 'text-short'}`}>{c.direction}</td>
                    <td className="num px-2 py-1.5 text-base font-bold text-ink-100">{fmtScore(r.total)}</td>
                    <td className="num px-2 py-1.5 text-ink-300">{fmtScore(r.setup)}</td>
                    <td className="num px-2 py-1.5 text-ink-300">{fmtScore(r.fit)}</td>
                    <td className="num px-2 py-1.5">{price(c.entry, dp)}</td>
                    <td className="num px-2 py-1.5 text-short">{price(c.stop, dp)}</td>
                    <td className="num px-2 py-1.5 text-long">{price(c.target, dp)}</td>
                    <td className="num px-2 py-1.5">{c.shares}</td>
                    <td className="num px-2 py-1.5">{usd(c.positionValue, 0)}</td>
                    <td className="num px-2 py-1.5">{usd(c.plannedRisk)}</td>
                    <td className="num px-2 py-1.5">{c.inputs.rvol ?? '—'}</td>
                    <td className="num px-2 py-1.5">{c.inputs.rsi ?? '—'}</td>
                    <td className="num px-2 py-1.5">{c.atr}</td>
                    <td className="max-w-[9rem] truncate px-2 py-1.5 text-ink-300" title={[c.inputs.sector, c.inputs.industry, c.inputs.theme].filter(Boolean).join(' / ')}>{c.inputs.industry || c.inputs.sector || '—'}</td>
                    <td className="num px-2 py-1.5">{c.alertTime}</td>
                    <td className="num px-2 py-1.5">{c.chaseDistanceAtr === null ? '—' : `${c.chaseDistanceAtr > 0 ? '+' : ''}${c.chaseDistanceAtr.toFixed(2)} ATR`}</td>
                    <td className="px-2 py-1.5">
                      <span className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-bold ${t.badge}`} title={r.hardFails.map((f) => f.label).join(' · ')}>{r.displayStatus}</span>
                      {r.recommendation === 'NOT ELIGIBLE — CANNOT BE RANKED' && r.hardFails[0] && <div className="mt-0.5 text-[10px] text-short">{r.hardFails[0].label}</div>}
                      {r.recommendation === 'SCORING INCOMPLETE' && <div className="mt-0.5 max-w-[14rem] truncate text-[10px] text-warn">missing: {r.missing.join(', ')}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
