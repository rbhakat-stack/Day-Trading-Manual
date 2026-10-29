import { useState } from 'react';
import type { Candidate, ManualPosition } from '../../engine/ranker/opportunityTypes';
import type { PortfolioSnapshot } from '../../engine/ranker/portfolioAllocator';
import { SECTORS } from '../../engine/ranker/correlationRules';
import type { Direction } from '../../engine/tradeCalculator';
import { parseNum, price, usd } from '../../lib/format';
import { Panel, Segmented } from '../ui';

interface Props {
  positions: ManualPosition[];
  candidates: Candidate[];
  pf: PortfolioSnapshot;
  onAdd: (p: ManualPosition) => void;
  onUpdate: (id: string, patch: Partial<ManualPosition>) => void;
  onRemove: (id: string) => void;
}

const inp = 'num w-full rounded border border-ink-600 bg-ink-900 px-2 py-1.5 text-[13px] outline-none focus:border-[#5b8cff]';

export function PortfolioPanel({ positions, candidates, pf, onAdd, onUpdate, onRemove }: Props) {
  const open = positions.filter((p) => p.status === 'OPEN');
  const fromRanker = candidates.filter((c) => !c.archived && (c.status === 'FILLED' || c.status === 'PENDING'));
  return (
    <div className="space-y-4">
      <Panel title="Current portfolio (used for portfolio-fit scoring)">
        <p className="mb-3 text-sm text-ink-300">
          There is no broker connection, so the portfolio is maintained here. Ranker candidates marked <b>FILLED</b> or <b>PENDING</b> are included
          automatically. Add positions opened <i>outside</i> the ranker manually. Close them when they exit.
        </p>
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full min-w-[900px] text-[13px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-ink-400">
                {['Source', 'Ticker', 'Side', 'Sector / industry / theme', 'Position value', 'Planned risk remaining', 'Entry', 'Stop', 'Target', 'Status', ''].map((h) => (
                  <th key={h} className="px-2 py-1.5 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fromRanker.map((c) => (
                <tr key={c.id} className="border-t border-ink-700/70">
                  <td className="px-2 py-1.5 text-ink-400">Ranker</td>
                  <td className="num px-2 py-1.5 font-semibold">{c.ticker}</td>
                  <td className={`px-2 py-1.5 font-semibold ${c.direction === 'LONG' ? 'text-long' : 'text-short'}`}>{c.direction}</td>
                  <td className="px-2 py-1.5 text-ink-300">{[c.inputs.sector, c.inputs.industry, c.inputs.theme].filter(Boolean).join(' / ')}</td>
                  <td className="num px-2 py-1.5">{usd(c.positionValue, 0)}</td>
                  <td className="num px-2 py-1.5">{usd(c.plannedRisk)}</td>
                  <td className="num px-2 py-1.5">{price(c.entry)}</td>
                  <td className="num px-2 py-1.5 text-short">{price(c.stop)}</td>
                  <td className="num px-2 py-1.5 text-long">{price(c.target)}</td>
                  <td className="px-2 py-1.5">{c.status === 'FILLED' ? 'Active' : 'Pending (reserved)'}</td>
                  <td />
                </tr>
              ))}
              {open.map((p) => (
                <tr key={p.id} className="border-t border-ink-700/70">
                  <td className="px-2 py-1.5 text-ink-400">Manual</td>
                  <td className="num px-2 py-1.5 font-semibold">{p.ticker}</td>
                  <td className={`px-2 py-1.5 font-semibold ${p.direction === 'LONG' ? 'text-long' : 'text-short'}`}>{p.direction}</td>
                  <td className="px-2 py-1.5 text-ink-300">{[p.sector, p.industry, p.theme].filter(Boolean).join(' / ')}</td>
                  <td className="num px-2 py-1.5">{usd(p.positionValue, 0)}</td>
                  <td className="px-2 py-1.5">
                    <input className={`${inp} w-24`} defaultValue={p.plannedRisk} onBlur={(e) => { const n = parseNum(e.target.value); if (n >= 0) onUpdate(p.id, { plannedRisk: n }); }} />
                  </td>
                  <td className="num px-2 py-1.5">{price(p.entry)}</td>
                  <td className="num px-2 py-1.5 text-short">{price(p.stop)}</td>
                  <td className="num px-2 py-1.5 text-long">{price(p.target)}</td>
                  <td className="px-2 py-1.5">
                    <button type="button" className="rounded bg-ink-700 px-2 py-1 text-xs hover:bg-ink-600" onClick={() => onUpdate(p.id, { status: 'CLOSED' })}>Mark closed</button>
                  </td>
                  <td className="px-2 py-1.5">
                    <button type="button" aria-label="Delete" className="rounded px-2 py-1 text-ink-400 hover:bg-short-dim hover:text-short" onClick={() => confirm(`Delete ${p.ticker}?`) && onRemove(p.id)}>✕</button>
                  </td>
                </tr>
              ))}
              {fromRanker.length + open.length === 0 && (
                <tr><td colSpan={11} className="py-6 text-center text-ink-400">No open positions or pending orders.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>Deployed <span className="num block text-ink-100">{usd(pf.deployed, 0)}</span></div>
          <div>Reserved <span className="num block text-warn">{usd(pf.reserved, 0)}</span></div>
          <div>Available <span className="num block text-long">{usd(pf.available, 0)}</span></div>
          <div>Heat <span className="num block text-ink-100">{usd(pf.heatCommitted, 0)} / {usd(pf.heatLimit, 0)}</span></div>
        </div>
      </Panel>
      <AddPosition onAdd={onAdd} />
    </div>
  );
}

function AddPosition({ onAdd }: { onAdd: (p: ManualPosition) => void }) {
  const blank = { ticker: '', sector: '', industry: '', theme: '', positionValue: '', plannedRisk: '', entry: '', stop: '', target: '' };
  const [f, setF] = useState(blank);
  const [dir, setDir] = useState<Direction>('LONG');
  const [err, setErr] = useState('');
  const add = () => {
    const n = (k: keyof typeof blank) => parseNum(f[k]);
    if (!f.ticker.trim() || !f.sector.trim() || !(n('positionValue') > 0) || !(n('plannedRisk') >= 0)) {
      setErr('Ticker, sector, position value and planned risk are required.');
      return;
    }
    onAdd({
      id: `pos-${Date.now()}`, ticker: f.ticker.trim().toUpperCase(), direction: dir, sector: f.sector.trim(), industry: f.industry.trim(), theme: f.theme.trim(),
      positionValue: n('positionValue'), plannedRisk: n('plannedRisk'), entry: n('entry') || 0, stop: n('stop') || 0, target: n('target') || 0, status: 'OPEN',
    });
    setF(blank);
    setErr('');
  };
  const field = (k: keyof typeof blank, label: string) => (
    <div>
      <label className="mb-1 block text-[11px] uppercase tracking-wider text-ink-300">{label}</label>
      <input className={inp} list={k === 'sector' ? 'sector-list-2' : undefined} value={f[k]} onChange={(e) => setF((x) => ({ ...x, [k]: k === 'ticker' ? e.target.value.toUpperCase() : e.target.value }))} />
    </div>
  );
  return (
    <Panel title="Add a position opened outside the ranker">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {field('ticker', 'Ticker')}
        <div>
          <label className="mb-1 block text-[11px] uppercase tracking-wider text-ink-300">Side</label>
          <Segmented value={dir} onChange={setDir} options={[{ value: 'LONG', label: 'LONG', tone: 'long' }, { value: 'SHORT', label: 'SHORT', tone: 'short' }]} />
        </div>
        {field('sector', 'Sector')}
        {field('industry', 'Industry')}
        {field('theme', 'Theme')}
        {field('positionValue', 'Position value $')}
        {field('plannedRisk', 'Planned risk $')}
        {field('entry', 'Entry')}
        {field('stop', 'Stop')}
        {field('target', 'Target')}
      </div>
      <datalist id="sector-list-2">{SECTORS.map((s) => <option key={s} value={s} />)}</datalist>
      {err && <p className="mt-2 text-sm text-short">{err}</p>}
      <button type="button" onClick={add} className="mt-3 rounded-lg bg-[#3d6df2] px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:bg-[#5580f5]">Add position</button>
    </Panel>
  );
}
