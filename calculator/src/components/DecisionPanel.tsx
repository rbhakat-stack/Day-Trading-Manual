import { useState } from 'react';
import {
  analyzeFill,
  calculationSteps,
  formatTicket,
  limitedByText,
  type TradeInputs,
  type TradePlan,
  type TradeResult,
} from '../engine/tradeCalculator';
import type { RbSettings } from '../engine/settings';
import { parseNum, pct, price, usd } from '../lib/format';
import { TIPS } from '../lib/tips';
import { InfoTip, Label, Panel, Row, toneClasses } from './ui';

interface Props {
  result: TradeResult | null;
  inputs: TradeInputs;
  settings: RbSettings;
  useMarketEntry: boolean;
  setUseMarketEntry: (v: boolean) => void;
  actualFill: string;
  setActualFill: (v: string) => void;
  onSave: () => void;
  savedFlash: boolean;
  onSendToRanker: () => void;
}

export function DecisionPanel({ result, inputs, settings, useMarketEntry, setUseMarketEntry, actualFill, setActualFill, onSave, savedFlash, onSendToRanker }: Props) {
  if (!result) {
    return (
      <Panel title="Trade decision">
        <div className="flex min-h-[18rem] flex-col items-center justify-center text-center">
          <div className="text-4xl font-black tracking-tight text-ink-600">— — —</div>
          <p className="mt-3 max-w-xs text-sm text-ink-400">
            Select LONG or SHORT, enter the signal candle, ATR and current price, then press <span className="font-semibold text-ink-200">CALCULATE TRADE</span>.
          </p>
          <p className="mt-2 text-xs text-ink-500">Or load a test scenario from the Inputs panel.</p>
        </div>
      </Panel>
    );
  }

  const t = toneClasses[result.tone];
  return (
    <div className="space-y-4">
      {/* 1. The one decision — impossible to miss */}
      <section aria-live="polite" className={`rounded-xl border-2 p-5 text-center ${t.card}`}>
        <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-300">
          {inputs.ticker || 'Ticker'} · {inputs.direction} alert
        </div>
        <div className={`mt-1 text-4xl font-black leading-tight tracking-tight sm:text-5xl ${t.text}`}>{result.headline}</div>
        {result.subhead && <div className="num mt-1 text-lg font-semibold text-ink-100">{result.subhead}</div>}
        {result.status && (
          <div className={`mx-auto mt-3 inline-block rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.14em] ${t.badge}`}>{result.status}</div>
        )}
      </section>

      {(result.errors.length > 0 || result.messages.length > 0 || result.warnings.length > 0) && (
        <div className="space-y-2">
          {result.errors.map((e, k) => (
            <Note key={`e${k}`} level="danger" text={e.message} />
          ))}
          {result.messages.map((m, k) => (
            <Note key={`m${k}`} level={m.level} text={m.text} />
          ))}
          {result.warnings.map((w, k) => (
            <Note key={`w${k}`} level="warn" text={w} />
          ))}
        </div>
      )}

      {result.action === 'MARKET_LATE_ENTRY' && result.chase && result.plan && result.marketPlan && (
        <LateEntryReview result={result} useMarketEntry={useMarketEntry} setUseMarketEntry={setUseMarketEntry} />
      )}

      {result.ready && result.ticket && <Ticket ticker={inputs.ticker} p={result.ticket} />}

      {!result.eligible && result.plan && (
        <div className="space-y-2">
          <p className="rounded-lg border border-short/50 bg-short-dim/40 px-3 py-2 text-sm text-[#ffc2cd]">
            <b className="uppercase tracking-wider text-short">Mathematically calculable ≠ eligible to trade.</b> The numbers below are shown for
            learning only. Copy, Save as active trade and Send to Opportunity Ranker are disabled.
          </p>
          <Ticket ticker={inputs.ticker} p={result.plan} disabled />
        </div>
      )}

      {result.ready && result.ticket && (
        <button
          type="button"
          onClick={onSendToRanker}
          className="w-full rounded-lg border-2 border-[#5b8cff] bg-[#13213f] py-3 text-sm font-bold uppercase tracking-[0.12em] text-[#bcd0ff] hover:bg-[#1a2c55]"
        >
          Send to Opportunity Ranker →
        </button>
      )}

      {result.ready && result.ticket && (
        <FillPanel p={result.ticket} actualFill={actualFill} setActualFill={setActualFill} />
      )}

      {(result.ticket ?? result.marketPlan ?? result.plan) && (
        <ShowCalculation p={(result.ticket ?? (useMarketEntry ? result.marketPlan : null) ?? result.plan)!} inputs={inputs} settings={settings} />
      )}

      {result.action !== 'INVALID_INPUT' && (
        <button
          type="button"
          onClick={onSave}
          className="w-full rounded-lg border border-ink-600 py-2.5 text-sm font-semibold text-ink-200 hover:bg-ink-700"
        >
          {savedFlash ? '✓ Saved to journal' : result.ready ? 'Save trade to journal' : result.eligible ? 'Save as skipped to journal' : 'Save as NOT ELIGIBLE to journal'}
        </button>
      )}
    </div>
  );
}

