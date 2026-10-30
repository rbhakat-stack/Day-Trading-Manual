import { useState } from 'react';
import { DEFAULT_AUTOMATION, type AutomationConfig } from '../../engine/automation/alertDecision';
import { checkHealth, parseClassificationCsv, type ClassMap } from '../../lib/automationClient';
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
