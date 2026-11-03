/**
 * Broker portfolio verification gate. When broker sync is enabled but the broker response is loading, errored, stale,
 * for the wrong ET date, incomplete or unreadable:
 *   • the last VERIFIED broker-only exposure (positions + working entries) stays counted — never assumed closed;
 *   • the execution layer withholds new tickets: NO TICKET — PORTFOLIO UNVERIFIED (v1.1 and v1.2 shadow display);
 *   • decisions, scores, frozen snapshots and Entry/Stop/Target/Qty are byte-identical to the verified evaluation;
 *   • terminal, expired, submitted and filled alerts keep their lifecycle states; nothing revives on recovery.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue, type QueueInput } from '../liveQueue';
import { rankCandidates } from '../../ranker/candidateRanker';
import { buildPortfolio } from '../../ranker/portfolioAllocator';
import type { Candidate } from '../../ranker/opportunityTypes';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../settings';
import { recordWith } from './fixtures';
import { finalBadge, decisionBadge } from '../../../components/live/queueView';
import { gateRankingDisplay } from '../../../components/portfolioGate';
import { PortfolioVerificationBanner } from '../../../components/PortfolioVerificationBanner';
import {
  PORTFOLIO_UNVERIFIED, brokerExposureSnapshot, brokerSyncOff, portfolioVerification, reconcileExposure,
  type BrokerExposureInput, type BrokerExposureSnapshot,
} from '../lifecycle/portfolioExposure';

const RK = cloneRankerDefaults();
const DATE = '2026-11-03';
const NOW = Date.parse('2026-11-03T15:16:04Z'); // 10:16:04 ET
const classify = (s: string) => ({ sector: `S-${s}`, industry: `I-${s}`, theme: '' });
const OPTS = { classify, conservativeRisk: 250, maxPositionValue: 20000 };

// ── broker fixtures (real shapes) ──
const CTVA_PARENT = { id: 'dd98a97a-ctva-entry', symbol: 'CTVA', side: 'sell', type: 'stop', status: 'new', qty: '5000', filled_qty: '0', stop_price: '11.33', order_class: 'bracket', submitted_at: '2026-10-29T16:43:33.50834Z', legs: [
  { id: '229f34d4-ctva-tp', symbol: 'CTVA', side: 'buy', type: 'limit', status: 'held', qty: '5000', filled_qty: '0', limit_price: '11.23', legs: [] },
  { id: 'a965da73-ctva-sl', symbol: 'CTVA', side: 'buy', type: 'stop', status: 'held', qty: '5000', filled_qty: '0', stop_price: '11.38', legs: [] },
] };
const MCD_TP = { id: 'mcd-tp', symbol: 'MCD', side: 'sell', type: 'limit', status: 'new', qty: '75', filled_qty: '0', limit_price: '268.33', order_class: 'bracket', submitted_at: '2026-11-03T19:17:35Z', legs: [] };
const MCD_POS = { symbol: 'MCD', qty: '75', side: 'long', avg_entry_price: '263.55', market_value: '19734' };
const verifiedInput = (open: unknown[], positions: BrokerExposureInput['positions'] = [MCD_POS]): BrokerExposureInput => ({ verified: true, orders: [], positions, openOrders: open });
const feed = (o: Partial<{ status: string; loadedDate: string | null; lastOkMs: number | null; error: string | null; orders: unknown; positions: unknown; openOrders: unknown }> = {}) =>
  ({ status: 'LIVE', loadedDate: DATE, lastOkMs: NOW - 10_000, error: null, orders: [], positions: [MCD_POS], openOrders: [MCD_TP], ...o });

/** The verified evaluation before the outage: CTVA working, MCD held, no RB candidates → snapshot persisted. */
const SNAP = brokerExposureSnapshot(reconcileExposure([], [], verifiedInput([CTVA_PARENT, MCD_TP]), { ...OPTS, now: NOW - 10_000 }), NOW - 10_000, DATE) as BrokerExposureSnapshot;

