import type { FormEvent } from 'react';
import type { ValidationIssue } from '../engine/validation';
import type { TradeInputs } from '../engine/tradeCalculator';
import { SCENARIOS } from '../engine/scenarios';
import type { FormState } from '../lib/form';
import { parseNum, usd } from '../lib/format';
import { TIPS } from '../lib/tips';
import { InfoTip, Label, NumberField, Panel, Segmented } from './ui';
import { LAST_15M_HELP, lastCompleted15mCandle } from '../engine/rules';
import { nowEt } from '../lib/time';

interface Props {
  form: FormState;
  setField: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  errors: ValidationIssue[];
  showErrors: boolean;
  onCalculate: () => void;
  onClear: () => void;
  onLoadScenario: (id: string) => void;
  timeframeMinutes: number;
}

export function InputPanel({ form, setField, errors, showErrors, onCalculate, onClear, onLoadScenario, timeframeMinutes }: Props) {
  const err = (f: keyof TradeInputs) => (showErrors ? errors.find((e) => e.field === f)?.message : undefined);
  const equity = parseNum(form.accountEquity);
  const riskPct = parseNum(form.riskPctDisplay) / 100;
  const dollarRisk = Number.isFinite(equity) && Number.isFinite(riskPct) ? equity * riskPct : NaN;
  const minutes = parseNum(form.minutesSinceAlert);
  const candle15 = lastCompleted15mCandle(form.alertTime);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onCalculate();
  };

  return (
    <Panel
      title="Inputs — from the TrendSpider alert"
      right={
        <select
          aria-label="Load test scenario"
          className="max-w-[9.5rem] rounded-md border border-ink-600 bg-ink-900 px-1.5 py-1 text-xs text-ink-300"
          value=""
          onChange={(e) => e.target.value && onLoadScenario(e.target.value)}
        >
          <option value="">Load test scenario…</option>
          {SCENARIOS.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <div>
            <Label htmlFor="ticker">Ticker</Label>
            <input
              id="ticker"
              value={form.ticker}
              onChange={(e) => setField('ticker', e.target.value.toUpperCase())}
              placeholder="e.g. IBM"
              autoComplete="off"
              className="num w-full rounded-lg border border-ink-600 bg-ink-900 px-2.5 py-2 text-[15px] uppercase text-ink-100 outline-none placeholder:normal-case placeholder:text-ink-500 focus:border-[#5b8cff]"
            />
          </div>
        </div>

        <div>
          <Label tip={TIPS.direction}>Alert direction</Label>
          <Segmented
            size="lg"
            value={form.direction}
            onChange={(v) => setField('direction', v)}
            options={[
              { value: 'LONG', label: 'LONG', tone: 'long' },
              { value: 'SHORT', label: 'SHORT', tone: 'short' },
            ]}
          />
        </div>

        <fieldset>
          <legend className="mb-2 flex items-center text-[11px] font-semibold uppercase tracking-wider text-ink-200">
            Signal candle (5-min)
            <InfoTip text={TIPS.ohlc} />
          </legend>
          <div className="grid grid-cols-2 gap-3">
            <NumberField id="open" label="Open (O)" prefix="$" value={form.open} onChange={(v) => setField('open', v)} error={err('open')} />
            <NumberField id="high" label="High (H)" prefix="$" value={form.high} onChange={(v) => setField('high', v)} error={err('high')} />
            <NumberField id="low" label="Low (L)" prefix="$" value={form.low} onChange={(v) => setField('low', v)} error={err('low')} />
            <NumberField id="close" label="Close (C)" prefix="$" value={form.close} onChange={(v) => setField('close', v)} error={err('close')} />
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <NumberField id="atr" label="ATR(14) 5-min" tip={TIPS.atr} prefix="$" value={form.atr} onChange={(v) => setField('atr', v)} error={err('atr')} placeholder="0.157" />
          <NumberField id="current" label="Current price" tip={TIPS.currentPrice} prefix="$" value={form.currentPrice} onChange={(v) => setField('currentPrice', v)} error={err('currentPrice')} />
        </div>

        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <NumberField id="alertTime" label="Alert time (ET, 24h)" tip={TIPS.alertTime} inputMode="numeric" value={form.alertTime} onChange={(v) => setField('alertTime', v)} error={err('alertTime')} placeholder="10:05" />
          <button type="button" onClick={() => setField('alertTime', nowEt().time)} className="mb-[1px] rounded-lg border border-ink-600 px-3 py-2 text-xs font-semibold text-ink-200 hover:bg-ink-700">
            Now
          </button>
        </div>

        <fieldset className="rounded-lg border border-ink-700 p-3">
          <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-200">15m confirmation (hard rule)</legend>
          <div className="grid grid-cols-2 gap-3">
            <NumberField id="close15m" label="Last completed 15m Close" tip={LAST_15M_HELP} prefix="$" value={form.close15m} onChange={(v) => setField('close15m', v)} error={err('close15m')} />
            <NumberField id="ema20_15m" label="Last completed 15m EMA20" tip={LAST_15M_HELP} prefix="$" value={form.ema20_15m} onChange={(v) => setField('ema20_15m', v)} error={err('ema20_15m')} />
          </div>
          <p className="mt-2 text-[11px] leading-snug text-ink-400">
            {candle15 ? <>For an alert at <b className="text-ink-200">{form.alertTime}</b> use the <b className="text-ink-200">{candle15.start}–{candle15.end}</b> candle. </> : null}
            {LAST_15M_HELP}
          </p>
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <NumberField
            id="minutes"
            label="Minutes since alert"
            tip={TIPS.minutes}
            suffix="min"
            inputMode="numeric"
            value={form.minutesSinceAlert}
            onChange={(v) => setField('minutesSinceAlert', v)}
            error={err('minutesSinceAlert')}
            placeholder="optional"
          />
          <div className="self-end pb-2 text-xs text-ink-400">
            {Number.isFinite(minutes) ? `≈ ${Math.floor(minutes / timeframeMinutes)} five-minute candle(s)` : 'Prefer a trigger within 1–2 candles'}
          </div>
        </div>

        <div className="rounded-lg border border-ink-700 p-3">
          <Label tip={TIPS.openPosition}>Already have an open position in this ticker?</Label>
          <Segmented
            value={form.hasOpenPosition ? 'YES' : 'NO'}
            onChange={(v) => setField('hasOpenPosition', v === 'YES')}
            options={[
              { value: 'NO', label: 'No' },
              { value: 'YES', label: 'Yes' },
            ]}
          />
          {form.hasOpenPosition && (
            <div className="mt-2">
              <Label>Existing position direction</Label>
              <Segmented
                value={form.openPositionDirection}
                onChange={(v) => setField('openPositionDirection', v)}
                options={[
                  { value: 'LONG', label: 'LONG', tone: 'long' },
                  { value: 'SHORT', label: 'SHORT', tone: 'short' },
                ]}
              />
            </div>
          )}
        </div>

        <details className="group rounded-lg border border-ink-700 p-3" open>
          <summary className="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-wider text-ink-200">Account & sizing</summary>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <NumberField id="invest" label="Max investment" tip={TIPS.investment} prefix="$" value={form.investmentAmount} onChange={(v) => setField('investmentAmount', v)} error={err('investmentAmount')} />
            <NumberField id="equity" label="Account equity" tip={TIPS.equity} prefix="$" value={form.accountEquity} onChange={(v) => setField('accountEquity', v)} error={err('accountEquity')} />
            <NumberField id="riskpct" label="Max risk" tip={TIPS.riskPct} suffix="%" value={form.riskPctDisplay} onChange={(v) => setField('riskPctDisplay', v)} error={err('riskPct')} />
            <div className="self-end pb-2 text-sm">
              <span className="text-ink-400">= </span>
              <span className="num text-ink-100">{Number.isFinite(dollarRisk) ? usd(dollarRisk) : '—'}</span>
              <span className="text-ink-400"> max loss</span>
            </div>
          </div>
        </details>

        <div className="flex gap-2">
          <button
            type="submit"
            className="flex-1 rounded-lg bg-[#3d6df2] py-3 text-sm font-bold uppercase tracking-[0.12em] text-white shadow-lg shadow-[#3d6df2]/20 hover:bg-[#5580f5] active:translate-y-px"
          >
            Calculate trade
          </button>
          <button type="button" onClick={onClear} className="rounded-lg border border-ink-600 px-4 text-sm text-ink-300 hover:bg-ink-700">
            Clear
          </button>
        </div>
      </form>
    </Panel>
  );
}
