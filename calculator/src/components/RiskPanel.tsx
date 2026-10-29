import type { TradeResult } from '../engine/tradeCalculator';
import { pct, price, usd } from '../lib/format';
import { TIPS } from '../lib/tips';
import { Panel, Row } from './ui';

export function RiskPanel({ result, atr, investment, useMarketEntry }: { result: TradeResult | null; atr: number; investment: number; useMarketEntry: boolean }) {
  const p = result ? result.ticket ?? (useMarketEntry ? result.marketPlan : null) ?? result.plan : null;
  if (!result || !p) {
    return (
      <Panel title="Risk analysis">
        <p className="text-sm text-ink-400">Risk metrics appear here after calculation.</p>
      </Panel>
    );
  }
  const d = p.decimals;
  const reference = !result.ready;
  const c = result.chase;
  return (
    <div className="space-y-4">
      <Panel
        title="Risk analysis"
        right={reference ? <span className="rounded bg-ink-700 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-ink-300">Reference only — not a trade</span> : null}
      >
        <div className={reference ? 'opacity-70' : ''}>
          <Row label="ATR(14)" tip={TIPS.atr} value={usd(atr, 3)} />
          <Row label={p.entryMethod === 'MARKET' ? 'Market entry' : 'Entry trigger'} tip={TIPS.entry} value={price(p.entry, d)} />
          {p.entryMethod === 'TRIGGER' && <Row label="Breakout buffer" tip={TIPS.buffer} value={usd(p.buffer, d)} />}
          <Row label="Structural risk" tip={TIPS.structural} value={usd(p.structuralRisk, 4)} tone={p.riskMethod === 'STRUCTURAL' ? 'warn' : undefined} />
          <Row label={`ATR risk (${(p.atrRisk / (atr || 1)).toFixed(2)} × ATR)`} tip={TIPS.atrRisk} value={usd(p.atrRisk, 4)} tone={p.riskMethod === 'ATR' ? 'warn' : undefined} />
          <Row label="Actual R / risk per share" tip={TIPS.r} value={usd(p.riskPerShare, d)} strong />
          <Row label="Risk method" value={p.riskMethod === 'STRUCTURAL' ? 'Structural stop' : 'ATR stop'} />
          <Row label="Reward per share" value={usd(p.rewardPerShare, d)} />
          <Row label="Reward : Risk" tip={TIPS.rr} value={`${p.rewardRatio.toFixed(2)} : 1`} />
        </div>
      </Panel>

      <Panel title="Position size">
        <div className={reference ? 'opacity-70' : ''}>
          <Row label="Max dollar risk" tip={TIPS.riskPct} value={usd(p.maxDollarRisk)} />
          <Row label="Risk-based shares" value={p.riskShares} tone={p.limitedBy !== 'INVESTMENT' ? 'warn' : undefined} />
          <Row label="Investment-cap shares" value={p.investmentShares} tone={p.limitedBy !== 'RISK' ? 'warn' : undefined} />
          <Row label="Final shares" tip={TIPS.shares} value={p.shares} strong />
          <Row label="Position value" tip={TIPS.positionValue} value={usd(p.positionValue)} strong />
          <Row label="% of account" value={pct(p.pctOfAccount, 1)} />
          <Row label="Max planned loss" tip={TIPS.maxLoss} value={usd(p.maxLoss)} tone="short" strong />
          <Row label="Potential gross profit" tip={TIPS.profit} value={usd(p.potentialProfit)} tone="long" strong />
          <p className="mt-2 rounded-md bg-ink-900 px-2.5 py-2 text-xs text-ink-300">
            {p.limitedBy === 'INVESTMENT'
              ? `Position size limited by the ${usd(investment, 0)} investment cap.`
              : p.limitedBy === 'RISK'
                ? `Position size limited by the ${usd(p.maxDollarRisk)} risk cap.`
                : 'Risk cap and investment cap give the same size.'}{' '}
            {usd(p.maxDollarRisk)} is a <span className="font-semibold text-ink-100">maximum</span> risk allowance, not an amount that must be risked.
          </p>
        </div>
      </Panel>

      {c && (
        <Panel title="Distance from trigger">
          <Row label="Trigger crossed?" value={c.crossed ? 'YES' : 'Not yet'} tone={c.crossed ? 'warn' : undefined} />
          <Row label={c.crossed ? 'Beyond trigger' : 'Distance to trigger'} value={usd(Math.abs(c.distance), d)} />
          <Row label="In ATR" tip={TIPS.chase} value={`${Math.abs(c.distanceAtr).toFixed(2)} ATR`} tone={c.crossed && c.distanceAtr > c.thresholdAtr ? 'danger' : c.crossed ? 'warn' : undefined} />
          <Row label="Chase limit" value={`${c.thresholdAtr} ATR = ${usd(c.thresholdDollars, 3)}`} />
          <p className="mt-2 text-[11px] leading-snug text-ink-400">The {c.thresholdAtr} ATR chase limit is an RB v1 paper-testing assumption, not a universal trading rule.</p>
        </Panel>
      )}
    </div>
  );
}
