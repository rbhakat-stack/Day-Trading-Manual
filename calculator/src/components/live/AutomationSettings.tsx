import { useState } from 'react';
import { DEFAULT_AUTOMATION, type AutomationConfig } from '../../engine/automation/alertDecision';
import { checkHealth, classificationError, classificationsCsv, parseClassificationCsv, removeClassification, upsertClassification, type ClassMap } from '../../lib/automationClient';
import { Panel } from '../ui';

interface Props {
  cfg: AutomationConfig;
  setCfg: (c: AutomationConfig) => void;
  token: string;
  setToken: (t: string) => void;
  classes: ClassMap;
  setClasses: (c: ClassMap) => void;
}

const box = 'num w-full rounded border border-ink-600 bg-ink-900 px-2 py-1.5 text-[13px] outline-none focus:border-[#5b8cff]';

export function AutomationSettings({ cfg, setCfg, token, setToken, classes, setClasses }: Props) {
  const [health, setHealth] = useState<string>('');
  const [csv, setCsv] = useState('');
  const [csvMsg, setCsvMsg] = useState('');
  const num = (k: keyof AutomationConfig, scale = 1) => (
    <input type="number" step="any" className={box} value={+((cfg[k] as number) * scale).toFixed(6)} onChange={(e) => setCfg({ ...cfg, [k]: Number(e.target.value) / scale })} />
  );
  const tol = (k: keyof AutomationConfig['parity'], scale = 1) => (
    <input type="number" step="any" className={box} value={+(cfg.parity[k] * scale).toFixed(6)} onChange={(e) => setCfg({ ...cfg, parity: { ...cfg.parity, [k]: Number(e.target.value) / scale } })} />
  );
  return (
    <div className="space-y-4">
      <Panel title="Automated Alert Mode">
        <label className="flex items-center gap-3 text-sm text-ink-100">
          <input type="checkbox" className="h-5 w-5" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
          <b>{cfg.enabled ? 'ON' : 'OFF'}</b> — poll TrendSpider webhook alerts and build the Live Alert Queue (default OFF during development)
        </label>
        <p className="mt-2 text-xs text-ink-400">The manual Calculator and Opportunity Ranker remain fully available either way. The app never places, modifies or cancels orders.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
          <label className="block text-sm">
            <span className="mb-1 block text-[11px] uppercase tracking-wider text-ink-300">App access token (RB_APP_ACCESS_TOKEN)</span>
            <input type="password" autoComplete="off" className={box} value={token} onChange={(e) => setToken(e.target.value.trim())} placeholder="paste the value you set in Netlify" />
          </label>
          <button
            type="button"
            className="self-end rounded-lg border border-ink-600 px-3 py-2 text-xs font-semibold text-ink-200 hover:bg-ink-700"
            onClick={async () => {
              setHealth('checking…');
              try {
                const h = await checkHealth(token);
                setHealth(Object.entries(h.config).map(([k, v]) => `${k}: ${String(v)}`).join(' · ') + ` · ${h.execution}`);
              } catch (e) {
                setHealth((e as Error).message);
              }
            }}
          >
            Check server setup
          </button>
        </div>
        <p className="mt-1 text-xs text-ink-400">Stored only in this browser. It is <b>not</b> the webhook secret and not an Alpaca key — those exist only in Netlify.</p>
        {health && <p className="mt-2 break-words text-xs text-ink-200">{health}</p>}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Timing and data freshness">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <L t="Micro-batch window (s)">{num('batchMs', 1 / 1000)}</L>
            <L t="Max batch hold (s)">{num('maxBatchHoldMs', 1 / 1000)}</L>
            <L t="Alert poll interval (s)">{num('pollMs', 1 / 1000)}</L>
            <L t="Price poll interval (s)">{num('quotePollMs', 1 / 1000)}</L>
            <L t="Max market-data age (s)">{num('maxDataAgeSec')}</L>
            <L t="Max last-trade age (s)">{num('maxTradeAgeSec')}</L>
            <L t="Price mismatch % of price">{num('priceMismatchPct', 100)}</L>
            <L t="Price mismatch minimum $">{num('priceMismatchMin')}</L>
          </div>
          <p className="mt-2 text-xs text-ink-400">TrendSpider vs provider price mismatch = |Δ| &gt; MAX(minimum, % × price). Defaults: 3 s batch, 5 s data age, MAX($0.02, 0.10%). Rationale in AUTOMATION.md.</p>
        </Panel>
        <Panel title="Data-parity tolerances">
          <div className="grid grid-cols-3 gap-3 text-sm">
            <L t="Prices ±$">{tol('priceAbs')}</L>
            <L t="ATR ±%">{tol('atrPct', 100)}</L>
            <L t="EMA ±%">{tol('emaPct', 100)}</L>
            <L t="VWAP ±%">{tol('vwapPct', 100)}</L>
            <L t="RVOL ±%">{tol('rvolPct', 100)}</L>
            <L t="RSI ±pts">{tol('rsiPts')}</L>
          </div>
          <label className="mt-3 block text-sm">
            <span className="mb-1 block text-[11px] uppercase tracking-wider text-ink-300">Comparisons required before parity counts as validated</span>
            {num('parityRequired')}
          </label>
          <button type="button" onClick={() => setCfg({ ...DEFAULT_AUTOMATION, enabled: cfg.enabled })} className="mt-3 rounded-lg border border-ink-600 px-3 py-1.5 text-xs text-ink-200 hover:bg-ink-700">Reset automation defaults</button>
        </Panel>
      </div>

      <Panel title={`Sector / industry / theme (${Object.keys(classes).length} tickers) — used by the correlation rules`}>
        <p className="text-xs text-ink-400">
          The market-data provider does not supply sectors. A ticker without a sector is SCORING INCOMPLETE (never guessed). Paste a CSV once — <code>Ticker,Sector,Industry,Theme</code> — for your S&amp;P 500 universe, or classify tickers one at a time from the queue.
        </p>
        <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={4} className={`${box} mt-2 font-mono`} placeholder={'Ticker,Sector,Industry,Theme\nGM,Consumer Discretionary,Automobiles,Autos'} />
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            className="rounded-lg bg-[#3d6df2] px-3 py-1.5 text-xs font-bold text-white"
            onClick={() => {
              const { rows, errors } = parseClassificationCsv(csv);
              setClasses({ ...classes, ...rows });
              setCsvMsg(`${Object.keys(rows).length} imported${errors.length ? `; ${errors.length} skipped (${errors.slice(0, 3).join('; ')})` : ''}.`);
            }}
          >
            Import CSV
          </button>
          <span className="text-xs text-ink-300">{csvMsg}</span>
        </div>
        <ClassificationTable classes={classes} setClasses={setClasses} />
      </Panel>
    </div>
  );
}