function Note({ level, text }: { level: 'info' | 'warn' | 'danger'; text: string }) {
  const c =
    level === 'danger' ? 'border-short/50 bg-short-dim/40 text-[#ffc2cd]' : level === 'warn' ? 'border-warn/50 bg-warn-dim/40 text-[#ffe2a8]' : 'border-ink-600 bg-ink-800 text-ink-200';
  return <p className={`rounded-lg border px-3 py-2 text-sm leading-snug ${c}`}>{text}</p>;
}

function LateEntryReview({ result, useMarketEntry, setUseMarketEntry }: { result: TradeResult; useMarketEntry: boolean; setUseMarketEntry: (v: boolean) => void }) {
  const p = result.plan!;
  const m = result.marketPlan!;
  const c = result.chase!;
  const d = p.decimals;
  return (
    <Panel title="Late entry — review before any market order" className="border-warn/50">
      <div className="grid grid-cols-2 gap-x-6">
        <Row label="Original trigger" value={price(p.entry, d)} />
        <Row label="Current price" value={price(m.entry, d)} />
        <Row label="Difference" value={usd(c.distance, d)} tone="warn" />
        <Row label="Difference in ATR" value={`${c.distanceAtr.toFixed(2)} ATR (limit ${c.thresholdAtr})`} tone="warn" />
      </div>
      <div className="mt-3 rounded-lg border border-ink-700 bg-ink-900 p-3">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">Recalculated if entered at the current price</div>
        <div className="grid grid-cols-2 gap-x-6">
          <Row label="Risk/share (R)" value={`${usd(m.riskPerShare, d)} vs ${usd(p.riskPerShare, d)} planned`} />
          <Row label="Stop" value={price(m.stop, d)} tone="short" />
          <Row label="Target" value={price(m.target, d)} tone="long" />
          <Row label="Shares" value={m.shares} />
          <Row label="Max loss" value={usd(m.maxLoss)} />
          <Row label="Potential profit" value={usd(m.potentialProfit)} />
        </div>
      </div>
      <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-lg border border-warn/40 p-3">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-[#f2b33d]" checked={useMarketEntry} onChange={(e) => setUseMarketEntry(e.target.checked)} />
        <span className="text-sm text-ink-200">
          <span className="font-semibold text-warn">Use current price as market entry.</span> Recalculates entry, structural risk, stop, target, size,
          loss and reward from {price(m.entry, d)}. The original trigger plan is discarded, not reused.
        </span>
      </label>
    </Panel>
  );
}

