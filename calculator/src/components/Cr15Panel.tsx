/**
 * CR-15 cross-day reconciliation panel (Journal tab). Rendered only when the server enables CR-15. Preview (dry run) shows
 * every proposed change with its broker evidence; writes happen only after the immutable pre-CR-15 backup is verified.
 */
import type { Cr15Mode, CrossDayPlan, TradeReconciliation } from '../engine/automation/lifecycle/crossDayJournal';
import { tradePnl, type JournalEntry } from '../engine/journal';
import type { JournalBackup } from '../lib/journalBackup';
import { signedUsd } from '../lib/format';


interface Props {
  mode: Cr15Mode;
  setMode: (m: Cr15Mode) => void;
  plan: CrossDayPlan | null;
  journal: JournalEntry[];
  feed: { status: string; error: string | null; complete: boolean; lastOkMs: number | null };
  request: { symbols: string[]; from: string | null; outOfRange: string[] };
  backup: JournalBackup | null;
  message: string | null;
  onApply: () => void;
  onRestore: () => void;
  onDownloadBackup: () => void;
}

const fmtExit = (x: TradeReconciliation) => x.exits.map((f) => `${f.qty} @ ${f.avg} ${f.reason.replace('_', ' ')} (${f.evidence === 'BRACKET_LEG' ? 'bracket leg' : f.evidence === 'POSITION_INTENT' ? 'broker position intent' : 'position continuity'}, order ${f.orderId.slice(0, 8)})`).join('; ') || '—';

export function Cr15Panel({ mode, setMode, plan, journal, feed, request, backup, message, onApply, onRestore, onDownloadBackup }: Props) {
  const byId = new Map(journal.map((e) => [e.id, e]));
  const rows = plan?.trades ?? [];
  return (
    <section className="mb-4 rounded-lg border border-warn/50 bg-warn-dim/20 p-3 text-[12.5px]" data-section="cr15">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <b className="text-ink-100">CR-15 cross-day reconciliation (read-only Alpaca PAPER facts)</b>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="CR-15 mode">
          {(['OFF', 'PREVIEW', 'AUTO'] as Cr15Mode[]).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} disabled={m === 'AUTO' && !backup} title={m === 'AUTO' && !backup ? 'Apply once (with a verified backup) before enabling automatic reconciliation' : undefined}
              onClick={() => setMode(m)} className={`rounded border px-2 py-0.5 text-[11px] font-bold ${mode === m ? 'border-warn bg-warn text-ink-950' : 'border-ink-500 text-ink-200 disabled:opacity-40'}`}>{m}</button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-ink-300">
        OFF = legacy Journal behaviour. PREVIEW = dry run: nothing is written. AUTO = after the verified backup, open broker trades are reconciled automatically.
        Superseded rows are kept for audit and excluded from the Dashboard. RB never places, cancels or closes orders.
      </p>
      <p className="mt-1 text-ink-300">
        Backup: {backup ? <>pre-CR-15 Journal saved {backup.createdIso} ({backup.count} rows) — immutable. <button type="button" className="underline" onClick={onDownloadBackup}>Download backup JSON</button> · <button type="button" className="underline" onClick={onRestore}>Restore pre-CR-15 Journal…</button></> : 'none yet — it is created and verified automatically before the first write.'}
      </p>
      {mode !== 'OFF' && (
        <>
          <p className="mt-1 text-ink-300">
            Broker history: {request.symbols.length ? `${request.symbols.join(', ')} since ${request.from}` : 'no open broker trades'} · {feed.status}{feed.error ? ` (${feed.error})` : ''}{feed.status === 'LIVE' && !feed.complete ? ' · TRUNCATED' : ''}
            {request.outOfRange.length > 0 && ` · ${request.outOfRange.length} open trade(s) older than the lookback — not reconciled`}
          </p>
          {plan?.blocked && <p className="mt-1 font-semibold text-short">{plan.blocked}</p>}
          {rows.length > 0 && (
            <table className="mt-2 w-full text-[12px]">
              <thead><tr className="text-left text-[10px] uppercase text-ink-400">{['Trade', 'Status', 'Entry', 'Broker exits (evidence)', 'P/L now → after', 'Superseded rows', 'Notes'].map((h) => <th key={h} className="px-1 py-1">{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((x) => {
                  const cur = byId.get(x.tradeId);
                  const before = cur ? tradePnl(cur) : null;
                  return (
                    <tr key={x.tradeId} className="border-t border-ink-700/60 align-top" data-cr15-trade={x.tradeId}>
                      <td className="px-1 py-1">{x.direction} {x.symbol}<div className="text-[10px] text-ink-400">{x.tradeId}</div></td>
                      <td className={`px-1 py-1 font-bold ${x.status === 'INCOMPLETE' || x.status === 'AMBIGUOUS' ? 'text-short' : x.status === 'CLOSED' ? 'text-long' : 'text-ink-200'}`}>{x.status === 'INCOMPLETE' ? 'RECONCILIATION INCOMPLETE' : x.status}</td>
                      <td className="px-1 py-1">{x.entry ? `${x.entry.qty} @ ${x.entry.avg ?? '—'}` : '—'}</td>
                      <td className="px-1 py-1">{fmtExit(x)}</td>
                      <td className="px-1 py-1">{before === null ? '—' : signedUsd(before)} → {x.realizedPnl === null ? '—' : signedUsd(x.realizedPnl)}{x.status === 'PARTIAL' ? ' (partial, trade stays open)' : ''}</td>
                      <td className="px-1 py-1">{x.supersedes.length ? x.supersedes.join(', ') : '—'}</td>
                      <td className="px-1 py-1 text-ink-400">{x.notes.join(' ') || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {mode === 'PREVIEW' && (
            <button type="button" disabled={!plan?.changed} onClick={onApply} className="mt-2 rounded bg-warn px-3 py-1 text-xs font-black uppercase text-ink-950 disabled:opacity-40">
              Back up &amp; apply these changes
            </button>
          )}
        </>
      )}
      {message && <p className="mt-1 font-semibold text-ink-100">{message}</p>}
    </section>
  );
}