function L({ t, children }: { t: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] uppercase tracking-wider text-ink-300">{t}</span>
      {children}
    </label>
  );
}

/** CR-02 — view, count, filter, export, edit one and delete one classification. The CSV import above is unchanged. */
function ClassificationTable({ classes, setClasses }: { classes: ClassMap; setClasses: (c: ClassMap) => void }) {
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<{ ticker: string; sector: string; industry: string; theme: string; isNew: boolean } | null>(null);
  const [err, setErr] = useState('');
  const tickers = Object.keys(classes).sort();
  const f = q.trim().toUpperCase();
  const shown = tickers.filter((t) => !f || t.includes(f) || `${classes[t].sector} ${classes[t].industry} ${classes[t].theme}`.toUpperCase().includes(f));
  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([classificationsCsv(classes)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rb-classifications.csv';
    a.click();
    URL.revokeObjectURL(url);
  };
  const saveEdit = () => {
    if (!edit) return;
    const e = classificationError(edit.ticker, edit);
    if (e) return setErr(e);
    setClasses(upsertClassification(classes, edit.ticker, edit));
    setEdit(null);
    setErr('');
  };
  const cellIn = (k: 'sector' | 'industry' | 'theme') => edit && <input aria-label={k} className={box} value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />;
  return (
    <div className="mt-4 border-t border-ink-700 pt-3" data-section="classifications">
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-sm text-ink-100">{tickers.length} classified tickers</b>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter ticker / sector / industry / theme" className={`${box} max-w-xs`} aria-label="Filter classifications" />
        <button type="button" onClick={() => { setEdit({ ticker: '', sector: '', industry: '', theme: '', isNew: true }); setErr(''); }} className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs text-ink-200 hover:bg-ink-700">Add ticker</button>
        <button type="button" onClick={exportCsv} disabled={!tickers.length} className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs text-ink-200 hover:bg-ink-700 disabled:opacity-40">Export CSV</button>
        {err && <span className="text-xs text-short">{err}</span>}
      </div>
      <div className="mt-2 max-h-80 overflow-auto rounded border border-ink-700">
        <table className="w-full text-[12.5px]">
          <thead className="sticky top-0 bg-ink-900 text-left text-ink-300">
            <tr><th className="px-2 py-1">Ticker</th><th className="px-2 py-1">Sector</th><th className="px-2 py-1">Industry</th><th className="px-2 py-1">Theme</th><th className="px-2 py-1" /></tr>
          </thead>
          <tbody>
            {edit?.isNew && (
              <tr className="border-t border-ink-700 bg-ink-850">
                <td className="px-2 py-1"><input aria-label="ticker" className={box} value={edit.ticker} onChange={(e) => setEdit({ ...edit, ticker: e.target.value.toUpperCase() })} /></td>
                <td className="px-2 py-1">{cellIn('sector')}</td><td className="px-2 py-1">{cellIn('industry')}</td><td className="px-2 py-1">{cellIn('theme')}</td>
                <td className="whitespace-nowrap px-2 py-1"><Btn onClick={saveEdit}>Save</Btn> <Btn onClick={() => setEdit(null)}>Cancel</Btn></td>
              </tr>
            )}
            {shown.map((t) => {
              const c = classes[t];
              const editing = edit && !edit.isNew && edit.ticker === t;
              return (
                <tr key={t} className="border-t border-ink-700/70" data-ticker={t}>
                  <td className="px-2 py-1 font-bold text-ink-100">{t}</td>
                  {editing ? (
                    <><td className="px-2 py-1">{cellIn('sector')}</td><td className="px-2 py-1">{cellIn('industry')}</td><td className="px-2 py-1">{cellIn('theme')}</td></>
                  ) : (
                    <><td className="px-2 py-1 text-ink-200">{c.sector}</td><td className="px-2 py-1 text-ink-300">{c.industry}</td><td className="px-2 py-1 text-ink-300">{c.theme}</td></>
                  )}
                  <td className="whitespace-nowrap px-2 py-1 text-right">
                    {editing ? (
                      <><Btn onClick={saveEdit}>Save</Btn> <Btn onClick={() => setEdit(null)}>Cancel</Btn></>
                    ) : (
                      <>
                        <Btn onClick={() => { setEdit({ ticker: t, ...c, isNew: false }); setErr(''); }}>Edit</Btn>{' '}
                        <Btn danger onClick={() => { if (window.confirm(`Delete the classification for ${t}? Its alerts will show SCORING INCOMPLETE until it is classified again.`)) setClasses(removeClassification(classes, t)); }}>Delete</Btn>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && <tr><td colSpan={5} className="px-2 py-3 text-center text-ink-400">No classifications match.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const Btn = ({ onClick, children, danger }: { onClick: () => void; children: React.ReactNode; danger?: boolean }) => (
  <button type="button" onClick={onClick} className={`rounded border px-2 py-0.5 text-[11px] ${danger ? 'border-short/60 text-short hover:bg-short-dim' : 'border-ink-600 text-ink-200 hover:bg-ink-700'}`}>{children}</button>
);
