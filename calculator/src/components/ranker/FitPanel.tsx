import { useState } from 'react';
import type { RankedCandidate, ReplacementSuggestion } from '../../engine/ranker/candidateRanker';
import { assessCorrelation } from '../../engine/ranker/correlationRules';
import { LIFECYCLE_LABELS, type Candidate, type LifecycleStatus } from '../../engine/ranker/opportunityTypes';
import type { RankerSettings } from '../../engine/ranker/rankerSettings';
import { asClassified } from '../../engine/ranker/opportunityScorer';
import { candidatePnl, candidateR } from '../../engine/ranker/rankerAnalytics';
import { parseNum, signedR, signedUsd, usd } from '../../lib/format';
import { Panel, Row } from '../ui';
import { ScoreBar } from './shared';

interface Props {
  r: RankedCandidate;
  s: RankerSettings;
  suggestions: ReplacementSuggestion[];
  onStatus: (id: string, status: LifecycleStatus) => void;
  onUpdate: (id: string, patch: Partial<Candidate>) => void;
  onKeep: (sg: ReplacementSuggestion) => void;
  onReplace: (sg: ReplacementSuggestion) => void;
  onLogJournal: (id: string) => void;
  onDelete: (id: string) => void;
}

export function FitPanel({ r, s, suggestions, onStatus, onUpdate, onKeep, onReplace, onLogJournal, onDelete }: Props) {
  const c = r.candidate;
  const pf = r.portfolio;
  const projectedHeat = pf.heatCommitted + c.plannedRisk;
  const corr = assessCorrelation(asClassified(c), pf.exposures, s.correlation);
  const mine = suggestions.filter((x) => x.candidateId === c.id || x.pendingId === c.id);
  const pnl = candidatePnl(c);
  const R = candidateR(c);
  return (
    <div className="space-y-4">
      {mine.map((sg) => <SuggestionCard key={`${sg.pendingId}-${sg.candidateId}`} sg={sg} onKeep={onKeep} onReplace={onReplace} />)}

      <Panel title="Capital">
        <Row label="Required" value={usd(c.positionValue, 0)} strong />
        <Row label="Available (RB v1)" value={usd(pf.available, 0)} />
        <Row label="% of available" value={Number.isFinite(r.capitalRequiredPct) ? `${(r.capitalRequiredPct * 100).toFixed(0)}%` : '—'} tone={r.capitalRequiredPct > 0.8 ? 'warn' : undefined} />
        <Row label="Remaining after" value={usd(pf.available - c.positionValue, 0)} tone={pf.available - c.positionValue < 0 ? 'danger' : undefined} />
        <Row label="Slots" value={`${pf.slotsUsed} / ${pf.maxPositions} used`} tone={pf.slotsUsed >= pf.maxPositions ? 'danger' : undefined} />
        <Row label="Planned reward ÷ capital" value={`${((c.expectedReward / Math.max(c.positionValue, 1)) * 100).toFixed(2)}%`} />
      </Panel>

      <Panel title="Portfolio heat">
        <Row label="Current heat (open + pending)" value={`${usd(pf.heatCommitted, 0)} / ${usd(pf.heatLimit, 0)}`} />
        <Row label="This trade's planned risk" value={usd(c.plannedRisk)} />
        <Row label="Projected heat" value={`${usd(projectedHeat, 0)} / ${usd(pf.heatLimit, 0)}`} tone={projectedHeat > pf.heatLimit ? 'danger' : projectedHeat > pf.heatLimit * 0.9 ? 'warn' : undefined} strong />
        <div className="mt-2"><ScoreBar points={projectedHeat} max={pf.heatLimit} tone={projectedHeat > pf.heatLimit ? 'bg-short' : 'bg-warn'} /></div>
      </Panel>

      <Panel title="Correlation">
        <Row label="Classification" value={[c.inputs.sector, c.inputs.industry, c.inputs.theme].filter(Boolean).join(' / ') || '—'} />
        <Row label="Overlap" value={corr.blocked ? 'CORRELATED EXPOSURE' : corr.level === 'HIGH' ? 'High thematic overlap' : corr.level === 'SECTOR' ? 'Same sector' : 'None'} tone={corr.blocked ? 'danger' : corr.level !== 'NONE' ? 'warn' : 'long'} />
        {corr.highWith.length > 0 && <Row label="High overlap with" value={corr.highWith.join(', ')} />}
        {corr.sectorWith.length > 0 && <Row label="Sector overlap with" value={corr.sectorWith.join(', ')} />}
        {corr.oppositeWith.length > 0 && <Row label="Opposite direction" value={corr.oppositeWith.join(', ')} />}
        {r.allocation?.reason === 'CORRELATION' && <p className="mt-2 text-sm text-short">BLOCKED — HIGH CORRELATION WITH {r.allocation.correlatedWith.join(', ')} (higher-ranked candidate)</p>}
      </Panel>

      <Lifecycle key={c.id} c={c} pnl={pnl} R={R} onStatus={onStatus} onUpdate={onUpdate} onLogJournal={onLogJournal} onDelete={onDelete} />
    </div>
  );
}

