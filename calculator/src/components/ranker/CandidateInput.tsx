import { useState, type FormEvent } from 'react';
import type { Candidate, RankingInputs } from '../../engine/ranker/opportunityTypes';
import { SECTORS } from '../../engine/ranker/correlationRules';
import { parseNum, price, usd } from '../../lib/format';
import { Label, NumberField, Panel, Row } from '../ui';
import { LAST_15M_HELP, lastCompleted15mCandle } from '../../engine/rules';

interface Props {
  candidate: Candidate | null;
  onScore: (id: string, inputs: RankingInputs, alertTime: string) => void;
}

type Draft = Record<'rvol' | 'rsi' | 'vwap' | 'ema9' | 'ema20' | 'close15m' | 'ema20_15m', string> & { sector: string; industry: string; theme: string; alertTime: string };

const toDraft = (c: Candidate): Draft => ({
  rvol: c.inputs.rvol?.toString() ?? '',
  rsi: c.inputs.rsi?.toString() ?? '',
  vwap: c.inputs.vwap?.toString() ?? '',
  ema9: c.inputs.ema9?.toString() ?? '',
  ema20: c.inputs.ema20?.toString() ?? '',
  close15m: c.inputs.close15m?.toString() ?? '',
  ema20_15m: c.inputs.ema20_15m?.toString() ?? '',
  sector: c.inputs.sector,
  industry: c.inputs.industry,
  theme: c.inputs.theme,
  alertTime: c.alertTime,
});

export function CandidateInput({ candidate, onScore }: Props) {
  if (!candidate) {
    return (
      <Panel title="Candidate input">
        <p className="text-sm text-ink-300">
          No candidate selected. In the <span className="font-semibold text-ink-100">Calculator</span>, calculate a valid trade and press{' '}
          <span className="font-semibold text-ink-100">Send to Opportunity Ranker</span>, or select a row in Active Candidates.
        </p>
      </Panel>
    );
  }
  return <Form key={candidate.id} c={candidate} onScore={onScore} />;
}

