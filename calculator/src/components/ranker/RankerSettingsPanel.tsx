import { useEffect, useState } from 'react';
import { COMPONENT_LABELS, FIT_KEYS, SETUP_KEYS, type ComponentKey } from '../../engine/ranker/opportunityTypes';
import { cloneRankerDefaults, DEFAULT_MAX, totalWeight, validateRankerSettings, type RankerSettings } from '../../engine/ranker/rankerSettings';
import { Panel } from '../ui';

const box = 'num w-full rounded border border-ink-600 bg-ink-900 px-2 py-1.5 text-[13px] outline-none focus:border-[#5b8cff]';

function Num({ value, onChange, scale = 1, step = 'any', className = '', disabled = false }: { value: number | null; onChange: (n: number) => void; scale?: number; step?: string; className?: string; disabled?: boolean }) {
  const [txt, setTxt] = useState(value === null ? '' : String(+(value * scale).toFixed(6)));
  useEffect(() => setTxt(value === null ? '' : String(+(value * scale).toFixed(6))), [value, scale]);
  return (
    <input
      type="number"
      step={step}
      disabled={disabled}
      className={`${box} ${className} disabled:opacity-50`}
      value={txt}
      onChange={(e) => {
        setTxt(e.target.value);
        onChange(e.target.value === '' ? NaN : Number(e.target.value) / scale);
      }}
    />
  );
}

