import { useState, type FormEvent } from 'react';
import type { ParityTolerance } from '../../engine/automation/alertDecision';
import { compareHistorical, DERIVED_LABEL, DIAGNOSTIC_LABEL, type CutoffKey, type HistoricalResult, type Precision } from '../../engine/automation/historicalParity';
import { PARITY_FIELDS, PARITY_LABELS, type ParityField } from '../../engine/automation/parity';
import { historicalRequestBody, runHistoricalSip, usePersistent } from '../../lib/automationClient';
import { Panel } from '../ui';

/**
 * HISTORICAL SIP PARITY TEST — diagnostic only, INTRABAR reconstruction. Kept apart from the live queue: it reads no
 * alert records, writes no candidates, positions, journal entries or parity entries, and its state lives under its
 * own browser key (v2: the intrabar result shape).
 */
const KEY = 'rbv1.diagnostics.historicalSip.v2';

interface Saved {
  form: { symbol: string; direction: 'LONG' | 'SHORT'; alertEt: string; label: string; precision: 'EXACT' | 'MINUTE' };
  ts: Record<string, string>;
  result: HistoricalResult | null;
}

const INITIAL: Saved = { form: { symbol: '', direction: 'LONG', alertEt: '', label: '', precision: 'EXACT' }, ts: {}, result: null };
const box = 'num w-full rounded border border-ink-600 bg-ink-900 px-2 py-1.5 text-[13px] outline-none focus:border-[#5b8cff] placeholder:italic placeholder:text-ink-500';
const f4 = (n: number) => String(+n.toFixed(4));
const money = (n: number) => `$${n.toFixed(2)}`;
const PRECISION_LABEL: Record<Precision, string> = {
  EXACT_SECOND: 'EXACT SECOND',
  EXACT_SECOND_BRACKETED: 'EXACT SECOND — INTRABAR_TIME_PRECISION_LIMITATION (bracketed to the minute)',
  APPROXIMATE_MINUTE: 'APPROXIMATE MINUTE — APPROXIMATE INTRABAR RECONSTRUCTION',
};
const BOUND_LABEL: Record<CutoffKey, string> = { EXACT: 'Alpaca SIP', EARLIEST: 'SIP earliest', LATEST: 'SIP latest' };