// ── a valid, high-scoring v1.1 SHORT ticket (NVDA §54 shape from queue.test.ts) ──
const ALERT = '2026-11-03T10:15:04-05:00';
const NVDA: AutoAlertRecord = recordWith({ symbol: 'NVDA', direction: 'SHORT', alertIso: ALERT, price: 212.35, values: { open: 212.73, high: 212.76, low: 212.25, close: 212.4, atr: 0.34, ema9: 212.5, ema20: 212.65, vwap: 212.6, rsi: 33, rvol: 3.8, close15m: 212.4, ema20_15m: 212.8 } });
const q = (price: number, now: number): LiveQuote => ({ price, tradeIso: new Date(now - 1000).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 });
const run = (o: Partial<QueueInput> = {}) => {
  const now = o.now ?? NOW;
  return buildQueue({ records: [NVDA], candidates: [], positions: [], quotes: { NVDA: q(212.35, now) }, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: RK, classify, parity: {}, strategyVersion: 'RB v1.1', ...o });
};
const nvda = (out: ReturnType<typeof run>) => out.rows.find((r) => r.record.alert.symbol === 'NVDA')!;
const GATE = (v = portfolioVerification(feed({ lastOkMs: NOW - 200_000 }), DATE, NOW, SNAP)) => (v.gated ? v.reason : null);

describe('verification states (1–6, 18)', () => {
  it('(1) no broker response before the first sync, no snapshot: unavailable — never "account empty"', () => {
    const v = portfolioVerification({ status: 'LOADING', lastOkMs: null }, DATE, NOW, null);
    expect(v).toMatchObject({ state: 'LOADING', verified: false, gated: true, lastVerifiedMs: null, keptFromSnapshot: false });
    expect(v.message).toBe('PORTFOLIO VERIFICATION UNAVAILABLE — Broker feed loading — no broker response yet. No verified broker snapshot in this browser — the broker account is NOT assumed empty. New tickets are withheld.');
    expect(portfolioVerification(null, DATE, NOW, null).state).toBe('LOADING');
  });
  it('(2) loading with an earlier verified snapshot: last verified time and kept exposure are named', () => {
    const v = portfolioVerification({ status: 'LOADING', lastOkMs: null }, DATE, NOW, SNAP);
    expect(v).toMatchObject({ state: 'LOADING', gated: true, lastVerifiedMs: NOW - 10_000, keptFromSnapshot: true });
    expect(v.message).toBe('PORTFOLIO VERIFICATION UNAVAILABLE — Broker feed loading — no broker response yet. Last verified at 10:15:54 ET. Previously verified broker exposure remains reserved. New tickets are withheld.');
  });
  it('(3) broker feed error', () => {
    expect(portfolioVerification(feed({ status: 'ERROR', error: 'HTTP 502' }), DATE, NOW, SNAP)).toMatchObject({ state: 'ERROR', gated: true, reason: 'Broker feed error (HTTP 502)' });
  });
  it('(4) broker data older than two minutes: stale (the 5 s / 60 s market-data thresholds are separate)', () => {
    expect(portfolioVerification(feed({ lastOkMs: NOW - 120_000 }), DATE, NOW).state).toBe('VERIFIED');
    expect(portfolioVerification(feed({ lastOkMs: NOW - 121_000 }), DATE, NOW)).toMatchObject({ state: 'STALE', gated: true, reason: 'Broker data is stale (121 s old; limit 120 s)' });
    expect([DEFAULT_AUTOMATION.maxDataAgeSec, DEFAULT_AUTOMATION.maxTradeAgeSec]).toEqual([5, 60]);
  });
  it('(4b) data for the wrong ET date', () => {
    expect(portfolioVerification(feed({ loadedDate: '2026-11-02' }), DATE, NOW)).toMatchObject({ state: 'WRONG_DATE', gated: true });
  });
  it('(5) missing or truncated openOrders: incomplete', () => {
    for (const openOrders of [undefined, null]) expect(portfolioVerification(feed({ openOrders }), DATE, NOW)).toMatchObject({ state: 'INCOMPLETE', gated: true });
  });
  it('(6) malformed / unreadable broker response', () => {
    for (const bad of [{ openOrders: [{ id: 'x', status: 'new' }] }, { positions: [{ qty: '5' }] }, { positions: 'oops' }, { orders: null }, { orders: [{ id: 'o' }] }]) {
      expect(portfolioVerification(feed(bad), DATE, NOW)).toMatchObject({ state: 'UNREADABLE', gated: true });
    }
    // the reconciliation independently refuses the same inputs (never crashes, never releases)
    expect(reconcileExposure([], [], { verified: true, orders: [], positions: [{ qty: '5' }] as never, openOrders: [] }, OPTS).verified).toBe(false);
  });
  it('fresh, complete, readable, today: VERIFIED (no warning)', () => {
    expect(portfolioVerification(feed(), DATE, NOW)).toMatchObject({ state: 'VERIFIED', verified: true, gated: false });
  });
  it('(18) broker sync intentionally OFF: RB-records-only mode, labelled, not gated', () => {
    const v = portfolioVerification({ status: 'OFF', lastOkMs: null }, DATE, NOW, SNAP);
    expect(v).toMatchObject({ state: 'OFF', verified: false, gated: false });
    expect(v.message).toBe('BROKER SYNC OFF — Broker sync is disabled on the server. Portfolio capacity comes from RB records only; broker exposure is not independently verified.');
    expect(brokerSyncOff('automation is OFF in this browser').gated).toBe(false);
    expect(finalBadge(nvda(run({ portfolioGate: GATE(v) }))).label).toBe('READY');
  });
});

