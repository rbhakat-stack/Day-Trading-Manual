import { useMemo, useState } from 'react';
import type { QueueRow } from '../../engine/automation/liveQueue';
import { brokerOrdersFrom, parseBrokerOrders, reconcileBroker } from '../../engine/automation/lifecycle/brokerSync';
import { AUTO_KEYS, usePersistent, type BrokerFeed } from '../../lib/automationClient';
import { load } from '../../lib/storage';

const money = (x: number | null) => (x === null ? "—" : `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const px = (x: number | null) => (x === null ? '—' : x.toFixed(2));
const n = (x: string | undefined) => (x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

/**
 * CR-12 — READ-ONLY broker reconciliation. Source: the rb-broker feed (paper account orders + positions, GET only)
 * when broker sync is enabled on the server; otherwise pasted Alpaca order JSON. RB never sends, changes or cancels
 * an order; the manual "Mark order submitted" lifecycle in the queue is unchanged.
 */
export function BrokerSyncPanel({ rows, feed, now }: { rows: QueueRow[]; feed?: BrokerFeed; now: number }) {
  const [text, setText] = usePersistent<string>(AUTO_KEYS.brokerOrders, () => load<string>(AUTO_KEYS.brokerOrders, ''));
  const [draft, setDraft] = useState('');
  const live = feed?.status === 'LIVE';
  const parsed = useMemo(() => (live ? brokerOrdersFrom(feed!.orders) : text.trim() ? parseBrokerOrders(text) : { orders: [], errors: [] }), [live, feed, text]);
  const trades = useMemo(() => reconcileBroker(parsed.orders, rows, live ? feed!.positions : undefined), [parsed.orders, rows, live, feed]);
  const source = live
    ? `LIVE · Alpaca PAPER account · read-only · updated ${feed!.lastOkMs ? Math.max(0, Math.round((now - feed!.lastOkMs) / 1000)) : '—'} s ago`
    : feed?.status === 'OFF' ? 'Broker sync is OFF on the server (RB_BROKER_SYNC_ENABLED) — using pasted orders'
    : feed?.status === 'ERROR' ? `Broker read failed (${feed.error}) — using pasted orders`
    : feed ? 'Connecting to the read-only broker feed…' : 'Pasted orders';
  return (
    <details open={live || undefined} className="rounded-xl border border-ink-700 bg-ink-850 p-3 text-[13px]" data-section="broker-sync">
      <summary className="cursor-pointer text-[12px] font-semibold uppercase tracking-wider text-ink-300">
        Broker reconciliation (read-only){trades.length ? ` — ${trades.length} order(s)` : ''}{live && feed!.positions.length ? ` · ${feed!.positions.length} open position(s)` : ''}
      </summary>
      <p className={`mt-2 text-[12px] font-semibold ${live ? 'text-long' : feed?.status === 'ERROR' ? 'text-short' : 'text-ink-300'}`} data-broker-source={feed?.status ?? 'PASTE'}>{source}</p>
      <p className="mt-1 text-[12px] text-ink-400">
        RB reads orders and positions only — it cannot place, modify, cancel or close anything. Strategy decision, manual override, broker status and position status are kept
        separate; a manual trade never changes the alert's strategy record. Manual marking in the queue still works as before.
      </p>
      {!live && (
        <>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} placeholder='[{"symbol":"GM","side":"buy","type":"stop","status":"filled", ...}]' className="num mt-2 w-full rounded border border-ink-600 bg-ink-900 px-2 py-1.5 text-[12px]" aria-label="Alpaca orders JSON" />
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setText(draft)} disabled={!draft.trim()} className="rounded border border-ink-600 px-2.5 py-1 text-xs text-ink-200 hover:bg-ink-700 disabled:opacity-40">Reconcile pasted orders</button>
            {text && <button type="button" onClick={() => { setText(''); setDraft(''); }} className="rounded border border-ink-600 px-2.5 py-1 text-xs text-ink-300 hover:bg-ink-700">Clear import</button>}
            {parsed.errors.length > 0 && <span className="text-xs text-short">{parsed.errors.slice(0, 3).join('; ')}</span>}
          </div>
        </>
      )}
      {trades.length > 0 ? (
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
      ) : (
        live && <p className="mt-2 text-[12px] text-ink-400">No orders on the paper account for this session.</p>
      )}
      {live && feed!.positions.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-300">Open positions (broker)</div>
          <table className="w-full min-w-[600px] text-[12.5px] tabular-nums">
            <thead className="text-left text-ink-300"><tr>{['Ticker', 'Side', 'Qty', 'Avg entry', 'Current', 'Market value', 'Unrealized P/L'].map((h) => <th key={h} className="px-1.5 py-1">{h}</th>)}</tr></thead>
            <tbody>
              {feed!.positions.map((p) => (
                <tr key={p.symbol} className="border-t border-ink-700/70">
                  <td className="px-1.5 py-1 font-bold text-ink-100">{p.symbol}</td>
                  <td className="px-1.5 py-1">{(p.side ?? '').toUpperCase()}</td>
                  <td className="px-1.5 py-1">{p.qty ?? '—'}</td>
                  <td className="px-1.5 py-1">{px(n(p.avg_entry_price))}</td>
                  <td className="px-1.5 py-1">{px(n(p.current_price))}</td>
                  <td className="px-1.5 py-1">{money(n(p.market_value))}</td>
                  <td className={`px-1.5 py-1 ${(n(p.unrealized_pl) ?? 0) < 0 ? 'text-short' : 'text-long'}`}>{money(n(p.unrealized_pl))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
