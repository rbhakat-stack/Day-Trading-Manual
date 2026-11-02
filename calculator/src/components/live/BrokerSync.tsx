import { useMemo, useState } from 'react';
import type { QueueRow } from '../../engine/automation/liveQueue';
import { parseBrokerOrders, reconcileBroker } from '../../engine/automation/lifecycle/brokerSync';
import { AUTO_KEYS, usePersistent } from '../../lib/automationClient';
import { load } from '../../lib/storage';

const money = (x: number | null) => (x === null ? '—' : `${x < 0 ? '−' : ''}$${Math.abs(x).toFixed(2)}`);
const px = (x: number | null) => (x === null ? '—' : x.toFixed(2));

/**
 * CR-12 — read-only broker reconciliation from pasted Alpaca order JSON. No broker connection, nothing is sent; the
 * manual "Mark order submitted" lifecycle stays the source of truth for the queue.
 */
export function BrokerSyncPanel({ rows }: { rows: QueueRow[] }) {
  const [text, setText] = usePersistent<string>(AUTO_KEYS.brokerOrders, () => load<string>(AUTO_KEYS.brokerOrders, ''));
  const [draft, setDraft] = useState('');
  const parsed = useMemo(() => (text.trim() ? parseBrokerOrders(text) : { orders: [], errors: [] }), [text]);
  const trades = useMemo(() => reconcileBroker(parsed.orders, rows), [parsed.orders, rows]);
  return (
    <details className="rounded-xl border border-ink-700 bg-ink-850 p-3 text-[13px]" data-section="broker-sync">
      <summary className="cursor-pointer text-[12px] font-semibold uppercase tracking-wider text-ink-300">
        Broker reconciliation (read-only import){trades.length ? ` — ${trades.length} order(s)` : ''}
      </summary>
      <p className="mt-2 text-[12px] text-ink-400">
        Paste the Alpaca orders JSON (array, including bracket legs). RB maps broker status, captures fills and P/L and infers the exit. Strategy decision, manual override,
        broker status and position status are kept separate — a manual trade never changes the alert's strategy record. Manual marking in the queue still works as before.
      </p>
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} placeholder='[{"symbol":"GM","side":"buy","type":"stop","status":"filled", ...}]' className="num mt-2 w-full rounded border border-ink-600 bg-ink-900 px-2 py-1.5 text-[12px]" aria-label="Alpaca orders JSON" />
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setText(draft)} disabled={!draft.trim()} className="rounded border border-ink-600 px-2.5 py-1 text-xs text-ink-200 hover:bg-ink-700 disabled:opacity-40">Reconcile</button>
        {text && <button type="button" onClick={() => { setText(''); setDraft(''); }} className="rounded border border-ink-600 px-2.5 py-1 text-xs text-ink-300 hover:bg-ink-700">Clear import</button>}
        {parsed.errors.length > 0 && <span className="text-xs text-short">{parsed.errors.slice(0, 3).join('; ')}</span>}
      </div>
      {trades.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[900px] text-[12.5px] tabular-nums">
            <thead className="text-left text-ink-300">
              <tr>{['Ticker', 'Side', 'Strategy decision', 'Manual override', 'Broker status', 'Position status', 'Entry fill', 'Exit fill', 'Exit', 'Realized P/L', 'Notes'].map((h) => <th key={h} className="px-1.5 py-1">{h}</th>)}</tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.entryOrderId} className="border-t border-ink-700/70">
                  <td className="px-1.5 py-1 font-bold text-ink-100">{t.symbol}</td>
                  <td className="px-1.5 py-1">{t.direction}</td>
                  <td className="px-1.5 py-1">{t.strategyDecision}</td>
                  <td className={`px-1.5 py-1 ${t.manualOverride ? 'font-bold text-warn' : ''}`}>{t.manualOverride ? 'YES' : 'NO'}</td>
                  <td className="px-1.5 py-1">{t.brokerStatus}</td>
                  <td className="px-1.5 py-1">{t.positionStatus}</td>
                  <td className="px-1.5 py-1">{t.entryQty ? `${t.entryQty} @ ${px(t.entryAvg)}` : '—'}</td>
                  <td className="px-1.5 py-1">{t.exitQty ? `${t.exitQty} @ ${px(t.exitAvg)}` : '—'}</td>
                  <td className="px-1.5 py-1">{t.exitReason ?? '—'}</td>
                  <td className={`px-1.5 py-1 ${t.realizedPL !== null && t.realizedPL < 0 ? 'text-short' : 'text-long'}`}>{money(t.realizedPL)}</td>
                  <td className="px-1.5 py-1 text-ink-400">{t.notes.join(' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