describe('last verified broker exposure (7–11)', () => {
  it('the snapshot holds the broker-only position and working entry, with time, date and source', () => {
    expect(SNAP).toMatchObject({ atMs: NOW - 10_000, date: DATE, source: 'rb-broker · Alpaca PAPER · read-only', verification: 'VERIFIED' });
    expect(SNAP.positions).toEqual([{ ticker: 'MCD', direction: 'LONG', qty: 75, positionValue: 19734, plannedRisk: 250, entry: 263.55 }]);
    expect(SNAP.entries.map((e) => [e.ticker, e.qty, e.notional, e.plannedRisk])).toEqual([['CTVA', 5000, 56650, 250]]);
    expect(brokerExposureSnapshot(reconcileExposure([], [], null, OPTS), NOW, DATE)).toBeNull(); // never from unverified data
  });
  it('(7, 8) outage: CTVA working entry and broker-only MCD position both stay counted', () => {
    const x = reconcileExposure([], [], null, { ...OPTS, knownEntries: SNAP.entries, knownPositions: SNAP.positions });
    const p = buildPortfolio(x.positions, x.candidates, RK);
    expect(x.entriesSource).toBe('LAST_KNOWN');
    expect(p).toMatchObject({ slotsUsed: 2, openPositions: 1, pendingOrders: 1, heatCommitted: 500, reserved: 56650, deployed: 19734 });
  });
  it('(9, 10) a fresh verified response releases the canceled CTVA and retains the open MCD', () => {
    const x = reconcileExposure([], [], verifiedInput([MCD_TP]), { ...OPTS, knownEntries: SNAP.entries, knownPositions: SNAP.positions });
    expect(x.entries).toEqual([]);
    expect(x.brokerPositions.map((b) => b.ticker)).toEqual(['MCD']);
    expect(buildPortfolio(x.positions, x.candidates, RK)).toMatchObject({ slotsUsed: 1, heatCommitted: 250, reserved: 0 });
  });
  it('(11) no duplicate exposure when an RB record represents the same position or order during the outage', () => {
    const base = { source: 'AUTO', date: DATE, alertTime: '14:15', alertMs: NOW, createdAt: 1, open: 1, high: 1, low: 1, close: 1, atr: 1, currentPrice: 1, target: 1, expectedReward: 1, orderType: 'BUY STOP', calcAction: 'BUY_STOP', calcReady: true, chaseDistanceAtr: 0, minutesSinceAlert: 1, scored: true, initialScore: null, entryScore: null, exitPrice: null, notes: '', archived: false, keptAgainst: [], inputs: { rvol: 2, rsi: 60, vwap: 1, ema9: 1, ema20: 1, close15m: 1, ema20_15m: 1, sector: 'S', industry: 'I', theme: '' } };
    const mcd = { ...base, id: 'mcd', ticker: 'MCD', direction: 'LONG', entry: 263.45, stop: 261.01, shares: 75, positionValue: 19758.75, plannedRisk: 183, status: 'FILLED', actualFill: 263.55 } as unknown as Candidate;
    const ctva = { ...base, id: 'ctva', ticker: 'CTVA', direction: 'SHORT', entry: 11.33, stop: 11.38, shares: 5000, positionValue: 56650, plannedRisk: 250, status: 'PENDING', actualFill: null } as unknown as Candidate;
    const x = reconcileExposure([mcd, ctva], [], null, { ...OPTS, knownEntries: SNAP.entries, knownPositions: SNAP.positions });
    expect(x.positions).toEqual([]);
    const p = buildPortfolio(x.positions, x.candidates, RK);
    expect(p.exposures.map((e) => `${e.id}:${e.kind}`).sort()).toEqual(['ctva:PENDING', 'mcd:POSITION']);
    expect(p).toMatchObject({ slotsUsed: 2, heatCommitted: 433 });
  });
});

