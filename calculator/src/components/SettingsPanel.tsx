import { useEffect, useState } from 'react';
import { RB_V1_DEFAULTS, validateSettings, type RbSettings } from '../engine/settings';
import { parseNum } from '../lib/format';
import { Label, NumberField, Panel } from './ui';

type Draft = Record<string, string>;

const FIELDS: { key: keyof RbSettings; label: string; unit: 'usd' | 'pct' | 'x' | 'atr' | 'min'; help: string }[] = [
  { key: 'minBuffer', label: 'Minimum buffer', unit: 'usd', help: 'Smallest breakout buffer in dollars. RB v1: $0.01' },
  { key: 'bufferPct', label: 'Percentage buffer', unit: 'pct', help: '% of the signal High (LONG) / Low (SHORT). RB v1: 0.02%' },
  { key: 'atrStopMultiple', label: 'Minimum stop (ATR multiple)', unit: 'atr', help: 'R is never smaller than this × ATR. RB v1: 1.0' },
  { key: 'rewardMultiple', label: 'Reward / Risk multiple', unit: 'x', help: 'Take profit = Entry ± this × R. RB v1: 2' },
  { key: 'chaseThresholdAtr', label: 'Chase threshold', unit: 'atr', help: 'Beyond the trigger by more than this → SKIP. RB v1: 0.25 ATR (paper-testing assumption)' },
  { key: 'riskPct', label: 'Default risk per trade', unit: 'pct', help: '% of equity. RB v1: 0.25%' },
  { key: 'investmentCap', label: 'Default investment cap', unit: 'usd', help: 'Max notional per ticker. RB v1: $20,000' },
  { key: 'accountEquity', label: 'Default account equity', unit: 'usd', help: 'Paper account starts at $100,000' },
  { key: 'alertWindowMinutes', label: 'Maximum alert age', unit: 'min', help: 'No breakout after this many minutes → STALE. RB v1: 10 min' },
];

const toDraft = (s: RbSettings): Draft =>
  Object.fromEntries(FIELDS.map((f) => [f.key, String(f.unit === 'pct' ? +((s[f.key] as number) * 100).toFixed(6) : s[f.key])]));

/** Account equity is a normal input; every other field here is part of the strategy definition and is locked while frozen. */
const NON_CORE: (keyof RbSettings)[] = ['accountEquity'];

