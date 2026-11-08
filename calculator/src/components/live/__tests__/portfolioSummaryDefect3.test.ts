/**
 * Defect 3 — the Live Alert Queue portfolio summary must show the COMPLETE reconciled portfolio of the evaluation
 * (`QueueOutput.portfolio`, built by the existing ranker/allocator), never the first alert row's own-candidate-excluded
 * snapshot. Display-only correction: no portfolio rule, score, eligibility or allocation is changed (asserted below).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../../../engine/automation/alertDecision';
import { recordWith } from '../../../engine/automation/__tests__/fixtures';
import { etParts } from '../../../engine/automation/etTime';
import { brokerSyncOff, portfolioVerification, reconcileExposure, type BrokerExposureInput, type BrokerOnlyPosition } from '../../../engine/automation/lifecycle/portfolioExposure';
import { buildQueue, type QueueInput, type QueueOutput, type QueueRow } from '../../../engine/automation/liveQueue';
import { rankCandidates } from '../../../engine/ranker/candidateRanker';
import type { Candidate, LifecycleStatus, ManualPosition } from '../../../engine/ranker/opportunityTypes';
import { buildPortfolio } from '../../../engine/ranker/portfolioAllocator';
import { cloneRankerDefaults } from '../../../engine/ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../../engine/settings';
import { LiveQueuePage, type LiveActions } from '../LiveQueuePage';
import { PortfolioCard } from '../QueueParts';
import { portfolioSummary } from '../queueView';

const ALERT = '2026-10-30T10:15:04-04:00';
const T0 = Date.parse(ALERT);
const NOW = T0 + 60_000;
const TODAY = etParts(NOW).date;
const RK = cloneRankerDefaults();
const WINDOW = { entryWindowStart: RB_V1_DEFAULTS.entryWindowStart, entryWindowEnd: RB_V1_DEFAULTS.entryWindowEnd, chaseThresholdAtr: RB_V1_DEFAULTS.chaseThresholdAtr };
const classify = (s: string) => ({ sector: `S-${s}`, industry: `I-${s}`, theme: '' });
const quote = (price: number): LiveQuote => ({ price, tradeIso: new Date(NOW - 1000).toISOString(), fetchedIso: new Date(NOW - 500).toISOString(), receivedMs: NOW - 500 });
const strong = (symbol: string) => recordWith({ symbol, direction: 'LONG', alertIso: ALERT, price: 100.95, values: {} });

function input(records: AutoAlertRecord[], candidates: Candidate[], o: { positions?: ManualPosition[]; broker?: BrokerExposureInput; knownPositions?: BrokerOnlyPosition[] } = {}): QueueInput {
  const quotes = Object.fromEntries(records.map((r) => [r.alert.symbol, quote(r.initialQuote!.price)]));
  return { records, candidates, positions: o.positions ?? [], quotes, now: NOW, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: RK, classify, parity: {}, strategyVersion: 'RB v1.1', broker: o.broker, knownBrokerPositions: o.knownPositions };
}
/** Two passes (create candidates, then score), as the app does on consecutive renders. */
function queue(records: AutoAlertRecord[], statuses: Record<string, LifecycleStatus> = {}, o: Parameters<typeof input>[2] = {}): QueueOutput {
  const first = buildQueue(input(records, [], o));
  const cs = first.candidates.map((c) => (statuses[c.ticker] ? { ...c, status: statuses[c.ticker] } : c));
  return buildQueue(input(records, cs, o));
}
/** The Opportunity Ranker's complete portfolio for the same state (App.tsx: exposureFor + rankCandidates). */
function rankerPortfolio(out: QueueOutput, o: Parameters<typeof input>[2] = {}) {
  const exp = reconcileExposure(out.candidates, o.positions ?? [], o.broker, { classify, conservativeRisk: RK.portfolio.accountEquity * RK.portfolio.riskPerTradePct, now: NOW, knownPositions: o.knownPositions, maxPositionValue: RK.portfolio.maxPositionValue });
  return rankCandidates(out.candidates, exp.positions, RK, TODAY, WINDOW, exp.exclude, { useFrozenCapitalEfficiency: true }).portfolio;
}
const totals = (p: QueueOutput['portfolio']) => ({ equity: p.equity, slots: `${p.slotsUsed}/${p.maxPositions}`, open: p.openPositions, pending: p.pendingOrders, deployed: p.deployed, reserved: p.reserved, available: p.available, heatOpen: p.heatOpen, heat: p.heatCommitted, heatLimit: p.heatLimit, perTrade: p.perTradeRiskLimit });
const card = (out: QueueOutput, v?: Parameters<typeof PortfolioCard>[0]['verification']) => renderToStaticMarkup(createElement(PortfolioCard, { portfolio: out.portfolio, verification: v ?? null }));
const noop = () => {};
const actions: LiveActions = { submit: noop, skip: noop, watch: noop, openInCalculator: noop, classify: noop, reprocess: noop, keep: noop, replace: noop };
const pageCard = (rows: QueueRow[], out: QueueOutput) => {
  const html = renderToStaticMarkup(createElement(LiveQueuePage, {
    rows, suggestions: [], now: NOW, enabled: true, feed: { lastOkMs: NOW, error: null }, quoteError: null, parityStatus: 'NOT VALIDATED', versionLabel: 'RB v1.1', actions, onOpenSettings: noop,
    shadow: { maxScore: 100, optionAGrades: RK.grades, logCount: 0, onExportLog: noop }, portfolio: out.portfolio,
  }));
  const m = html.match(/<div[^>]*aria-label="Portfolio summary"[\s\S]*?data-field="heat"[\s\S]*?<\/div><\/div><\/div>/);
  return m ? m[0] : '';
};

