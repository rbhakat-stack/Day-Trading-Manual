/**
 * Execution status vs opportunity quality (MCD, 3 Nov). Candidate status (user-maintained), broker entry order, broker
 * position and the effective execution state are separate answers; a submitted / filled execution never reads as a new
 * trade signal. Broker orders are attached ONLY through the deterministic reconciliation (unique price match).
 * Scores: the alert-time score is frozen; the live re-evaluation is labelled as such. Display only — no score, ticket,
 * candidate or broker order changes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, type LiveQuote } from '../alertDecision';
import { buildQueue, type QueueInput } from '../liveQueue';
import { reconcileBroker, brokerOrdersFrom } from '../lifecycle/brokerSync';
import {
  ALREADY_EXECUTED, ENTRY_CANCELED, EXECUTED_CLOSED, IN_POSITION_UNVERIFIED, ORDER_PENDING, PARTIALLY_FILLED, PENDING_UNVERIFIED,
  executionShortLabel, executionStatus,
} from '../lifecycle/executionStatus';
import { rankCandidates } from '../../ranker/candidateRanker';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import type { Candidate, ManualPosition } from '../../ranker/opportunityTypes';
import { RB_V1_DEFAULTS } from '../../settings';
import { recordWith } from './fixtures';
import { queueLayout, presentationFor } from '../../../components/live/queueView';
import { withExecutionDisplay } from '../../../components/portfolioGate';
import { DecisionCard } from '../../../components/ranker/ScoreCard';
import { FitPanel } from '../../../components/ranker/FitPanel';

const RK = cloneRankerDefaults();
const ALERT = '2026-11-03T14:15:19-05:00';
const T0 = Date.parse(ALERT);
const NOW = T0 + 20_000;
const SECTORS: Record<string, string> = { MCD: 'Restaurants', FIS: 'Fintech', XYZ: 'S-X' };
const classify = (s: string) => (SECTORS[s] ? { sector: SECTORS[s], industry: SECTORS[s], theme: '' } : null);
const quote = (price: number, now: number): LiveQuote => ({ price, tradeIso: new Date(now - 1000).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 });
const MCD_REC = recordWith({ symbol: 'MCD', direction: 'LONG', alertIso: ALERT, price: 100.95, values: {} });
const run = (o: Partial<QueueInput> = {}) => buildQueue({
  records: [MCD_REC], candidates: [], positions: [], quotes: { MCD: quote(100.95, o.now ?? NOW) }, now: NOW, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: RK, classify, parity: {}, strategyVersion: 'RB v1.1', ...o,
});
const first = run();
const NEW_MCD = first.candidates.find((c) => c.ticker === 'MCD')!;
const PENDING_MCD: Candidate = { ...NEW_MCD, status: 'PENDING', executionRev: 1 };
const row = (out: ReturnType<typeof run>) => out.rows.find((r) => r.record.alert.symbol === 'MCD')!;
const submitted = run({ candidates: [PENDING_MCD], now: NOW + 120_000, quotes: { MCD: quote(100.95, NOW + 120_000) } });

// Broker orders (Alpaca shapes) at the candidate's planned entry; legs are bracket exits.
const order = (o: Record<string, unknown> = {}) => ({
  id: 'mcd-entry', symbol: 'MCD', side: 'buy', type: 'stop', order_class: 'bracket', status: 'filled', qty: '75', filled_qty: '75', filled_avg_price: '263.55', stop_price: String(NEW_MCD.entry),
  submitted_at: new Date(T0 + 68_000).toISOString(), filled_at: new Date(T0 + 136_000).toISOString(),
  legs: [{ id: 'mcd-tp', symbol: 'MCD', side: 'sell', type: 'limit', status: 'new', qty: '75', filled_qty: '0', limit_price: '268.33', legs: [] }, { id: 'mcd-sl', symbol: 'MCD', side: 'sell', type: 'stop', status: 'held', qty: '75', filled_qty: '0', stop_price: '261.01', legs: [] }],
  ...o,
});
const HELD = [{ symbol: 'MCD', qty: '75', side: 'long' }];
const trades = (orders: unknown[], positions: { symbol: string; qty?: string }[] = HELD, rows = submitted.rows) => reconcileBroker(brokerOrdersFrom(orders).orders, rows, positions);
const FRESH = { verified: true, asOfMs: NOW + 120_000 };

describe('execution status (A, B)', () => {
  it('(1) MCD: candidate PENDING, broker entry FILLED, position OPEN → ALREADY EXECUTED — four separate answers', () => {
    const before = JSON.stringify(PENDING_MCD);
    const x = executionStatus(PENDING_MCD, trades([order()]), FRESH);
    expect(x).toMatchObject({
      candidate: 'PENDING (user-maintained)', brokerEntry: 'FILLED — 75 sh @ $263.55', brokerPosition: 'OPEN — LONG 75',
      effective: ALREADY_EXECUTED, newEntryPermitted: false, verified: true, orderIds: ['mcd-entry'],
    });
    expect(JSON.stringify(PENDING_MCD)).toBe(before); // never rewritten
  });
  it('(2) candidate FILLED, broker FILLED → ALREADY EXECUTED', () => {
    expect(executionStatus({ ...PENDING_MCD, status: 'FILLED' }, trades([order()]), FRESH)).toMatchObject({ candidate: 'FILLED (user-maintained)', effective: ALREADY_EXECUTED, newEntryPermitted: false });
  });
  it('(3) broker entry accepted but not filled → ORDER PENDING — DO NOT DUPLICATE', () => {
    const x = executionStatus(PENDING_MCD, trades([order({ status: 'accepted', filled_qty: '0', filled_avg_price: null, filled_at: null })], []), FRESH);
    expect(x).toMatchObject({ brokerEntry: 'WORKING — accepted, not filled', brokerPosition: 'NONE', effective: ORDER_PENDING, newEntryPermitted: false });
  });
  it('(4) broker entry canceled / rejected, 0 filled → preserved, no new entry inferred, queue lifecycle unchanged', () => {
    for (const status of ['canceled', 'rejected']) {
      const x = executionStatus(PENDING_MCD, trades([order({ status, filled_qty: '0', filled_avg_price: null, filled_at: null })], []), FRESH);
      expect(x).toMatchObject({ effective: ENTRY_CANCELED, newEntryPermitted: false, brokerEntry: `${status.toUpperCase()} — 0 filled` });
    }
    expect(row(submitted).lifecycle).toMatchObject({ executionState: 'SUBMITTED', finalActionability: 'NO TICKET' });
  });
  it('(5) partially filled entry → PARTIALLY FILLED — DO NOT DUPLICATE', () => {
    const x = executionStatus(PENDING_MCD, trades([order({ status: 'partially_filled', filled_qty: '30' })], [{ symbol: 'MCD', qty: '30' }]), FRESH);
    expect(x).toMatchObject({ brokerEntry: 'PARTIALLY FILLED — 30 sh @ $263.55', effective: PARTIALLY_FILLED, newEntryPermitted: false });
  });
  it('(6) zero-match linkage: no order attached, conservative unverified state, unlinked order named', () => {
    const x = executionStatus(PENDING_MCD, trades([order({ stop_price: String(NEW_MCD.entry + 0.5) })]), FRESH);
    expect(x).toMatchObject({ brokerEntry: 'UNLINKED — no broker order deterministically linked to this alert', effective: PENDING_UNVERIFIED, newEntryPermitted: false, orderIds: [] });
    expect(x.notes[0]).toMatch(/1 MCD broker order\(s\) today are not linked to any RB alert \(no price match\)/);
  });
  it('(7) ambiguous multi-alert linkage: two alerts at the same entry → attached to neither', () => {
    // Two alerts, both with candidates planned at the same entry, both before the order → the order matches two.
    const second = recordWith({ symbol: 'MCD', direction: 'LONG', alertIso: '2026-11-03T14:15:49-05:00', price: 100.95, values: {} });
    const twin: Candidate = { ...NEW_MCD, id: second.id, alertMs: second.alert.alertTimeMs, createdAt: NEW_MCD.createdAt + 1 };
    const two = run({ records: [MCD_REC, second], candidates: [PENDING_MCD, twin], now: NOW + 120_000, quotes: { MCD: quote(100.95, NOW + 120_000) } });
    expect(two.rows.filter((r) => r.candidate?.entry === NEW_MCD.entry)).toHaveLength(2);
    const t = trades([order()], HELD, two.rows);
    expect(t[0]).toMatchObject({ linkage: 'AMBIGUOUS', recordId: null });
    for (const c of [PENDING_MCD, { ...twin, status: 'PENDING' as const }]) expect(executionStatus(c, t, FRESH)).toMatchObject({ orderIds: [], effective: PENDING_UNVERIFIED });
    expect(executionStatus(PENDING_MCD, t, FRESH).notes[0]).toMatch(/ambiguous/);
  });
  it('(8) multiple same-ticker broker orders: only the linked one is the candidate\'s; the other is reported, not attributed', () => {
    const x = executionStatus(PENDING_MCD, trades([order(), order({ id: 'manual', stop_price: '250.00', submitted_at: new Date(T0 + 900_000).toISOString() })]), FRESH);
    expect(x).toMatchObject({ effective: ALREADY_EXECUTED, orderIds: ['mcd-entry'] });
    expect(x.notes[0]).toMatch(/1 MCD broker order\(s\) today are not linked/);
  });
  it('(9) protective bracket legs are exits, not entries: one trade for the bracket', () => {
    const t = trades([order()]);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ entryOrderId: 'mcd-entry', entryQty: 75, positionStatus: 'OPEN' });
  });
  it('(10) an executed order never reads as a new-entry recommendation (queue and Ranker)', () => {
    expect(row(submitted).decision.ticket).toBeNull();
    const x = executionStatus(PENDING_MCD, trades([order()]), FRESH);
    const rk = rankCandidates(submitted.candidates, [], RK, '2026-11-03');
    const shown = withExecutionDisplay(rk, { [PENDING_MCD.id]: x });
    const r = shown.ranked.find((y) => y.candidate.id === PENDING_MCD.id)!;
    expect(r.displayStatus).toBe('EXECUTED — NO NEW ENTRY');
    const orig = rk.ranked.find((y) => y.candidate.id === PENDING_MCD.id)!;
    expect([r.total, r.tier, r.eligibilityLabel, r.components]).toEqual([orig.total, orig.tier, orig.eligibilityLabel, orig.components]); // quality unchanged
    const html = renderToStaticMarkup(createElement(DecisionCard, { r, execution: x }));
    expect(html).toContain(ALREADY_EXECUTED);
    expect(html).toContain('Opportunity quality (historical — not a new-entry signal)');
    expect(html).toContain('RB candidate: </span><b>PENDING (user-maintained)');
    expect(html).toContain('Broker entry: </span><b>FILLED — 75 sh @ $263.55');
    expect(html).toContain('Broker position: </span><b>OPEN — LONG 75');
  });
  it('(11) a new independent later alert is evaluated independently (existing same-ticker rule still applies)', () => {
    const later = recordWith({ symbol: 'MCD', direction: 'LONG', alertIso: '2026-11-03T15:05:19-05:00', price: 100.95, values: {} });
    const at = Date.parse('2026-11-03T15:05:40-05:00');
    // While the earlier execution is active, the existing one-candidate-per-ticker rule applies (unchanged): no pyramiding.
    const active = run({ records: [MCD_REC, later], candidates: [PENDING_MCD], now: at, quotes: { MCD: quote(100.95, at) } });
    expect(active.rows.find((y) => y.record.id === later.id)!.candidate).toBeFalsy();
    // Once the earlier trade is closed, the later alert is its own candidate with its own evaluation and no execution.
    const closed = run({ records: [MCD_REC, later], candidates: [{ ...PENDING_MCD, status: 'STOPPED_OUT' }], now: at, quotes: { MCD: quote(100.95, at) } });
    const fresh = closed.candidates.find((c) => c.id === later.id)!;
    expect(fresh.status).toBe('NEW');
    expect(executionStatus(fresh, trades([order()], [], closed.rows), FRESH)).toMatchObject({ effective: null, newEntryPermitted: true });
    expect(closed.rows.find((y) => y.record.id === later.id)!.ranked?.total).not.toBeNull();
  });
  it('closed execution and FILLED without a link', () => {
    expect(executionStatus(PENDING_MCD, trades([order()], []), FRESH)).toMatchObject({ brokerPosition: 'CLOSED', effective: EXECUTED_CLOSED });
    expect(executionStatus({ ...PENDING_MCD, status: 'FILLED' }, [], FRESH)).toMatchObject({ effective: IN_POSITION_UNVERIFIED, newEntryPermitted: false });
    expect(executionShortLabel(executionStatus(PENDING_MCD, [], FRESH))).toBe('PENDING — LINK UNVERIFIED');
  });
});

describe('incremental portfolio baseline vs actual portfolio (C)', () => {
  it('(12) the selected candidate is evaluated excluding its own reservation; the actual portfolio counts it', () => {
    const rk = rankCandidates([PENDING_MCD], [], RK, '2026-11-03');
    const r = rk.ranked[0];
    expect([r.portfolio.slotsUsed, r.portfolio.heatCommitted]).toEqual([0, 0]);
    expect([rk.portfolio.slotsUsed, rk.portfolio.heatCommitted]).toEqual([1, PENDING_MCD.plannedRisk]);
    const html = renderToStaticMarkup(createElement(FitPanel, { r, overall: rk.portfolio, s: RK, suggestions: [], onStatus: () => {}, onUpdate: () => {}, onKeep: () => {}, onReplace: () => {}, onLogJournal: () => {}, onDelete: () => {} }));
    expect(html).toContain('Incremental portfolio-fit baseline — portfolio excluding the selected candidate.');
    expect(html).toContain('not a statement that the account holds no MCD position');
    expect(html).toMatch(/Actual portfolio: <b[^>]*>1 \/ 4<\/b> slots/);
    expect(html).toContain('Slots including this candidate');
    expect(html).toContain('Projected heat including this candidate');
  });
});

describe('score provenance (D)', () => {
  const v11 = (r: ReturnType<typeof row>) => queueLayout(presentationFor('RB v1.1'), { v12MaxScore: 91 }).find((c) => c.version === 'RB v1.1')!.cell(r);
  it('(13) the alert-time score is frozen at first scoring (candidate + snapshot) and shown for a submitted row', () => {
    const r0 = row(first);
    expect(NEW_MCD.initialScore?.total).toBe(r0.ranked!.total);
    const cell = v11(row(submitted));
    expect(cell).toMatchObject({ score: NEW_MCD.initialScore!.total, frozen: true, frozenLabel: 'Alert-time · frozen' });
  });
  it('(14, 15) live re-evaluation is labelled separately; a later exposure change moves only the live score', () => {
    // Exposure added after the alert (portfolio-fit points move); the frozen alert-time score does not.
    const exposure: ManualPosition[] = Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, ticker: `X${i}`, direction: 'LONG', sector: 'Restaurants', industry: 'Restaurants', theme: '', positionValue: 18000, plannedRisk: 240, entry: 10, stop: 9, target: 12, status: 'OPEN' }));
    const later = run({ candidates: [PENDING_MCD], positions: exposure, now: NOW + 180_000, quotes: { MCD: quote(100.95, NOW + 180_000) } });
    const cell = v11(row(later));
    expect(cell.score).toBe(NEW_MCD.initialScore!.total);
    expect(cell.live).toBe(row(later).ranked!.total);
    expect(cell.live).toBeLessThan(cell.score!); // e.g. 89 at the alert → a lower live value later: both valid, different times
    const html = renderToStaticMarkup(createElement(DecisionCard, { r: rankCandidates([PENDING_MCD], exposure, RK, '2026-11-03').ranked[0], execution: null }));
    expect(html).toContain('Current re-evaluation (live)');
    expect(html).toContain(`Alert-time (frozen): <b class="num">${NEW_MCD.initialScore!.total}</b>`);
  });
  it('a NEW (unsubmitted) row still shows its live score exactly as before', () => {
    expect(v11(row(first))).toEqual({ score: row(first).ranked!.total, tiers: [row(first).ranked!.tier], decision: row(first).decision.decision });
  });
});

describe('outage, terminal states, reload, safety (16–24)', () => {
  it('(16) broker outage after a confirmed fill: no fresh claim — last known is labelled, unavailable is conservative', () => {
    const stale = executionStatus(PENDING_MCD, trades([order()]), { verified: false, asOfMs: NOW + 60_000 });
    expect(stale).toMatchObject({ effective: ALREADY_EXECUTED, verified: false });
    expect(stale.notes.join(' ')).toMatch(/last known at 14:16:39 ET — not currently verified/);
    expect(executionStatus(PENDING_MCD, null, { verified: false, asOfMs: null })).toMatchObject({ brokerEntry: 'UNLINKED — broker data unavailable', effective: PENDING_UNVERIFIED, newEntryPermitted: false });
  });
  it('(17, 18) terminal SETUP FAILED and EXPIRED — STALE stay terminal (no execution status, no revival)', () => {
    const terminal = { [MCD_REC.id]: { recordId: MCD_REC.id, kind: 'SETUP_FAILED' as const, direction: 'LONG' as const, alertTimeMs: T0, observedAtMs: NOW, price: 99, stop: 99.5, quoteTradeIso: new Date(NOW).toISOString() } };
    expect(row(run({ terminal, now: NOW + 60_000 })).lifecycle).toMatchObject({ executionState: 'SETUP FAILED', finalActionability: 'NO TRADE' });
    const late = NOW + RB_V1_DEFAULTS.alertWindowMinutes * 60_000;
    expect(row(run({ now: late, quotes: { MCD: quote(100.95, late) } })).lifecycle).toMatchObject({ executionState: 'EXPIRED — STALE', finalActionability: 'NO TRADE' });
    expect(executionStatus({ ...NEW_MCD, status: 'EXPIRED' }, trades([order()]), FRESH)).toMatchObject({ effective: null, newEntryPermitted: false });
  });
  it('(23) reload: a persisted candidate gives the same status; nothing is written back', () => {
    const reloaded = JSON.parse(JSON.stringify(PENDING_MCD)) as Candidate;
    expect(executionStatus(reloaded, trades([order()]), FRESH)).toEqual(executionStatus(PENDING_MCD, trades([order()]), FRESH));
    expect(reloaded).toEqual(PENDING_MCD);
  });
  it('(24) read-only: the module performs no I/O and cannot touch a broker order', () => {
    const src = readFileSync(join(__dirname, '..', 'lifecycle', 'executionStatus.ts'), 'utf8');
    expect(src).not.toMatch(/\bfetch\(|XMLHttpRequest|alpaca\.markets|method:|localStorage/);
  });
});
