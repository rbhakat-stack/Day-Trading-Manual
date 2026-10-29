import type { PortfolioSnapshot } from '../../engine/ranker/portfolioAllocator';
import { usd } from '../../lib/format';
import { ScoreBar } from './shared';

export function PortfolioBar({ pf, reservePct }: { pf: PortfolioSnapshot; reservePct: number }) {
  const heatPct = pf.heatLimit > 0 ? pf.heatCommitted / pf.heatLimit : 0;
  const capPct = pf.usableAllocation > 0 ? (pf.deployed + pf.reserved) / pf.usableAllocation : 0;
  const cell = 'min-w-0 px-4 py-3';
  const lab = 'text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-400';
  return (
    <section className="grid grid-cols-2 divide-ink-700 overflow-hidden rounded-xl border border-ink-700 bg-ink-850 sm:grid-cols-3 lg:grid-cols-6 lg:divide-x">
      <div className={cell}>
        <div className={lab}>Capital available</div>
        <div className={`num text-xl font-semibold ${pf.available <= 0 ? 'text-short' : 'text-long'}`}>{usd(pf.available, 0)}</div>
        <div className="mt-1"><ScoreBar points={capPct * 100} max={100} tone={capPct > 0.9 ? 'bg-short' : 'bg-[#5b8cff]'} /></div>
        <div className="mt-1 text-[11px] text-ink-400">of {usd(pf.usableAllocation, 0)} usable</div>
      </div>
      <div className={cell}>
        <div className={lab}>Deployed</div>
        <div className="num text-xl font-semibold text-ink-100">{usd(pf.deployed, 0)}</div>
        <div className="text-[11px] text-ink-400">active positions</div>
      </div>
      <div className={cell}>
        <div className={lab}>Reserved (pending)</div>
        <div className="num text-xl font-semibold text-warn">{usd(pf.reserved, 0)}</div>
        <div className="text-[11px] text-ink-400">{pf.pendingOrders} unfilled stop order(s)</div>
      </div>
      <div className={cell}>
        <div className={lab}>Positions</div>
        <div className="num text-xl font-semibold text-ink-100">
          {pf.openPositions} <span className="text-sm text-ink-400">open</span> + {pf.pendingOrders} <span className="text-sm text-ink-400">pending</span>
        </div>
        <div className="text-[11px] text-ink-400">{pf.slotsUsed} / {pf.maxPositions} slots</div>
      </div>
      <div className={cell}>
        <div className={lab}>Portfolio heat</div>
        <div className={`num text-xl font-semibold ${heatPct > 0.9 ? 'text-short' : 'text-ink-100'}`}>
          {usd(pf.heatCommitted, 0)} <span className="text-sm text-ink-400">/ {usd(pf.heatLimit, 0)}</span>
        </div>
        <div className="mt-1"><ScoreBar points={heatPct * 100} max={100} tone={heatPct > 0.9 ? 'bg-short' : 'bg-warn'} /></div>
        <div className="mt-1 text-[11px] text-ink-400">open {usd(pf.heatOpen, 0)} + pending</div>
      </div>
      <div className={cell}>
        <div className={lab}>RB v1 policy</div>
        <div className="text-[12px] leading-snug text-ink-300">
          Equity <span className="num text-ink-100">{usd(pf.equity, 0)}</span> · Max position <span className="num text-ink-100">{usd(pf.maxPositionValue, 0)}</span> · Reserve <span className="num text-ink-100">{Math.round(reservePct * 100)}%</span>
        </div>
        {pf.brokerBuyingPower !== null && (
          <div className="mt-1 text-[11px] text-ink-500">Broker buying power {usd(pf.brokerBuyingPower, 0)} — informational, not used</div>
        )}
      </div>
    </section>
  );
}
