import { useState } from 'react';
import type { AutoAlertRecord, ParityTolerance } from '../../engine/automation/alertDecision';
import { fmtEt } from '../../engine/automation/etTime';
import { compareParity, PARITY_FIELDS, PARITY_LABELS, type ParityEntry, type ParityField, type ParityRow } from '../../engine/automation/parity';
import { Panel } from '../ui';

interface Props {
  records: AutoAlertRecord[];
  entries: Record<string, ParityEntry>;
  setEntry: (e: ParityEntry) => void;
  tol: ParityTolerance;
  summary: { compared: number; withMismatch: number; required: number; status: string };
  rowsById: Record<string, ParityRow[]>;
}

/** DATA VALIDATION MODE: type the values you read on the TrendSpider chart and compare them with the automated values. */
export function ParityView({ records, entries, setEntry, tol, summary, rowsById }: Props) {
  const withValues = records.filter((r) => r.snapshot?.values).sort((a, b) => b.alert.alertTimeMs - a.alert.alertTimeMs);
  const [sel, setSel] = useState<string>(withValues[0]?.id ?? '');
  const rec = withValues.find((r) => r.id === sel) ?? null;
  const entry = rec ? entries[rec.id] : undefined;
  const [draft, setDraft] = useState<Record<string, string>>({});
  const load = (id: string) => {
    setSel(id);
    const e = entries[id];
    setDraft(Object.fromEntries(PARITY_FIELDS.map((f) => [f, e?.trendSpider[f] !== undefined ? String(e.trendSpider[f]) : ''])));
  };
  const rows = rec?.snapshot?.values && entry ? compareParity(rec.snapshot.values, entry.trendSpider, tol) : [];
  return (
    <div className="space-y-4">
      <Panel title="Data validation mode — TrendSpider vs automated market data">
        <p className="text-sm text-ink-300">
          For at least the first {summary.required} alerts, read the values on your TrendSpider chart (same signal candle, the same last completed 15m candle) and enter them here. A difference beyond tolerance marks that alert
          <b className="text-short"> DATA MISMATCH — MANUAL REVIEW REQUIRED</b> and removes its ticket.
        </p>
        <p className="mt-2 text-sm">
          Status: <b className={summary.status === 'VALIDATED' ? 'text-long' : summary.withMismatch ? 'text-short' : 'text-warn'}>{summary.status}</b> · {summary.compared} compared · {summary.withMismatch} with mismatches · {summary.required} required
        </p>
      </Panel>
      {withValues.length === 0 ? (
        <Panel title="No alerts with complete automated values yet">
          <p className="text-sm text-ink-400">Alerts appear here once their snapshot is built.</p>
        </Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(260px,320px)_1fr]">
          <Panel title="Alerts">
            <ul className="space-y-1 text-sm">
              {withValues.map((r) => {
                const rs = rowsById[r.id] ?? [];
                const bad = rs.some((x) => x.mismatch);
                return (
                  <li key={r.id}>
                    <button type="button" onClick={() => load(r.id)} className={`w-full rounded px-2 py-1 text-left ${sel === r.id ? 'bg-ink-700' : 'hover:bg-ink-800'}`}>
                      <span className="font-semibold">{r.alert.symbol}</span> {r.alert.direction} · {fmtEt(r.alert.alertTimeMs)}{' '}
                      <span className={bad ? 'text-short' : rs.length ? 'text-long' : 'text-ink-500'}>{bad ? 'mismatch' : rs.length ? 'ok' : 'not compared'}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Panel>
          {rec && rec.snapshot?.values && (
            <Panel title={`${rec.alert.symbol} ${rec.alert.direction} · signal ${rec.snapshot.signal?.label} · 15m ${rec.snapshot.confirm15m?.label} · feed ${rec.provider.feed.toUpperCase()}`}>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {PARITY_FIELDS.map((f) => (
                  <label key={f} className="block text-xs">
                    <span className="mb-0.5 block uppercase tracking-wider text-ink-400">TrendSpider {PARITY_LABELS[f]}</span>
                    <input inputMode="decimal" value={draft[f] ?? ''} onChange={(e) => setDraft({ ...draft, [f]: e.target.value })} className="num w-full rounded border border-ink-600 bg-ink-900 px-2 py-1" />
                  </label>
                ))}
              </div>
              <button
                type="button"
                className="mt-3 rounded-lg bg-[#3d6df2] px-3 py-1.5 text-xs font-bold text-white"
                onClick={() => {
                  const ts: Partial<Record<ParityField, number>> = {};
                  for (const f of PARITY_FIELDS) {
                    const n = Number((draft[f] ?? '').trim());
                    if ((draft[f] ?? '').trim() && Number.isFinite(n)) ts[f] = n;
                  }
                  setEntry({ recordId: rec.id, symbol: rec.alert.symbol, alertEt: fmtEt(rec.alert.alertTimeMs), enteredIso: new Date().toISOString(), trendSpider: ts });
                }}
              >
                Save and compare
              </button>
              {rows.length > 0 && (
                <div className="-mx-4 mt-3 overflow-x-auto">
                  <table className="num w-full min-w-[620px] text-[12.5px]">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wider text-ink-400">
                        {['Field', 'TrendSpider', 'Automated', 'Abs diff', '% diff', 'Tolerance', 'Result'].map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.field} className="border-t border-ink-700/60">
                          <td className="px-2 py-1 font-sans">{PARITY_LABELS[r.field]}</td>
                          <td className="px-2 py-1">{r.trendSpider}</td>
                          <td className="px-2 py-1">{+r.automated.toFixed(4)}</td>
                          <td className="px-2 py-1">{+r.absDiff.toFixed(4)}</td>
                          <td className="px-2 py-1">{r.pctDiff === null ? '—' : `${(r.pctDiff * 100).toFixed(3)}%`}</td>
                          <td className="px-2 py-1">{r.tolerance}</td>
                          <td className={`px-2 py-1 font-sans font-bold ${r.mismatch ? 'text-short' : 'text-long'}`}>{r.mismatch ? 'DATA MISMATCH' : 'OK'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}