export function HistoricalSipTest({ token, tol }: { token: string; tol: ParityTolerance }) {
  const [saved, setSaved] = usePersistent<Saved>(KEY, () => {
    try {
      const raw = window.localStorage.getItem(KEY);
      const s = raw ? (JSON.parse(raw) as Saved) : null;
      return s ? { ...INITIAL, ...s, form: { ...INITIAL.form, ...s.form } } : INITIAL;
    } catch {
      return INITIAL;
    }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ kind: string; error: string } | null>(null);
  const { form, ts, result } = saved;
  const setForm = (p: Partial<Saved['form']>) => setSaved((s) => ({ ...s, form: { ...s.form, ...p } }));

  // Read what the boxes actually show at submit time (covers browser autofill / form restoration that bypasses
  // onChange), so the request always equals the visible form.
  const run = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body = historicalRequestBody({ symbol: fd.get('symbol'), direction: fd.get('direction'), alertEt: fd.get('alertEt'), label: fd.get('label'), precision: fd.get('precision') });
    setSaved((s) => ({ ...s, form: { ...body, direction: body.direction === 'SHORT' ? 'SHORT' : 'LONG' }, result: null }));
    setError(null);
    if (!body.symbol || !body.alertEt) {
      setError({ kind: 'INVALID_REQUEST', error: `Enter ${!body.symbol ? 'a ticker' : ''}${!body.symbol && !body.alertEt ? ' and ' : ''}${!body.alertEt ? 'the alert time' : ''}.` });
      return;
    }
    setBusy(true);
    const r = await runHistoricalSip(token, body);
    setBusy(false);
    if (r.ok) setSaved((s) => ({ ...s, result: r.result }));
    else setError({ kind: r.kind, error: r.error });
  };

  const tsNums: Partial<Record<ParityField, number>> = {};
  for (const f of PARITY_FIELDS) {
    const raw = (ts[f] ?? '').trim();
    const n = Number(raw);
    if (raw && Number.isFinite(n)) tsNums[f] = n;
  }
  const bounds = result?.bounds ?? [];
  const rows = result ? compareHistorical(result, tsNums, tol) : [];
  const counts = { pass: rows.filter((r) => r.result === 'PASS').length, between: rows.filter((r) => r.result === 'BETWEEN').length, mism: rows.filter((r) => r.result === 'MISMATCH').length };
  const anyValues = bounds.some((b) => b.snapshot.values);
  const bracketed = bounds.length > 1;

  return (
    <div className="space-y-4 rounded-xl border-2 border-dashed border-warn/60 p-3">
      <div className="rounded-lg bg-warn/15 px-4 py-3">
        <h2 className="text-lg font-black tracking-wide text-warn">HISTORICAL SIP PARITY TEST</h2>
        <p className="text-sm font-semibold text-ink-100">Diagnostic only. This page does not create, rank, allocate capital to, or execute a trade.</p>
        <p className="mt-1 text-xs text-ink-300">
          {DIAGNOSTIC_LABEL} · Intrabar reconstruction: the ACTIVE 5m candle at the alert time, built from historical SIP 1-minute bars up to the cutoff (no later data). Historical bars only — no latest trade, no quote, no current price. Same indicator engine and the parity tolerances from Automation settings.
        </p>
      </div>

      <Panel title="Historical test inputs">
        <form onSubmit={run} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[110px_120px_200px_190px_1fr_auto]">
          <label className="block text-sm">
            <span className="mb-1 block text-[11px] uppercase tracking-wider text-ink-300">Ticker</span>
            <input name="symbol" autoComplete="off" className={box} value={form.symbol} onChange={(e) => setForm({ symbol: e.target.value.toUpperCase() })} placeholder="ticker" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-[11px] uppercase tracking-wider text-ink-300">Direction</span>
            <select name="direction" className={box} value={form.direction} onChange={(e) => setForm({ direction: e.target.value as 'LONG' | 'SHORT' })}>
              <option>LONG</option>
              <option>SHORT</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-[11px] uppercase tracking-wider text-ink-300">TrendSpider alert time (ET)</span>
            <input name="alertEt" autoComplete="off" className={box} value={form.alertEt} onChange={(e) => setForm({ alertEt: e.target.value })} placeholder={form.precision === 'MINUTE' ? 'YYYY-MM-DD HH:MM' : 'YYYY-MM-DD HH:MM:SS'} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-[11px] uppercase tracking-wider text-ink-300">Timestamp precision</span>
            <select name="precision" className={box} value={form.precision} onChange={(e) => setForm({ precision: e.target.value as 'EXACT' | 'MINUTE' })}>
              <option value="EXACT">Exact second</option>
              <option value="MINUTE">Approximate minute</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-[11px] uppercase tracking-wider text-ink-300">Label (optional)</span>
            <input name="label" autoComplete="off" className={box} value={form.label} onChange={(e) => setForm({ label: e.target.value })} placeholder="optional" />
          </label>
          <button type="submit" disabled={busy || !token} className="self-end rounded-lg bg-warn px-4 py-2 text-sm font-black text-ink-950 disabled:opacity-50">
            {busy ? 'RUNNING…' : 'RUN HISTORICAL SIP TEST'}
          </button>
        </form>
        {!token && <p className="mt-2 text-xs text-short">Enter the app access token in Automation settings first.</p>}
        <p className="mt-2 text-xs text-ink-400">
          America/New_York. <b>Exact second</b>: YYYY-MM-DD HH:MM:SS. 1-minute bars resolve exactly only at :00; any other second is shown as a bracket (INTRABAR_TIME_PRECISION_LIMITATION). <b>Approximate minute</b>: YYYY-MM-DD HH:MM when TrendSpider shows only the minute — shown as earliest/latest possible state. Data must be ≥ 16 minutes old. If SIP fails, the test stops — it never falls back to IEX.
        </p>
      </Panel>

      {error && (
        <Panel title={<span className="text-short">SIP TEST FAILED — {error.kind.replace(/_/g, ' ')}</span>}>
          <p className="text-sm text-ink-100">{error.error}</p>
        </Panel>
      )}

      {result && (
        <>
          <Panel title="Alert timing">
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {[
                ['Ticker / direction', `${result.symbol} ${result.direction}`],
                ['Requested alert timestamp', `${result.alertEt} ET`],
                ['Active 5m candle', `${result.timing.activeLabel} ET`],
                ['Reconstructed through', bounds.map((b) => `${b.snapshot.cutoffEt} ET${bracketed ? ` (${b.key.toLowerCase()})` : ''}`).join(' · ')],
                ['Completed 15m candle', result.timing.confirm15mLabel ? `${result.timing.confirm15mLabel} ET` : '—'],
                ['Precision', PRECISION_LABEL[result.precision]],
                ['1m bars used', bounds.map((b) => `${b.snapshot.minutesUsed.join(', ') || 'none'}${bracketed ? ` (${b.key.toLowerCase()})` : ''}`).join(' · ')],
                ['Data provider / feed', `${result.provider.name} (${result.provider.host}) · SIP (forced)`],
                ['Mode', 'HISTORICAL DIAGNOSTIC · INTRABAR'],
                ['5m history requested', `${result.request.history5m.startIso} → ${result.request.history5m.endIso} (${result.barsReceived.fiveMin} bars)`],
                ['1m intrabar requested', `${result.request.intrabar1m.startIso} → ${result.request.intrabar1m.endIso} (${result.barsReceived.oneMin} bars)`],
                ['Current-price fetch / live decision', 'NONE / NONE'],
                ...(result.testLabel ? [['Label', result.testLabel]] : []),
              ].map(([k, val]) => (
                <div key={k} className="flex gap-2">
                  <dt className="shrink-0 text-ink-400">{k}:</dt>
                  <dd className="font-semibold text-ink-100">{val}</dd>
                </div>
              ))}
            </dl>
            <ul className="mt-3 space-y-1 text-sm">
              {result.notices.map((i) => (
                <li key={i.code} className="text-warn">
                  <b>{i.code.replace(/_/g, ' ')}</b> — {i.message}
                </li>
              ))}
              {bounds.flatMap((b) =>
                b.snapshot.issues.map((i) => (
                  <li key={`${b.key}-${i.code}`} className={i.kind === 'INCOMPLETE' ? 'text-short' : 'text-warn'}>
                    <b>{i.kind === 'INCOMPLETE' ? 'DATA INCOMPLETE' : 'REVIEW'} · {i.code}</b>
                    {bracketed ? ` (${b.key.toLowerCase()})` : ''} — {i.message}
                  </li>
                )),
              )}
            </ul>
          </Panel>

          {anyValues ? (
            <Panel title="Reconstructed Alpaca SIP values vs TrendSpider (type the values from your TrendSpider chart)">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                {PARITY_FIELDS.map((f) => (
                  <label key={f} className="block text-xs">
                    <span className="mb-0.5 block uppercase tracking-wider text-ink-400">{PARITY_LABELS[f]}</span>
                    <span className="num block text-[13px] text-ink-100">{bounds.map((b) => (b.snapshot.values ? f4(b.snapshot.values[f]) : '—')).join(' … ')}</span>
                    <input inputMode="decimal" placeholder="TrendSpider" value={ts[f] ?? ''} onChange={(e) => setSaved((s) => ({ ...s, ts: { ...s.ts, [f]: e.target.value } }))} className={`${box} mt-0.5`} />
                  </label>
                ))}
              </div>
              {rows.length > 0 && (
                <>
                  <p className="mt-3 text-sm">
                    {rows.length} of {PARITY_FIELDS.length} fields compared · <b className="text-long">{counts.pass} PASS</b>
                    {counts.between > 0 && <> · <b className="text-warn">{counts.between} BETWEEN BOUNDS</b></>} · <b className={counts.mism ? 'text-short' : 'text-ink-300'}>{counts.mism} MISMATCH</b>
                  </p>
                  <div className="-mx-4 mt-2 overflow-x-auto">
                    <table className="num w-full min-w-[720px] text-[12.5px]">
                      <thead>
                        <tr className="text-left text-[10px] uppercase tracking-wider text-ink-400">
                          <th className="px-2 py-1.5 font-medium">Field</th>
                          <th className="px-2 py-1.5 font-medium">TrendSpider</th>
                          {bounds.map((b) => (
                            <th key={b.key} colSpan={3} className="px-2 py-1.5 font-medium">{BOUND_LABEL[b.key]} · value / abs diff / % or pts</th>
                          ))}
                          <th className="px-2 py-1.5 font-medium">Tolerance</th>
                          <th className="px-2 py-1.5 font-medium">Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.field} className="border-t border-ink-700/60">
                            <td className="px-2 py-1 font-sans">{PARITY_LABELS[r.field]}</td>
                            <td className="px-2 py-1">{r.trendSpider}</td>
                            {r.perBound.map((x, i) =>
                              x ? (
                                [
                                  <td key={`v${i}`} className={`px-2 py-1 ${x.mismatch ? '' : 'text-long'}`}>{f4(x.automated)}</td>,
                                  <td key={`a${i}`} className="px-2 py-1">{f4(x.absDiff)}</td>,
                                  <td key={`p${i}`} className="px-2 py-1">{r.field === 'rsi' ? `${x.absDiff.toFixed(2)} pts` : x.pctDiff === null ? '—' : `${(x.pctDiff * 100).toFixed(3)}%`}</td>,
                                ]
                              ) : (
                                <td key={`n${i}`} colSpan={3} className="px-2 py-1 text-ink-500">—</td>
                              ),
                            )}
                            <td className="px-2 py-1">{r.perBound.find((x) => x)?.tolerance}</td>
                            <td className={`px-2 py-1 font-sans font-bold ${r.result === 'PASS' ? 'text-long' : r.result === 'BETWEEN' ? 'text-warn' : 'text-short'}`}>
                              {r.result === 'PASS' ? `PASS${bracketed ? ` (${r.passedAt.map((k) => k.toLowerCase()).join(' + ')})` : ''}` : r.result === 'BETWEEN' ? 'BETWEEN BOUNDS — UNRESOLVED' : 'MISMATCH'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {bracketed && <p className="mt-2 text-xs text-ink-400">Bracketed: PASS = within tolerance of at least one bound. BETWEEN BOUNDS = between the earliest and latest state but within tolerance of neither (cannot be resolved with 1-minute data).</p>}
                </>
              )}
            </Panel>
          ) : (
            <Panel title={<span className="text-short">No complete SIP reconstruction — fail closed</span>}>
              <p className="text-sm text-ink-300">The values could not all be rebuilt from historical SIP bars (see the issues above). Nothing is compared and no ticket is derived.</p>
            </Panel>
          )}

          {bounds.some((b) => b.derived) && (
            <Panel title="Derived RB v1 Ticket — Diagnostic Only">
              <p className="mb-2 rounded bg-short/15 px-3 py-2 text-sm font-black text-short">{DERIVED_LABEL}</p>
              <div className={`grid gap-4 ${bracketed ? 'lg:grid-cols-2' : ''}`}>
                {bounds.map((b) =>
                  b.derived ? (
                    <div key={b.key}>
                      {bracketed && <p className="mb-1 text-xs font-bold uppercase tracking-wider text-ink-300">{b.key.toLowerCase()} state (through {b.snapshot.cutoffEt} ET)</p>}
                      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                        {[
                          ['Side', b.derived.side],
                          ['Action', b.derived.action],
                          ['Order type', b.derived.orderType],
                          ['Entry trigger', money(b.derived.entry)],
                          ['Stop loss', money(b.derived.stop)],
                          ['Take profit', money(b.derived.target)],
                          ['Quantity', `${b.derived.shares} sh (limited by ${b.derived.limitedBy.toLowerCase()})`],
                          ['Risk / share', `${money(b.derived.riskPerShare)} (${b.derived.riskMethod.toLowerCase()})`],
                          ['Planned dollar risk', money(b.derived.plannedRisk)],
                          ['Potential profit', money(b.derived.potentialProfit)],
                          ['Position value', money(b.derived.positionValue)],
                          ['Reward : risk', `${b.derived.rewardRatio.toFixed(2)} : 1`],
                        ].map(([k, val]) => (
                          <div key={k} className="flex gap-2">
                            <dt className="text-ink-400">{k}:</dt>
                            <dd className="num font-semibold text-ink-100">{val}</dd>
                          </div>
                        ))}
                      </dl>
                      <p className="mt-2 text-xs text-ink-400">
                        Calculator status at the alert: <b className="text-ink-200">{b.derived.calcHeadline}</b>.{b.derived.hardFails.length > 0 && <> {b.derived.hardFails.join(' ')}</>}
                      </p>
                    </div>
                  ) : null,
                )}
              </div>
              <p className="mt-3 text-xs text-ink-400">Existing RB v1.1 calculator, frozen defaults, evaluated as of the alert (reconstructed close as price, 0 min elapsed). Not sent to the Live Alert Queue, Opportunity Ranker, portfolio, Journal, broker or TrendSpider.</p>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