export function SettingsPanel({ settings, onSave, locked = false }: { settings: RbSettings; onSave: (s: RbSettings) => boolean; locked?: boolean }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings));
  const [pyramid, setPyramid] = useState(settings.allowPyramiding);
  const [win, setWin] = useState({ start: settings.entryWindowStart, end: settings.entryWindowEnd });
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setDraft(toDraft(settings));
    setPyramid(settings.allowPyramiding);
    setWin({ start: settings.entryWindowStart, end: settings.entryWindowEnd });
  }, [settings]);

  const build = (): RbSettings => {
    const next = { ...settings, allowPyramiding: pyramid, strategyMode: 'RB_V1_BREAKOUT' as const, entryWindowStart: win.start.trim(), entryWindowEnd: win.end.trim() };
    for (const f of FIELDS) {
      const n = parseNum(draft[f.key]);
      (next as Record<string, unknown>)[f.key] = f.unit === 'pct' ? n / 100 : n;
    }
    return next;
  };
  const save = () => {
    const next = build();
    const errs = validateSettings(next);
    setErrors(errs);
    if (!errs.length && onSave(next)) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    }
  };
  const isDefault = JSON.stringify(build()) === JSON.stringify({ ...RB_V1_DEFAULTS });

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Panel
        title="RB v1 settings"
        right={<span className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${isDefault ? 'bg-long-dim text-long' : 'bg-warn-dim text-warn'}`}>{isDefault ? 'RB v1 defaults' : 'Modified'}</span>}
      >
        <p className="mb-4 text-sm text-ink-300">
          Changing these changes your trading rules. {locked ? 'Strategy-definition fields are locked (only the default account equity can be changed).' : 'A change creates a new strategy version.'} Record any change (date, reason, evidence) in the manual's Change Log before using it.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {FIELDS.map((f) => (
            <div key={f.key}>
              <NumberField
                id={`set-${f.key}`}
                label={f.label}
                value={draft[f.key]}
                onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                disabled={locked && !NON_CORE.includes(f.key)}
                prefix={f.unit === 'usd' ? '$' : undefined}
                suffix={f.unit === 'pct' ? '%' : f.unit === 'atr' ? 'ATR' : f.unit === 'x' ? 'R' : f.unit === 'min' ? 'min' : undefined}
              />
              <p className="mt-1 text-xs text-ink-400">{f.help}</p>
            </div>
          ))}
          <div>
            <Label>New-entry window (ET) — hard rule</Label>
            <div className="flex items-center gap-2">
              <input aria-label="Entry window start" disabled={locked} value={win.start} onChange={(e) => setWin((w) => ({ ...w, start: e.target.value }))} className="num w-24 rounded-lg border border-ink-600 bg-ink-900 px-2 py-2 text-sm" />
              <span className="text-ink-400">to before</span>
              <input aria-label="Entry window end" disabled={locked} value={win.end} onChange={(e) => setWin((w) => ({ ...w, end: e.target.value }))} className="num w-24 rounded-lg border border-ink-600 bg-ink-900 px-2 py-2 text-sm" />
            </div>
            <p className="mt-1 text-xs text-ink-400">RB v1.1: 09:45 → 15:30. Before = TOO EARLY; from 15:30 = WINDOW CLOSED; outside 09:30–16:00 = AFTER/BEFORE SESSION. Shared with the Opportunity Ranker.</p>
          </div>
          <div>
            <Label>Strategy mode</Label>
            <select className="w-full rounded-lg border border-ink-600 bg-ink-900 px-2.5 py-2 text-sm" value="RB_V1_BREAKOUT" onChange={() => undefined}>
              <option value="RB_V1_BREAKOUT">RB v1 Breakout (default)</option>
              <option value="PULLBACK_EXPERIMENTAL" disabled>Pullback — Experimental (not implemented in v1)</option>
            </select>
            <p className="mt-1 text-xs text-ink-400">Limit/pullback entries are a different strategy and are intentionally not implemented.</p>
          </div>
          <div>
            <Label>Pyramiding (adding to an open position)</Label>
            <label className="flex items-center gap-2 rounded-lg border border-ink-600 bg-ink-900 px-2.5 py-2 text-sm">
              <input type="checkbox" disabled={locked} checked={pyramid} onChange={(e) => setPyramid(e.target.checked)} className="h-4 w-4 accent-[#f2b33d]" />
              Allow override (NOT RB v1)
            </label>
            <p className="mt-1 text-xs text-ink-400">RB v1: off. No pyramiding, no averaging up or down.</p>
          </div>
        </div>
        {errors.length > 0 && (
          <ul className="mt-4 space-y-1 text-sm text-short">
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" onClick={save} className="rounded-lg bg-[#3d6df2] px-5 py-2.5 text-sm font-bold uppercase tracking-wider text-white hover:bg-[#5580f5]">
            {saved ? '✓ Saved' : 'Save settings'}
          </button>
          <button
            type="button"
            onClick={() => {
              onSave({ ...RB_V1_DEFAULTS });
              setErrors([]);
            }}
            className="rounded-lg border border-ink-600 px-5 py-2.5 text-sm font-semibold text-ink-200 hover:bg-ink-700"
          >
            Reset to RB v1 defaults
          </button>
        </div>
      </Panel>
      <Panel title="Fixed RB v1 assumptions">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-300">
          <li>Entry timeframe: 5 minutes. ATR: ATR(14) on the same 5-minute chart.</li>
          <li>Buffer = MAX(min buffer, % × signal High for LONG / Low for SHORT), rounded to the nearest cent.</li>
          <li>R = MAX(structural risk, ATR multiple × ATR), rounded up to the next cent. Stop = Entry ∓ R. Target = Entry ± reward multiple × R.</li>
          <li>Shares = MIN(FLOOR(equity × risk% ÷ R), FLOOR(investment cap ÷ entry)). Always rounded down.</li>
          <li>Missed breakouts are skipped. Limit orders are never suggested to "catch" a missed breakout.</li>
          <li>No broker integration. Nothing is sent to Alpaca, SignalStack or TrendSpider.</li>
        </ul>
      </Panel>
    </div>
  );
}