describe('execution gate (12–16)', () => {
  const verified = run();
  const gated = run({ portfolioGate: GATE() });
  it('(12) a valid high-scoring alert during an outage: NO TICKET — PORTFOLIO UNVERIFIED', () => {
    expect(nvda(verified).lifecycle).toMatchObject({ executionState: 'ACTIVE', finalActionability: 'READY', portfolioUnverified: false, portfolioGate: null });
    const lc = nvda(gated).lifecycle;
    expect(lc).toMatchObject({ executionState: 'ACTIVE', finalActionability: 'NO TICKET', portfolioUnverified: true, terminal: false });
    expect(lc.reason).toMatch(/^NO TICKET — PORTFOLIO UNVERIFIED — Broker data is stale/);
    expect(finalBadge(nvda(gated))).toMatchObject({ label: PORTFOLIO_UNVERIFIED, tone: 'bad' });
    expect(decisionBadge(nvda(gated)).label).toBe('v1.1 TICKET — PORTFOLIO UNVERIFIED');
  });
  it('… the strategy decision, ticket numbers, scores and v1.2 shadow evaluation are byte-identical (only actionability differs)', () => {
    const a = nvda(verified), b = nvda(gated);
    expect(JSON.stringify(b.decision)).toBe(JSON.stringify(a.decision));
    expect(b.decision.ticket).toEqual({ action: 'SELL', orderType: 'STOP', quantity: 94, price: 212.21, stopLoss: 212.76, takeProfit: 211.11 });
    expect(JSON.stringify(b.ranked)).toBe(JSON.stringify(a.ranked));
    expect(JSON.stringify(b.shadow)).toBe(JSON.stringify(a.shadow));
    expect(JSON.stringify(b.candidate)).toBe(JSON.stringify(a.candidate));
    expect(b.lifecycle.alertTimeTier).toBe(a.lifecycle.alertTimeTier);
  });
  it('(13) after recovery the same alert is READY again — only while still inside its lifecycle', () => {
    expect(nvda(run({ portfolioGate: null })).lifecycle.finalActionability).toBe('READY');
    const late = NOW + RB_V1_DEFAULTS.alertWindowMinutes * 60_000;
    expect(nvda(run({ now: late, portfolioGate: null })).lifecycle).toMatchObject({ executionState: 'EXPIRED — STALE', finalActionability: 'NO TRADE', terminal: true });
  });
  it('(14) terminal SETUP FAILED cannot revive after recovery', () => {
    const terminal = { [NVDA.id]: { recordId: NVDA.id, kind: 'SETUP_FAILED' as const, direction: 'SHORT' as const, alertTimeMs: NVDA.alert.alertTimeMs, observedAtMs: NOW - 30_000, price: 212.8, stop: 212.76, quoteTradeIso: new Date(NOW - 30_000).toISOString() } };
    for (const portfolioGate of [GATE(), null]) {
      expect(nvda(run({ terminal, portfolioGate })).lifecycle).toMatchObject({ executionState: 'SETUP FAILED', finalActionability: 'NO TRADE', portfolioUnverified: false });
    }
  });
  it('(15) EXPIRED — STALE cannot revive after recovery', () => {
    const late = NOW + RB_V1_DEFAULTS.alertWindowMinutes * 60_000 + 1;
    for (const portfolioGate of [GATE(), null]) expect(nvda(run({ now: late, portfolioGate })).lifecycle).toMatchObject({ executionState: 'EXPIRED — STALE', finalActionability: 'NO TRADE' });
  });
  it('(16) already submitted / filled keep their lifecycle states (never turned into a new submission)', () => {
    const cand = nvda(verified).candidate!;
    for (const [status, state] of [['PENDING', 'SUBMITTED'], ['FILLED', 'IN POSITION']] as const) {
      for (const portfolioGate of [GATE(), null]) {
        const out = run({ candidates: [{ ...cand, status }], portfolioGate });
        expect(nvda(out).lifecycle).toMatchObject({ executionState: state, finalActionability: 'NO TICKET', portfolioUnverified: false });
      }
    }
  });
  it('v1.2 shadow actionability carries the same gate (display only; the shadow decision is unchanged)', () => {
    expect(nvda(gated).lifecycle.portfolioGate).toMatch(/Broker data is stale/);
    expect(nvda(verified).lifecycle.portfolioGate).toBeNull();
  });
});