function Form({ c, onScore }: { c: Candidate; onScore: Props['onScore'] }) {
  const [d, setD] = useState<Draft>(() => toDraft(c));
  const [errors, setErrors] = useState<string[]>([]);
  const set = (k: keyof Draft) => (v: string) => setD((x) => ({ ...x, [k]: v }));
  const dp = c.entry >= 1 ? 2 : 4;
  const candle15 = lastCompleted15mCandle(d.alertTime);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const nums = {
      rvol: parseNum(d.rvol), rsi: parseNum(d.rsi), vwap: parseNum(d.vwap), ema9: parseNum(d.ema9), ema20: parseNum(d.ema20),
      close15m: parseNum(d.close15m), ema20_15m: parseNum(d.ema20_15m),
    };
    const errs: string[] = [];
    const names: Record<string, string> = { rvol: 'RVOL(20)', rsi: 'RSI(14)', vwap: 'VWAP', ema9: 'EMA9', ema20: 'EMA20', close15m: 'Last completed 15m Close', ema20_15m: 'Last completed 15m EMA20' };
    for (const [k, v] of Object.entries(nums)) if (!(v > 0)) errs.push(`MISSING INPUT: ${names[k]} is required and must be > 0.`);
    if (nums.rsi > 100) errs.push('RSI must be 0–100.');
    if (!d.sector.trim()) errs.push('Sector is required (used for correlation checks).');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.alertTime)) errs.push('Alert time must be HH:MM (24h, ET).');
    setErrors(errs);
    if (errs.length) return;
    onScore(c.id, { ...nums, sector: d.sector.trim(), industry: d.industry.trim(), theme: d.theme.trim() }, d.alertTime);
  };
  return (
    <Panel title="Candidate — fast entry">
      <div className="mb-3 rounded-lg border border-ink-700 bg-ink-900 p-3">
        <div className="flex items-baseline justify-between">
          <span className="num text-lg font-bold text-ink-100">{c.ticker}</span>
          <span className={`text-sm font-bold ${c.direction === 'LONG' ? 'text-long' : 'text-short'}`}>{c.direction} · {c.orderType}</span>
        </div>
        <div className="mt-1 text-[11px] uppercase tracking-wider text-ink-400">From Trade Calculator (read-only)</div>
        <div className="mt-1 grid grid-cols-2 gap-x-4">
          <Row label="Entry" value={price(c.entry, dp)} />
          <Row label="Shares" value={c.shares} />
          <Row label="Stop" value={price(c.stop, dp)} tone="short" />
          <Row label="Target" value={price(c.target, dp)} tone="long" />
          <Row label="Position" value={usd(c.positionValue, 0)} />
          <Row label="Risk" value={usd(c.plannedRisk)} />
          <Row label="ATR" value={c.atr.toString()} />
          <Row label="Price" value={price(c.currentPrice, dp)} />
          <Row label="Setup" value={c.calcAction.replace(/_/g, ' ')} />
          <Row label="vs entry" value={c.chaseDistanceAtr === null ? '—' : `${c.chaseDistanceAtr > 0 ? '+' : ''}${c.chaseDistanceAtr.toFixed(2)} ATR`} />
        </div>
        <div className="num mt-1 text-[11px] text-ink-400">O {c.open} · H {c.high} · L {c.low} · C {c.close}</div>
      </div>

      <form onSubmit={submit} noValidate className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <NumberField id="r-rvol" label="RVOL(20)" value={d.rvol} onChange={set('rvol')} placeholder="2.4" />
          <NumberField id="r-rsi" label="RSI(14)" value={d.rsi} onChange={set('rsi')} placeholder="64" />
          <NumberField id="r-time" label="Alert ET" value={d.alertTime} onChange={set('alertTime')} inputMode="numeric" placeholder="10:05" />
          <NumberField id="r-vwap" label="VWAP" value={d.vwap} onChange={set('vwap')} />
          <NumberField id="r-ema9" label="EMA9" value={d.ema9} onChange={set('ema9')} />
          <NumberField id="r-ema20" label="EMA20" value={d.ema20} onChange={set('ema20')} />
          <NumberField id="r-c15" label="Last completed 15m Close" tip={LAST_15M_HELP} value={d.close15m} onChange={set('close15m')} />
          <NumberField id="r-e15" label="Last completed 15m EMA20" tip={LAST_15M_HELP} value={d.ema20_15m} onChange={set('ema20_15m')} />
        </div>
        <p className="text-[11px] leading-snug text-ink-400">
          {candle15 ? <>For an alert at <b className="text-ink-200">{d.alertTime}</b> use the <b className="text-ink-200">{candle15.start}–{candle15.end}</b> 15-minute candle. </> : null}
          {LAST_15M_HELP}
        </p>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <Label htmlFor="r-sector">Sector</Label>
            <input id="r-sector" list="sector-list" value={d.sector} onChange={(e) => set('sector')(e.target.value)} className="w-full rounded-lg border border-ink-600 bg-ink-900 px-2 py-2 text-sm outline-none focus:border-[#5b8cff]" />
            <datalist id="sector-list">{SECTORS.map((s) => <option key={s} value={s} />)}</datalist>
          </div>
          <div>
            <Label htmlFor="r-ind">Industry</Label>
            <input id="r-ind" value={d.industry} onChange={(e) => set('industry')(e.target.value)} className="w-full rounded-lg border border-ink-600 bg-ink-900 px-2 py-2 text-sm outline-none focus:border-[#5b8cff]" />
          </div>
          <div>
            <Label htmlFor="r-theme">Theme</Label>
            <input id="r-theme" value={d.theme} onChange={(e) => set('theme')(e.target.value)} className="w-full rounded-lg border border-ink-600 bg-ink-900 px-2 py-2 text-sm outline-none focus:border-[#5b8cff]" placeholder="optional" />
          </div>
        </div>
        {errors.length > 0 && <ul className="space-y-0.5 text-xs text-short">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
        <button type="submit" className="w-full rounded-lg bg-[#3d6df2] py-3 text-sm font-bold uppercase tracking-[0.12em] text-white hover:bg-[#5580f5]">
          {c.scored ? 'Re-score opportunity' : 'Score opportunity'}
        </button>
        <p className="text-[11px] leading-snug text-ink-500">
          Re-scoring updates the live score. The initial score recorded the first time is never overwritten.
        </p>
      </form>
    </Panel>
  );
}