/** `locked` makes every strategy-definition control read-only (RB v1.1 frozen). Account equity and buying power stay editable. */
export function RankerSettingsPanel({ settings, onChange, locked = false }: { settings: RankerSettings; onChange: (s: RankerSettings) => void; locked?: boolean }) {
  const [d, setD] = useState<RankerSettings>(() => structuredClone(settings));
  useEffect(() => setD(structuredClone(settings)), [settings]);
  const errors = validateRankerSettings(d);
  const update = (fn: (x: RankerSettings) => void) => {
    const next = structuredClone(d);
    fn(next);
    setD(next);
    if (validateRankerSettings(next).length === 0) onChange(next); // valid changes apply immediately
  };
  const isDefault = JSON.stringify(settings) === JSON.stringify(cloneRankerDefaults());
  const sum = totalWeight(d.weights);
  const wRow = (k: ComponentKey) => (
    <div key={k} className="grid grid-cols-[1fr_5rem] items-center gap-2">
      <span className="text-sm text-ink-300">{COMPONENT_LABELS[k]} <span className="text-ink-500">(default {DEFAULT_MAX[k]})</span></span>
      <Num disabled={locked} value={d.weights[k]} onChange={(n) => update((x) => void (x.weights[k] = n))} />
    </div>
  );
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-warn/50 bg-warn-dim/30 p-4 text-sm text-[#ffe2a8]">
        <b>The current weights are hypotheses for paper testing, not proven predictive relationships.</b> Nothing is optimised or changed automatically.
        Change weights only after the Analytics page shows a meaningful sample (≥ {d.minSampleForAnalysis} trades per bucket), and record every change in the manual's Change Log.
      </section>
      <div className="flex flex-wrap items-center gap-3">
        <span className={`rounded px-2 py-1 text-[11px] font-bold uppercase tracking-wider ${errors.length ? 'bg-short-dim text-short' : isDefault ? 'bg-long-dim text-long' : 'bg-warn-dim text-warn'}`}>
          {errors.length ? 'Invalid — not applied' : isDefault ? 'RB v1 defaults' : 'Modified — applied live'}
        </span>
        <button type="button" onClick={() => onChange(cloneRankerDefaults())} className="rounded-lg border border-ink-600 px-4 py-2 text-sm font-semibold text-ink-200 hover:bg-ink-700">
          Reset to RB v1.1 defaults
        </button>
      </div>
      {errors.length > 0 && <ul className="space-y-1 text-sm text-short">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={`Score weights — total ${+sum.toFixed(2)} / 100`}>
          <div className="space-y-1.5">
            <div className="text-[11px] uppercase tracking-wider text-ink-400">Setup quality ({SETUP_KEYS.reduce((a, k) => a + (d.weights[k] || 0), 0)})</div>
            {SETUP_KEYS.map(wRow)}
            <div className="pt-2 text-[11px] uppercase tracking-wider text-ink-400">Portfolio fit ({FIT_KEYS.reduce((a, k) => a + (d.weights[k] || 0), 0)})</div>
            {FIT_KEYS.map(wRow)}
          </div>
          <p className="mt-2 text-xs text-ink-400">Band points below are on each category's default scale and are rescaled to the weight.</p>
        </Panel>

        <Panel title="Portfolio policy">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <L t="Account equity $"><Num value={d.portfolio.accountEquity} onChange={(n) => update((x) => void (x.portfolio.accountEquity = n))} /></L>
            <L t="Max single position $"><Num disabled={locked} value={d.portfolio.maxPositionValue} onChange={(n) => update((x) => void (x.portfolio.maxPositionValue = n))} /></L>
            <L t="Max positions"><Num disabled={locked} value={d.portfolio.maxPositions} step="1" onChange={(n) => update((x) => void (x.portfolio.maxPositions = n))} /></L>
            <L t="Liquidity reserve %"><Num disabled={locked} value={d.portfolio.liquidityReservePct} scale={100} onChange={(n) => update((x) => void (x.portfolio.liquidityReservePct = n))} /></L>
            <L t="Max risk per trade %"><Num disabled={locked} value={d.portfolio.riskPerTradePct} scale={100} onChange={(n) => update((x) => void (x.portfolio.riskPerTradePct = n))} /></L>
            <L t="Portfolio heat limit %"><Num disabled={locked} value={d.portfolio.heatPct} scale={100} onChange={(n) => update((x) => void (x.portfolio.heatPct = n))} /></L>
            <L t="Replacement advantage (pts)"><Num disabled={locked} value={d.replacementAdvantage} onChange={(n) => update((x) => void (x.replacementAdvantage = n))} /></L>
            <L t="Broker buying power $ (info only)">
              <input type="number" className={box} value={d.portfolio.brokerBuyingPower ?? ''} onChange={(e) => update((x) => void (x.portfolio.brokerBuyingPower = e.target.value === '' ? null : Number(e.target.value)))} placeholder="optional" />
            </L>
          </div>
          <p className="mt-2 text-xs text-ink-400">
            Usable allocation = equity × (1 − reserve) = ${(d.portfolio.accountEquity * (1 - d.portfolio.liquidityReservePct)).toLocaleString('en-US')}. Broker buying power is displayed only and never used as the budget.
          </p>
        </Panel>

        <Panel title="Correlation policy">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <L t="Max highly correlated per theme"><Num disabled={locked} value={d.correlation.maxHighlyCorrelated} step="1" onChange={(n) => update((x) => void (x.correlation.maxHighlyCorrelated = n))} /></L>
            <label className="flex items-center gap-2 self-end pb-1.5 text-ink-200">
              <input type="checkbox" disabled={locked} className="h-4 w-4" checked={d.correlation.hardBlock} onChange={(e) => update((x) => void (x.correlation.hardBlock = e.target.checked))} /> Hard block
            </label>
            <label className="col-span-2 flex items-center gap-2 text-ink-200" title={OPPOSITE_TIP}>
              <input
                type="checkbox"
                disabled={locked}
                className="h-4 w-4"
                aria-label="Allow opposite-direction positions in the same correlated theme"
                checked={d.correlation.allowOppositeDirection}
                onChange={(e) => update((x) => void (x.correlation.allowOppositeDirection = e.target.checked))}
              />
              Allow opposite-direction positions in the same correlated theme <span className="text-ink-500">(default OFF)</span>
            </label>
          </div>
          <p className="mt-2 text-xs text-ink-400">{OPPOSITE_TIP}</p>
          <p className="mt-1 text-xs text-ink-400">HIGH overlap = same industry or same theme. SECTOR overlap = same sector only.</p>
        </Panel>

        <Panel title="Score thresholds (central — used everywhere)">
          <div className="grid grid-cols-4 gap-2 text-sm">
            {(['elite', 'high', 'watchlist', 'low'] as const).map((k, i) => (
              <L key={k} t={['Elite ≥', 'High priority ≥ (min trade)', 'Watchlist ≥', 'Low priority ≥'][i]}><Num disabled={locked} value={d.grades[k]} onChange={(n) => update((x) => void (x.grades[k] = n))} /></L>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-400">
            ≥ {d.grades.elite} ELITE — PREFERRED CAPITAL ALLOCATION · ≥ {d.grades.high} HIGH PRIORITY (minimum score for any trade) · ≥ {d.grades.watchlist} WATCHLIST / RESERVE ·
            ≥ {d.grades.low} LOW PRIORITY · below SKIP. A high rank never overrides these absolute thresholds.
          </p>
        </Panel>

        <Panel title="RVOL bands (points out of 15)">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[10px] uppercase tracking-wider text-ink-400"><th className="pb-1">RVOL ≥</th><th className="pb-1">Points</th><th className="pb-1">Label</th></tr></thead>
            <tbody>
              {d.rvolBands.map((b, i) => (
                <tr key={i}>
                  <td className="pr-2 py-0.5"><Num disabled={locked} value={b.min} onChange={(n) => update((x) => void (x.rvolBands[i].min = n))} /></td>
                  <td className="pr-2 py-0.5"><Num disabled={locked} value={b.points} onChange={(n) => update((x) => void (x.rvolBands[i].points = n))} /></td>
                  <td className="py-0.5"><input disabled={locked} className={`${box} disabled:opacity-50`} value={b.label} onChange={(e) => update((x) => void (x.rvolBands[i].label = e.target.value))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-ink-400">Below the first band = 0 points.</p>
        </Panel>

        <Panel title="RSI bands — LONG (points out of 10)">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[10px] uppercase tracking-wider text-ink-400"><th className="pb-1">From ≥</th><th className="pb-1">To &lt;</th><th className="pb-1">Points</th></tr></thead>
            <tbody>
              {d.rsiBandsLong.map((b, i) => (
                <tr key={i}>
                  <td className="pr-2 py-0.5"><Num disabled={locked} value={b.from} onChange={(n) => update((x) => void (x.rsiBandsLong[i].from = n))} /></td>
                  <td className="pr-2 py-0.5"><Num disabled={locked} value={b.to} onChange={(n) => update((x) => void (x.rsiBandsLong[i].to = n))} /></td>
                  <td className="py-0.5"><Num disabled={locked} value={b.points} onChange={(n) => update((x) => void (x.rsiBandsLong[i].points = n))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-ink-400">SHORT uses the mirror: score(100 − RSI). E.g. SHORT RSI 33 is scored like LONG RSI 67.</p>
        </Panel>

        <Panel title="Time-of-day buckets (ET, points out of 10)">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[10px] uppercase tracking-wider text-ink-400"><th className="pb-1">Starts</th><th className="pb-1">Label</th><th className="pb-1">Points</th></tr></thead>
            <tbody>
              {d.timeBuckets.map((b, i) => (
                <tr key={i}>
                  <td className="pr-2 py-0.5 w-24"><input disabled={locked} className={`${box} disabled:opacity-50`} value={b.start} onChange={(e) => update((x) => void (x.timeBuckets[i].start = e.target.value))} /></td>
                  <td className="pr-2 py-0.5"><input disabled={locked} className={`${box} disabled:opacity-50`} value={b.label} onChange={(e) => update((x) => void (x.timeBuckets[i].label = e.target.value))} /></td>
                  <td className="py-0.5 w-20"><Num disabled={locked} value={b.points} onChange={(n) => update((x) => void (x.timeBuckets[i].points = n))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-ink-400">
            Buckets score only alerts inside the entry window (set in the Calculator's Settings, default 09:45–15:30 ET). Before 09:45 or from 15:30 is a
            hard fail and never receives time points. Paper-testing assumptions; validate them in Analytics.
          </p>
        </Panel>
      </div>
    </div>
  );
}

const OPPOSITE_TIP =
  'OFF means both LONG and SHORT positions count toward the correlated-theme cap. This is the conservative RB v1.1 default. Turn ON only if you intentionally want opposite-direction positions treated as hedged exposure.';

function L({ t, children }: { t: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] uppercase tracking-wider text-ink-300">{t}</span>
      {children}
    </label>
  );
}