function Ticket({ ticker, p, disabled = false }: { ticker: string; p: TradePlan; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  const d = p.decimals;
  const isLong = p.direction === 'LONG';
  const copy = async () => {
    if (disabled) return;
    const text = formatTicket(ticker, p);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <section
      aria-disabled={disabled}
      className={`relative rounded-xl border bg-ink-850 ${disabled ? 'border-2 border-dashed border-short/60 opacity-60 grayscale' : isLong ? 'border-long/40' : 'border-short/40'}`}
    >
      <header className="flex items-center justify-between border-b border-ink-700 px-4 py-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-300">
          {disabled ? <span className="text-short">INVALID — DO NOT PLACE · </span> : 'Trade ticket — '}
          <span className={isLong ? 'text-long' : 'text-short'}>{p.direction} · {p.orderType}</span>
        </h2>
        <button
          type="button"
          onClick={copy}
          disabled={disabled}
          className="rounded-md bg-ink-700 px-3 py-1 text-xs font-bold uppercase tracking-wider text-ink-100 hover:bg-ink-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {disabled ? 'Copy disabled' : copied ? '✓ Copied' : 'Copy trade'}
        </button>
      </header>
      <div className="grid grid-cols-2 gap-px bg-ink-700 sm:grid-cols-4">
        <Big label={p.orderType === 'MARKET' ? 'Market entry' : 'Entry trigger'} tip={TIPS.entry} value={price(p.entry, d)} />
        <Big label="Stop loss" tip={TIPS.stop} value={price(p.stop, d)} tone="text-short" />
        <Big label="Take profit" tip={TIPS.target} value={price(p.target, d)} tone="text-long" />
        <Big label="Quantity" tip={TIPS.shares} value={`${p.shares}`} unit="sh" />
      </div>
      <div className="grid grid-cols-2 gap-x-6 px-4 py-3 sm:grid-cols-3">
        <Row label="Order type" tip={TIPS.orderType} value={p.orderType} strong />
        <Row label="Position value" tip={TIPS.positionValue} value={usd(p.positionValue)} strong />
        <Row label="Risk/share" tip={TIPS.r} value={usd(p.riskPerShare, d)} />
        <Row label="Max planned loss" tip={TIPS.maxLoss} value={usd(p.maxLoss)} tone="short" strong />
        <Row label="Potential profit" tip={TIPS.profit} value={usd(p.potentialProfit)} tone="long" strong />
        <Row label="Reward : Risk" tip={TIPS.rr} value={`${p.rewardRatio.toFixed(2)} : 1`} />
      </div>
      <p className="border-t border-ink-700 px-4 py-2 text-xs text-ink-400">
        Size {limitedByText(p)} · {pct(p.pctOfAccount, 1)} of account · Risk method:{' '}
        <span className="text-ink-200">{p.riskMethod === 'STRUCTURAL' ? 'STRUCTURAL STOP ≥ ATR' : 'ATR STOP > STRUCTURAL'}</span>
      </p>
    </section>
  );
}

function Big({ label, value, tip, tone = 'text-ink-100', unit }: { label: string; value: string; tip?: string; tone?: string; unit?: string }) {
  return (
    <div className="bg-ink-850 px-4 py-3">
      <div className="flex items-center text-[11px] font-medium uppercase tracking-wider text-ink-400">
        {label}
        {tip && <InfoTip text={tip} />}
      </div>
      <div className={`num select-all text-3xl font-bold tracking-tight ${tone}`}>
        {value}
        {unit && <span className="ml-1 text-sm font-medium text-ink-400">{unit}</span>}
      </div>
    </div>
  );
}

function FillPanel({ p, actualFill, setActualFill }: { p: TradePlan; actualFill: string; setActualFill: (v: string) => void }) {
  const fill = parseNum(actualFill);
  const a = Number.isFinite(fill) && fill > 0 ? analyzeFill(p, fill) : null;
  const d = p.decimals;
  return (
    <Panel title="After the order fills — planned vs actual">
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <div>
          <Label htmlFor="fill" tip={TIPS.fill}>Actual fill price</Label>
          <div className="flex items-center rounded-lg border border-ink-600 bg-ink-900 px-2.5 focus-within:border-[#5b8cff]">
            <span className="num mr-1 text-sm text-ink-400">$</span>
            <input id="fill" inputMode="decimal" value={actualFill} onChange={(e) => setActualFill(e.target.value)} placeholder="optional" className="num w-full bg-transparent py-2 text-[15px] outline-none placeholder:text-ink-500" />
          </div>
        </div>
        {a ? (
          <table className="num w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-ink-400">
                <th className="py-1 font-medium"></th>
                <th className="py-1 font-medium">Planned</th>
                <th className="py-1 font-medium">Actual</th>
              </tr>
            </thead>
            <tbody className="[&_td]:border-t [&_td]:border-ink-700/60 [&_td]:py-1">
              <tr><td className="font-sans text-ink-300">Entry</td><td>{price(p.entry, d)}</td><td className={a.slippagePerShare > 0 ? 'text-warn' : ''}>{price(a.actualEntry, d)} {a.slippagePerShare !== 0 && <span className="text-xs text-ink-400">({a.slippagePerShare > 0 ? 'worse' : 'better'} {usd(Math.abs(a.slippagePerShare), d)})</span>}</td></tr>
              <tr><td className="font-sans text-ink-300">Risk to stop</td><td>{usd(p.riskPerShare, d)}</td><td className={a.beyondStop ? 'text-short' : ''}>{usd(a.actualRiskPerShare, d)} ({a.riskInPlannedR.toFixed(2)}× plan)</td></tr>
              <tr><td className="font-sans text-ink-300">Reward to target</td><td>{usd(p.rewardPerShare, d)}</td><td>{usd(a.actualRewardPerShare, d)}</td></tr>
              <tr><td className="font-sans text-ink-300">Reward : Risk</td><td>{p.rewardRatio.toFixed(2)}</td><td className={a.actualRewardRatio < p.rewardRatio ? 'text-warn' : ''}>{a.actualRewardRatio.toFixed(2)}</td></tr>
              <tr><td className="font-sans text-ink-300">Position cost</td><td>{usd(p.positionValue)}</td><td>{usd(a.actualPositionCost)}</td></tr>
              <tr><td className="font-sans text-ink-300">Max loss</td><td>{usd(p.maxLoss)}</td><td className="text-short">{usd(a.actualMaxLoss)}</td></tr>
            </tbody>
          </table>
        ) : (
          <p className="self-center text-sm text-ink-400">Enter the actual fill after execution. The plan above is never overwritten; actual results are shown side by side. Stop and target stay where they are.</p>
        )}
      </div>
      {a?.beyondStop && <p className="mt-2 text-sm text-short">The fill is at or beyond the stop. Exit immediately and record what happened.</p>}
    </Panel>
  );
}

function ShowCalculation({ p, inputs, settings }: { p: TradePlan; inputs: TradeInputs; settings: RbSettings }) {
  const lines = calculationSteps(p, inputs, settings);
  return (
    <details className="rounded-xl border border-ink-700 bg-ink-850">
      <summary className="cursor-pointer select-none px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-300 hover:text-ink-100">
        Show calculation {p.entryMethod === 'MARKET' && '(market entry)'}
      </summary>
      <ol className="num space-y-1 border-t border-ink-700 px-4 py-3 text-[13px] text-ink-200">
        {lines.map((l, k) => (
          <li key={k} className="whitespace-pre-wrap">{l}</li>
        ))}
      </ol>
    </details>
  );
}
