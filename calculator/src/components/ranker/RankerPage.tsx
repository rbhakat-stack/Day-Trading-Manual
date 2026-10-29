import { useState } from 'react';
import type { RankingResult, ReplacementSuggestion } from '../../engine/ranker/candidateRanker';
import type { Candidate, LifecycleStatus, ManualPosition, RankingInputs } from '../../engine/ranker/opportunityTypes';
import type { RankerSettings } from '../../engine/ranker/rankerSettings';
import { AnalyticsView } from './AnalyticsView';
import { CandidateInput } from './CandidateInput';
import { CandidateTable } from './CandidateTable';
import { FitPanel, SuggestionCard } from './FitPanel';
import { PortfolioBar } from './PortfolioBar';
import { PortfolioPanel } from './PortfolioPanel';
import { RankerSettingsPanel } from './RankerSettingsPanel';
import { BreakdownCard, DecisionCard } from './ScoreCard';
import { StrategyVersionBar, type VersionControls } from '../StrategyVersionBar';

export interface RankerActions {
  select: (id: string) => void;
  score: (id: string, inputs: RankingInputs, alertTime: string) => void;
  setStatus: (id: string, status: LifecycleStatus) => void;
  update: (id: string, patch: Partial<Candidate>) => void;
  keep: (sg: ReplacementSuggestion) => void;
  replace: (sg: ReplacementSuggestion) => void;
  logJournal: (id: string) => void;
  remove: (id: string) => void;
  archiveToday: () => void;
  loadSample: () => void;
  clearToday: () => void;
  addPosition: (p: ManualPosition) => void;
  updatePosition: (id: string, patch: Partial<ManualPosition>) => void;
  removePosition: (id: string) => void;
  setSettings: (s: RankerSettings) => void;
}

type Sub = 'rank' | 'portfolio' | 'analytics' | 'settings';

interface Props {
  result: RankingResult;
  candidates: Candidate[];
  positions: ManualPosition[];
  settings: RankerSettings;
  version: VersionControls;
  settingsEpoch: number;
  selectedId: string | null;
  today: string;
  actions: RankerActions;
}

export function RankerPage({ result, candidates, positions, settings, version, settingsEpoch, selectedId, today, actions }: Props) {
  const [sub, setSub] = useState<Sub>('rank');
  const selected = result.ranked.find((r) => r.candidate.id === selectedId) ?? null;
  const stronger = result.suggestions.filter((s) => s.kind === 'STRONGER');
  const tabs: { id: Sub; label: string }[] = [
    { id: 'rank', label: 'Ranker' },
    { id: 'portfolio', label: 'Portfolio' },
    { id: 'analytics', label: 'History & analytics' },
    { id: 'settings', label: 'Ranker settings' },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold tracking-tight text-ink-100">RB v1 Opportunity Ranker</h2>
          <p className="text-xs text-ink-400">Valid Setup → Quality Score → Portfolio Fit → Trade / Watch / Skip · <i>A valid trade is not necessarily a trade worth allocating capital to.</i></p>
          <p className={`mt-0.5 text-[10px] font-bold uppercase tracking-wider ${version.frozen ? 'text-[#a9c1ff]' : 'text-warn'}`}>{version.label}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          {tabs.map((t) => (
            <button key={t.id} type="button" onClick={() => setSub(t.id)} className={`rounded-md px-3 py-1.5 text-sm ${sub === t.id ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-100'}`}>{t.label}</button>
          ))}
        </div>
      </div>

      {sub === 'rank' && (
        <>
          <div className="hidden lg:block"><PortfolioBar pf={result.portfolio} reservePct={settings.portfolio.liquidityReservePct} /></div>
          {stronger.length > 0 && (
            <div className="grid gap-3 lg:grid-cols-2">
              {stronger.map((sg) => <SuggestionCard key={`${sg.pendingId}-${sg.candidateId}`} sg={sg} onKeep={actions.keep} onReplace={actions.replace} />)}
            </div>
          )}
          <div className="grid gap-4 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)] xl:grid-cols-[minmax(300px,360px)_minmax(0,1fr)_minmax(290px,340px)]">
            <div className="order-3 lg:order-none">
              <CandidateInput candidate={selected?.candidate ?? null} onScore={actions.score} />
            </div>
            <div className="order-1 space-y-4 lg:order-none">
              <DecisionCard r={selected} />
              <div className="lg:hidden"><PortfolioBar pf={result.portfolio} reservePct={settings.portfolio.liquidityReservePct} /></div>
              {selected && <BreakdownCard r={selected} />}
            </div>
            <div className="order-4 lg:order-none lg:col-span-2 xl:col-span-1">
              {selected ? (
                <FitPanel
                  r={selected}
                  s={settings}
                  suggestions={result.suggestions}
                  onStatus={actions.setStatus}
                  onUpdate={actions.update}
                  onKeep={actions.keep}
                  onReplace={actions.replace}
                  onLogJournal={actions.logJournal}
                  onDelete={actions.remove}
                />
              ) : null}
            </div>
          </div>
          <CandidateTable ranked={result.ranked} selectedId={selectedId} onSelect={actions.select} />
          <div className="flex flex-wrap gap-2 text-xs">
            <button type="button" onClick={actions.loadSample} className="rounded-md bg-ink-700 px-3 py-1.5 text-ink-100 hover:bg-ink-600">Load sample day (TRMB · AEP · NVDA · NEE · IBM · HCA · DLTR · AVGO)</button>
            <button type="button" onClick={() => confirm("Remove ALL of today's candidates from the queue?") && actions.clearToday()} className="rounded-md px-3 py-1.5 text-ink-400 hover:bg-short-dim hover:text-short">Clear today's queue</button>
          </div>
        </>
      )}
      {sub === 'portfolio' && (
        <PortfolioPanel positions={positions} candidates={candidates} pf={result.portfolio} onAdd={actions.addPosition} onUpdate={actions.updatePosition} onRemove={actions.removePosition} />
      )}
      {sub === 'analytics' && <AnalyticsView candidates={candidates} s={settings} today={today} versionLabel={version.label} currentVersion={version.name} onArchiveToday={actions.archiveToday} />}
      {sub === 'settings' && (
        <div className="space-y-4">
          <StrategyVersionBar v={version} />
          <RankerSettingsPanel key={settingsEpoch} settings={settings} locked={version.locked} onChange={actions.setSettings} />
        </div>
      )}
    </div>
  );
}