// FILLED AAA + PENDING BBB + NEW CCC + EXPIRED DDD + SKIPPED (rejected) EEE — distinct sectors, RB-sized
const RECS = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map(strong);
const STATUSES: Record<string, LifecycleStatus> = { AAA: 'FILLED', BBB: 'PENDING', DDD: 'EXPIRED', EEE: 'SKIPPED' };
const mixed = queue(RECS, STATUSES);
const byTicker = (out: QueueOutput, t: string) => out.rows.find((r) => r.record.alert.symbol === t)!;
const committed = (out: QueueOutput) => out.candidates.filter((c) => c.status === 'PENDING' || c.status === 'FILLED');

describe('Defect 3 · the summary is the complete portfolio', () => {
  it('buildQueue returns the complete portfolio: every PENDING / FILLED candidate, no NEW / EXPIRED / SKIPPED one', () => {
    const p = mixed.portfolio;
    const c = committed(mixed);
    expect(c.map((x) => x.ticker).sort()).toEqual(['AAA', 'BBB']);
    expect([p.openPositions, p.pendingOrders, p.slotsUsed]).toEqual([1, 1, 2]);
    const a = c.find((x) => x.ticker === 'AAA')!;
    const b = c.find((x) => x.ticker === 'BBB')!;
    expect(p.deployed).toBeCloseTo(a.positionValue, 6);
    expect(p.reserved).toBeCloseTo(b.positionValue, 6);
    expect(p.heatOpen).toBeCloseTo(a.plannedRisk, 6);
    expect(p.heatCommitted).toBeCloseTo(a.plannedRisk + b.plannedRisk, 6);
    expect(p.available).toBeCloseTo(p.usableAllocation - a.positionValue - b.positionValue, 6);
    expect(p).toEqual(buildPortfolio([], c, RK)); // identical to the allocator over exactly the committed exposure
  });
  it('matches the Opportunity Ranker complete portfolio for the same state', () => {
    expect(mixed.portfolio).toEqual(rankerPortfolio(mixed));
  });
  it('per-row snapshots are preserved for fit evaluation and still exclude the row\'s own candidate (the old, wrong summary source)', () => {
    const full = totals(mixed.portfolio);
    expect(totals(byTicker(mixed, 'AAA').ranked!.portfolio)).not.toEqual(full); // FILLED first → would under-count
    expect(totals(byTicker(mixed, 'BBB').ranked!.portfolio)).not.toEqual(full); // PENDING first → would under-count
    expect(byTicker(mixed, 'AAA').ranked!.portfolio.slotsUsed).toBe(1);
    expect(byTicker(mixed, 'BBB').ranked!.portfolio.slotsUsed).toBe(1);
    expect(totals(byTicker(mixed, 'CCC').ranked!.portfolio)).toEqual(full); // NEW first happened to be right
  });
});

