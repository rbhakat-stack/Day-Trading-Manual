import { useRef } from 'react';
import { journalToCsv, OUTCOME_LABELS, tradePnl, tradeR, type JournalEntry, type Outcome } from '../engine/journal';
import { parseNum, price, signedR, signedUsd, usd } from '../lib/format';
import { download } from '../lib/storage';
import { Panel } from './ui';

interface Props {
  entries: JournalEntry[];
  update: (id: string, patch: Partial<JournalEntry>) => void;
  remove: (id: string) => void;
  replaceAll: (entries: JournalEntry[]) => void;
}

const cell = 'border-t border-ink-700/70 px-2 py-1.5 align-middle';
const inp = 'num w-20 rounded border border-ink-600 bg-ink-900 px-1.5 py-1 text-[13px] outline-none focus:border-[#5b8cff]';

export function JournalView({ entries, update, remove, replaceAll }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const sorted = [...entries].sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
  const stamp = new Date().toISOString().slice(0, 10);

  const importJson = async (f: File) => {
    try {
      const data = JSON.parse(await f.text());
      if (!Array.isArray(data)) throw new Error('not an array');
      if (confirm(`Replace the current journal (${entries.length} entries) with ${data.length} imported entries?`)) replaceAll(data as JournalEntry[]);
    } catch {
      alert('That file is not a valid journal backup (JSON).');
    }
  };

  return (
    <Panel
      title={`Trade journal — ${entries.length} entries`}
      right={
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className="rounded-md bg-ink-700 px-2.5 py-1 text-xs text-ink-100 hover:bg-ink-600" onClick={() => download(`rb-v1-journal-${stamp}.csv`, journalToCsv(entries), 'text/csv')}>Export CSV</button>
          <button type="button" className="rounded-md bg-ink-700 px-2.5 py-1 text-xs text-ink-100 hover:bg-ink-600" onClick={() => download(`rb-v1-journal-${stamp}.json`, JSON.stringify(entries, null, 2), 'application/json')}>Backup JSON</button>
          <button type="button" className="rounded-md bg-ink-700 px-2.5 py-1 text-xs text-ink-100 hover:bg-ink-600" onClick={() => fileRef.current?.click()}>Restore JSON</button>
          <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
        </div>
      }
    >
      <p className="mb-3 text-xs text-ink-400">
        Stored only in this browser (localStorage). Back up regularly with “Backup JSON”. P/L uses the actual fill when entered, otherwise the planned entry. R = P/L ÷ planned max loss.
      </p>
      {sorted.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-400">No trades yet. Calculate a trade and press “Save trade to journal”.</p>
      ) : (
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full min-w-[1100px] text-[13px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-ink-400">
                {['Date', 'Time', 'Ticker', 'Dir', 'Decision', 'Planned entry', 'Actual fill', 'Stop', 'Target', 'Qty', 'Exp. risk', 'Outcome', 'Exit price', 'P/L', 'R', 'Notes', ''].map((h) => (
                  <th key={h} className="px-2 py-1.5 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((e) => {
                const pnl = tradePnl(e);
                const r = tradeR(e);
                return (
                  <tr key={e.id} className="hover:bg-ink-800/60">
                    <td className={cell}><input type="date" value={e.date} onChange={(v) => update(e.id, { date: v.target.value })} className={`${inp} w-32`} /></td>
                    <td className={cell}><input type="time" value={e.time} onChange={(v) => update(e.id, { time: v.target.value })} className={`${inp} w-24`} /></td>
                    <td className={`${cell} num font-semibold`}>{e.ticker || '—'}</td>
                    <td className={`${cell} font-semibold ${e.direction === 'LONG' ? 'text-long' : 'text-short'}`}>{e.direction}</td>
                    <td className={`${cell} text-ink-300`}>{e.orderType}</td>
                    <td className={`${cell} num`}>{price(e.plannedEntry)}</td>
                    <td className={cell}>
                      <NumInput value={e.actualFill} onChange={(v) => update(e.id, { actualFill: v })} />
                    </td>
                    <td className={`${cell} num text-short`}>{price(e.stop)}</td>
                    <td className={`${cell} num text-long`}>{price(e.target)}</td>
                    <td className={`${cell} num`}>{e.quantity}</td>
                    <td className={`${cell} num`}>{usd(e.expectedRisk)}</td>
                    <td className={cell}>
                      <select value={e.outcome} onChange={(v) => update(e.id, { outcome: v.target.value as Outcome })} className="rounded border border-ink-600 bg-ink-900 px-1 py-1 text-[13px]">
                        {(Object.keys(OUTCOME_LABELS) as Outcome[]).map((o) => <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>)}
                      </select>
                    </td>
                    <td className={cell}><NumInput value={e.exitPrice} onChange={(v) => update(e.id, { exitPrice: v })} /></td>
                    <td className={`${cell} num ${pnl === null ? 'text-ink-500' : pnl > 0 ? 'text-long' : pnl < 0 ? 'text-short' : ''}`}>{pnl === null ? '—' : signedUsd(pnl)}</td>
                    <td className={`${cell} num ${r === null ? 'text-ink-500' : r > 0 ? 'text-long' : r < 0 ? 'text-short' : ''}`}>{r === null ? '—' : signedR(r)}</td>
                    <td className={cell}><input value={e.notes} onChange={(v) => update(e.id, { notes: v.target.value })} className={`${inp} w-48 font-sans`} placeholder="notes" /></td>
                    <td className={cell}>
                      <button type="button" aria-label="Delete entry" className="rounded px-2 py-1 text-ink-400 hover:bg-short-dim hover:text-short" onClick={() => confirm(`Delete ${e.ticker} ${e.date} ${e.time}?`) && remove(e.id)}>✕</button>
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

function NumInput({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <input
      inputMode="decimal"
      defaultValue={value ?? ''}
      onBlur={(e) => {
        const n = parseNum(e.target.value);
        onChange(Number.isFinite(n) && n > 0 ? n : null);
      }}
      className={inp}
      placeholder="—"
    />
  );
}