export function SuggestionCard({ sg, onKeep, onReplace }: { sg: ReplacementSuggestion; onKeep: (s: ReplacementSuggestion) => void; onReplace: (s: ReplacementSuggestion) => void }) {
  if (sg.kind === 'SIMILAR') {
    return <p className="rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-ink-300">{sg.message}</p>;
  }
  return (
    <section className="rounded-xl border-2 border-warn/60 bg-warn-dim/40 p-4">
      <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-warn">Stronger opportunity available</div>
      <p className="mt-1 text-sm text-ink-100">{sg.message}</p>
      <p className="mt-1 text-xs text-ink-300">Nothing is cancelled automatically. If you replace, cancel the {sg.pendingTicker} stop order in TrendSpider/Alpaca yourself.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => onKeep(sg)} className="rounded-lg border border-ink-500 px-3 py-2 text-xs font-bold uppercase tracking-wider text-ink-100 hover:bg-ink-700">
          Keep {sg.pendingTicker}
        </button>
        <button type="button" onClick={() => onReplace(sg)} className="rounded-lg bg-warn px-3 py-2 text-xs font-bold uppercase tracking-wider text-ink-950 hover:brightness-110">
          Cancel {sg.pendingTicker} &amp; reserve capital for {sg.candidateTicker}
        </button>
      </div>
    </section>
  );
}

const STATUS_FLOW: LifecycleStatus[] = ['NEW', 'WATCHLIST', 'PENDING', 'FILLED', 'TARGET_HIT', 'STOPPED_OUT', 'MANUAL_EXIT', 'SKIPPED', 'STALE', 'CANCELED', 'EXPIRED'];

function Lifecycle({ c, pnl, R, onStatus, onUpdate, onLogJournal, onDelete }: {
  c: Candidate; pnl: number | null; R: number | null;
  onStatus: Props['onStatus']; onUpdate: Props['onUpdate']; onLogJournal: Props['onLogJournal']; onDelete: Props['onDelete'];
}) {
  const [fill, setFill] = useState(c.actualFill?.toString() ?? '');
  const [exit, setExit] = useState(c.exitPrice?.toString() ?? '');
  const closed = ['TARGET_HIT', 'STOPPED_OUT', 'MANUAL_EXIT'].includes(c.status);
  const commit = (k: 'actualFill' | 'exitPrice', v: string) => {
    const n = parseNum(v);
    onUpdate(c.id, { [k]: Number.isFinite(n) && n > 0 ? n : null });
  };
  return (
    <Panel title="Queue status & outcome">
      <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-ink-300" htmlFor="lc-status">Status</label>
      <select id="lc-status" value={c.status} onChange={(e) => onStatus(c.id, e.target.value as LifecycleStatus)} className="w-full rounded-lg border border-ink-600 bg-ink-900 px-2 py-2 text-sm">
        {STATUS_FLOW.map((s) => <option key={s} value={s}>{LIFECYCLE_LABELS[s]}</option>)}
      </select>
      <p className="mt-1 text-[11px] leading-snug text-ink-500">
        Set PENDING when you submit the stop order (reserves capital), FILLED when it triggers. Filled positions are governed by their stop and target — never displaced by newer candidates.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div>
          <label className="mb-1 block text-[11px] uppercase tracking-wider text-ink-300" htmlFor="lc-fill">Actual fill</label>
          <input id="lc-fill" inputMode="decimal" value={fill} onChange={(e) => setFill(e.target.value)} onBlur={(e) => commit('actualFill', e.target.value)} className="num w-full rounded-lg border border-ink-600 bg-ink-900 px-2 py-2 text-sm" placeholder="optional" />
        </div>
        <div>
          <label className="mb-1 block text-[11px] uppercase tracking-wider text-ink-300" htmlFor="lc-exit">Exit price</label>
          <input id="lc-exit" inputMode="decimal" value={exit} onChange={(e) => setExit(e.target.value)} onBlur={(e) => commit('exitPrice', e.target.value)} className="num w-full rounded-lg border border-ink-600 bg-ink-900 px-2 py-2 text-sm" placeholder="when closed" />
        </div>
      </div>
      {closed && (
        <div className="mt-2">
          <Row label="P/L" value={pnl === null ? 'enter exit price' : signedUsd(pnl)} tone={pnl === null ? undefined : pnl > 0 ? 'long' : 'short'} />
          <Row label="R multiple" value={R === null ? '—' : signedR(R)} />
        </div>
      )}
      <div className="mt-2 grid grid-cols-2 gap-x-4 text-xs text-ink-400">
        <span>Initial score: <span className="num text-ink-200">{c.initialScore ? c.initialScore.total : '—'}</span></span>
        <span>Entry-time score: <span className="num text-ink-200">{c.entryScore ? c.entryScore.total : '—'}</span></span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {closed && (
          <button type="button" onClick={() => onLogJournal(c.id)} className="rounded-md bg-ink-700 px-3 py-1.5 text-xs text-ink-100 hover:bg-ink-600">
            Log to trade journal
          </button>
        )}
        <button type="button" onClick={() => confirm(`Remove ${c.ticker} from the queue? Its history will be lost.`) && onDelete(c.id)} className="rounded-md px-3 py-1.5 text-xs text-ink-400 hover:bg-short-dim hover:text-short">
          Remove candidate
        </button>
      </div>
    </Panel>
  );
}