describe('Defect 3 · row order, sorting and filters cannot change the summary', () => {
  it('first row FILLED, PENDING, NEW, EXPIRED or SKIPPED → the same card', () => {
    const ref = pageCard(mixed.rows, mixed);
    expect(ref).toContain('2 / 4');
    for (const first of ['AAA', 'BBB', 'CCC', 'DDD', 'EEE']) {
      const rows = [byTicker(mixed, first), ...mixed.rows.filter((r) => r.record.alert.symbol !== first)];
      expect(pageCard(rows, mixed)).toBe(ref);
    }
  });
  it('reversed, LONG-only, data-review-only and empty row sets → the same card', () => {
    const ref = pageCard(mixed.rows, mixed);
    expect(pageCard([...mixed.rows].reverse(), mixed)).toBe(ref);
    expect(pageCard(mixed.rows.filter((r) => r.record.alert.direction === 'SHORT'), mixed)).toBe(ref);
    expect(pageCard([], mixed)).toBe(ref);
  });
  it('the card renders every required total from the snapshot', () => {
    const p = mixed.portfolio;
    const html = card(mixed);
    const usd0 = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
    for (const s of [usd0(p.equity), `${p.slotsUsed} / ${p.maxPositions}`, '1 open + 1 pending · 2 free', usd0(p.available), usd0(p.usableAllocation), usd0(p.deployed), usd0(p.reserved), usd0(p.heatLimit), usd0(p.perTradeRiskLimit)]) expect(html).toContain(s);
    expect(html).toContain(`open $${p.heatOpen.toFixed(2)}`);
  });
});