describe('both surfaces (17)', () => {
  it('Queue and Ranker see the same exposure during an outage, and the Ranker withholds TRADE NOW (display only)', () => {
    const known = { knownEntries: SNAP.entries, knownPositions: SNAP.positions };
    const out = run({ portfolioGate: GATE(), knownBrokerEntries: SNAP.entries, knownBrokerPositions: SNAP.positions });
    const x = reconcileExposure(out.candidates, [], null, { ...OPTS, ...known });
    const ranking = rankCandidates(out.candidates, x.positions, RK, DATE, undefined, x.exclude);
    expect(JSON.stringify(ranking.portfolio)).toBe(JSON.stringify(nvda(out).ranked!.portfolio));
    expect(ranking.portfolio).toMatchObject({ slotsUsed: 2, heatCommitted: 500 });
    const v = portfolioVerification(feed({ lastOkMs: NOW - 200_000 }), DATE, NOW, SNAP);
    // A TRADE NOW candidate (empty portfolio) is shown as withheld; scores, tiers, allocation are untouched.
    const free = rankCandidates(out.candidates, [], RK, DATE);
    const r0 = free.ranked.find((r) => r.candidate.ticker === 'NVDA')!;
    expect(r0.displayStatus).toMatch(/^TRADE NOW/);
    const r1 = gateRankingDisplay(free, v).ranked.find((r) => r.candidate.ticker === 'NVDA')!;
    expect(r1.displayStatus).toBe(PORTFOLIO_UNVERIFIED);
    expect([r1.total, r1.tier, r1.recommendation, r1.allocation, r1.components]).toEqual([r0.total, r0.tier, r0.recommendation, r0.allocation, r0.components]);
    expect(gateRankingDisplay(free, portfolioVerification(feed(), DATE, NOW))).toBe(free);
    expect(gateRankingDisplay(free, brokerSyncOff('automation is OFF in this browser'))).toBe(free);
  });
  it('the same banner (same message) renders on both pages; nothing is shown when verified', () => {
    const v = portfolioVerification(feed({ status: 'ERROR', error: 'HTTP 502' }), DATE, NOW, SNAP);
    const html = renderToStaticMarkup(createElement(PortfolioVerificationBanner, { v }));
    expect(html).toContain('PORTFOLIO VERIFICATION UNAVAILABLE — Broker feed error (HTTP 502).');
    expect(html).toContain('data-state="ERROR"');
    expect(renderToStaticMarkup(createElement(PortfolioVerificationBanner, { v: portfolioVerification(feed(), DATE, NOW) }))).toBe('');
    const src = (f: string) => readFileSync(join(__dirname, '..', '..', '..', 'components', f), 'utf8');
    expect(src('live/LiveQueuePage.tsx')).toContain('<PortfolioVerificationBanner v={verification} />');
    expect(src('ranker/RankerPage.tsx')).toContain('<PortfolioVerificationBanner v={verification} />');
    const app = readFileSync(join(__dirname, '..', '..', '..', 'App.tsx'), 'utf8');
    expect((app.match(/verification=\{verification\}/g) ?? []).length).toBe(2);
  });
});