describe('Defect 3 · special portfolio states', () => {
  const held: ManualPosition[] = [1, 2].map((i) => ({ id: `p${i}`, ticker: `H${i}`, direction: 'LONG', sector: `HS${i}`, industry: `HI${i}`, theme: '', positionValue: 15000, plannedRisk: 240, entry: 10, stop: 9, target: 12, status: 'OPEN' }));
  it('zero current alerts but positions open → totals still shown (previously "—")', () => {
    const out = buildQueue(input([], [], { positions: held }));
    expect(out.rows).toEqual([]);
    expect(totals(out.portfolio)).toMatchObject({ slots: '2/4', open: 2, deployed: 30000, heat: 480, available: 50000 });
    expect(card(out)).toContain('2 / 4');
  });
  const verifiedBroker: BrokerExposureInput = {
    verified: true, orders: [], positions: [{ symbol: 'ZZZ', qty: '100', side: 'long', avg_entry_price: '50', market_value: '5000' }],
    openOrders: [{ id: 'o-yyy', symbol: 'YYY', side: 'buy', type: 'stop', status: 'new', qty: '100', filled_qty: '0', stop_price: '40', submitted_at: new Date(NOW - 120_000).toISOString(), legs: [] }],
  };
  it('pending broker orders and unmatched broker positions with no eligible alert → counted (existing reconciliation rules)', () => {
    const out = buildQueue(input([], [], { broker: verifiedBroker }));
    expect(out.exposure.added.map((a) => a.ticker)).toEqual(['ZZZ']);
    expect(out.exposure.entries.map((e) => e.ticker)).toEqual(['YYY']);
    expect(totals(out.portfolio)).toMatchObject({ slots: '2/4', open: 1, pending: 1, deployed: 5000, reserved: 4000, heatOpen: 250, heat: 500 });
    expect(out.portfolio).toEqual(rankerPortfolio(out, { broker: verifiedBroker }));
  });
  it('several positions and pending orders coexist (manual + RB + broker-only)', () => {
    const o = { positions: held, broker: verifiedBroker };
    const out = queue(RECS, STATUSES, o);
    // Existing reconciliation: the verified broker shows no AAA position or order, so the FILLED AAA is released (closed).
    expect(out.exposure.released.map((r) => r.ticker)).toEqual(['AAA']);
    expect(out.portfolio.slotsUsed).toBe(5); // 2 manual + ZZZ + YYY + BBB — over the 4-slot limit, reported as is
    expect([out.portfolio.openPositions, out.portfolio.pendingOrders]).toEqual([3, 2]);
    expect(out.portfolio).toEqual(rankerPortfolio(out, o));
    expect(card(out)).toContain('5 / 4');
    expect(card(out)).toContain('0 free');
  });
  it('broker data stale / unavailable: last verified broker exposure stays counted and the card flags it', () => {
    const known: BrokerOnlyPosition[] = [{ ticker: 'ZZZ', direction: 'LONG', qty: 100, positionValue: 5000, plannedRisk: 250, entry: 50 }];
    const out = buildQueue(input([], [], { broker: { ...verifiedBroker, verified: false }, knownPositions: known }));
    expect(out.exposure.entriesSource).toBe('LAST_KNOWN');
    expect(totals(out.portfolio)).toMatchObject({ slots: '1/4', deployed: 5000 });
    const stale = portfolioVerification({ status: 'LIVE', loadedDate: TODAY, lastOkMs: NOW - 300_000, orders: [], positions: [], openOrders: [] }, TODAY, NOW, { atMs: NOW - 300_000, date: TODAY, source: 'rb-broker · Alpaca PAPER · read-only', verification: 'VERIFIED', positions: known, entries: [] });
    expect(stale.state).toBe('STALE');
    const s = portfolioSummary(out.portfolio, stale)!;
    expect(s.capacity).toBe('UNVERIFIED');
    expect(s.capacityNote).toContain('previously verified broker exposure is still counted');
    expect(card(out, stale)).toContain('Available capital *');
    const none = portfolioVerification(null, TODAY, NOW);
    expect(portfolioSummary(out.portfolio, none)!.capacityNote).toContain('no verified broker snapshot in this browser');
    expect(portfolioSummary(out.portfolio, brokerSyncOff('automation is OFF in this browser'))!.capacity).toBe('BROKER_SYNC_OFF');
    const ok = portfolioVerification({ status: 'LIVE', loadedDate: TODAY, lastOkMs: NOW - 1000, orders: [], positions: [], openOrders: [] }, TODAY, NOW);
    expect(portfolioSummary(out.portfolio, ok)).toMatchObject({ capacity: 'VERIFIED', capacityNote: null });
  });
  it('browser refresh: the same persisted state (JSON round trip) gives the same summary', () => {
    const reloaded = JSON.parse(JSON.stringify(mixed.candidates)) as Candidate[];
    const again = buildQueue(input(RECS, reloaded));
    expect(again.portfolio).toEqual(mixed.portfolio);
    expect(card(again)).toBe(card(mixed));
  });
  it('no evaluation yet → explicit placeholder, never zero capacity', () => {
    const html = renderToStaticMarkup(createElement(PortfolioCard, { portfolio: null }));
    expect(html).toContain('Portfolio not evaluated yet');
    expect(portfolioSummary(undefined)).toBeNull();
  });
});
