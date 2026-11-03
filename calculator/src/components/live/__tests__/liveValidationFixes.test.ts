/**
 * Nov 3 live-validation fixes: (1) terminal SETUP FAILED — an observed breach of the planned stop ends the alert
 * (no revival, no ticket), latched only from fresh, reliable quotes; (2) the v1.2 queue score/tiers are the FROZEN
 * alert-time values and survive hard failures. RB v1.1 decisions and all formulas are unchanged.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../../../engine/automation/alertDecision';
import { recordWith } from '../../../engine/automation/__tests__/fixtures';
import { buildQueue, type QueueOutput, type QueueRow } from '../../../engine/automation/liveQueue';
import { receiptAudit, withReconstruction, type AutoAlertRecordV12 } from '../../../engine/automation/v12/audit';
import type { RuleSetEntry } from '../../../engine/automation/v12/ruleSets';
import { freezeAlertSnapshots, type AlertSnapshotMap } from '../../../engine/automation/lifecycle/alertTimeSnapshot';
import { latchTerminalEvents, observedSetupFailure, type TerminalEventMap } from '../../../engine/automation/lifecycle/terminalEvents';
import type { Candidate } from '../../../engine/ranker/opportunityTypes';
import { cloneRankerDefaults } from '../../../engine/ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../../engine/settings';
import { LiveQueuePage } from '../LiveQueuePage';
import { decisionBadge, finalBadge, presentationFor, queueLayout } from '../queueView';

const ALERT = '2026-10-30T10:15:04-04:00';
const T0 = Date.parse(ALERT);
const RK = cloneRankerDefaults();
const REG: RuleSetEntry[] = [
  { id: 'RBTS-L-TEST', direction: 'LONG', rulesVersion: 'RB v1.2', audited: 'TEST', checklistRef: 'TEST', active: true, rules: ['TEST'] },
  { id: 'RBTS-S-TEST', direction: 'SHORT', rulesVersion: 'RB v1.2', audited: 'TEST', checklistRef: 'TEST', active: true, rules: ['TEST'] },
];
function withV12(r: AutoAlertRecord): AutoAlertRecordV12 {
  const end = Date.parse('2026-10-30T10:15:00-04:00');
  if (r.snapshot) r.snapshot.signal = { startIso: new Date(end - 300_000).toISOString(), endIso: new Date(end).toISOString(), label: '10:10–10:15' };
  const a = receiptAudit({ body: { rule_set: r.alert.direction === 'LONG' ? 'RBTS-L-TEST' : 'RBTS-S-TEST' }, symbol: r.alert.symbol, direction: r.alert.direction, receivedMs: r.receivedMs, v11Key: r.dedupeKey, registry: REG });
  return { ...r, v12: withReconstruction(a, r, [], r.alert.direction, DEFAULT_AUTOMATION.parity, null) };
}
const LONG = () => withV12(recordWith({ symbol: 'AAA', direction: 'LONG', alertIso: ALERT, price: 100.95, values: {} })); // entry 101.02, stop 100.00
/** GS SHORT 2026-11-03 12:05 production values (signal candle, indicators); entry 892.32, stop 894.16. */
const GS = () => withV12(recordWith({
  symbol: 'GS', direction: 'SHORT', alertIso: ALERT, price: 892.95,
  values: { open: 893.56, high: 894.09, low: 892.5, close: 893, atr: 1.8375076778270003, ema9: 895.3133353821252, ema20: 897.0266847594837, rsi: 27.00662554811956, rvol: 1.1679170196298305, vwap: 898.1619671909663, close15m: 893.59, ema20_15m: 899.7618719231194 },
}));
const quote = (price: number, now: number, ageMs = 500, tradeAgeMs = 1000): LiveQuote => ({ price, tradeIso: new Date(now - ageMs - tradeAgeMs).toISOString(), fetchedIso: new Date(now - ageMs).toISOString(), receivedMs: now - ageMs });

interface Step { now: number; price: number; q?: (price: number, now: number) => LiveQuote | null; candidates?: (cs: Candidate[]) => Candidate[] }
/** The app loop: build → freeze snapshots → latch terminal events, feeding both into the next pass. */
function session(rec: AutoAlertRecord, steps: Step[]) {
  let candidates: Candidate[] = [];
  let frozen: AlertSnapshotMap = {};
  let terminal: TerminalEventMap = {};
  const out: { row: QueueRow; out: QueueOutput; frozen: AlertSnapshotMap; terminal: TerminalEventMap }[] = [];
  for (const s of steps) {
    if (s.candidates) candidates = s.candidates(candidates);
    const qt = s.q ? s.q(s.price, s.now) : quote(s.price, s.now);
    const o = buildQueue({ records: [rec], candidates, positions: [], quotes: qt ? { [rec.alert.symbol]: qt } : {}, now: s.now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: RK, classify: (x) => ({ sector: `S-${x}`, industry: `I-${x}`, theme: '' }), parity: {}, strategyVersion: 'RB v1.1', frozen, terminal });
    candidates = o.candidates;
    frozen = freezeAlertSnapshots(frozen, o.rows, s.now, 91).map;
    terminal = latchTerminalEvents(terminal, o.rows, s.now, DEFAULT_AUTOMATION).map;
    out.push({ row: o.rows[0], out: o, frozen, terminal });
  }
  return out;
}
const at = (min: number) => T0 + min * 60_000;
const v12col = (r: QueueRow) => queueLayout(presentationFor('RB v1.1'), { v12MaxScore: 91 }).find((c) => c.version === 'RB v1.2')!.cell(r);
const render = (rows: QueueRow[], now: number) => renderToStaticMarkup(createElement(LiveQueuePage, {
  rows, suggestions: [], now, enabled: true, feed: { lastOkMs: now, error: null }, quoteError: null, parityStatus: 'VALIDATED', versionLabel: 'RB v1.1',
  actions: { submit: vi.fn(), skip: vi.fn(), watch: vi.fn(), openInCalculator: vi.fn(), classify: vi.fn(), reprocess: vi.fn(), keep: vi.fn(), replace: vi.fn() },
  onOpenSettings: () => {}, shadow: { maxScore: 91, optionAGrades: RK.grades, logCount: 0, onExportLog: () => {} },
}));

describe('terminal SETUP FAILED — LONG', () => {
  const s = session(LONG(), [{ now: at(1), price: 100.95 }, { now: at(2), price: 99.95 }, { now: at(3), price: 100.95 }, { now: at(4), price: 100.98 }]);
  it('before the breach: normal (v1.1 ticket, READY)', () => {
    expect(s[0].row.decision.ticket).not.toBeNull();
    expect(s[0].row.lifecycle).toMatchObject({ finalActionability: 'READY', setupFailed: null });
  });
  it('breach (price ≤ stop) → SETUP FAILED · NO TRADE, terminal, latched once', () => {
    expect(s[1].terminal[s[1].row.record.id]).toMatchObject({ kind: 'SETUP_FAILED', price: 99.95, stop: 100 });
    // the latch is applied on the next pass
    expect(s[2].row.lifecycle).toMatchObject({ executionState: 'SETUP FAILED', finalActionability: 'NO TRADE', terminal: true, setupFailed: { price: 99.95, stop: 100 } });
  });
  it('price recovers → still SETUP FAILED; the v1.1 decision is unchanged but its ticket is withheld', () => {
    const r = s[3].row;
    expect(r.decision.ticket).not.toBeNull(); // RB v1.1 output itself unchanged
    expect(r.lifecycle.executionState).toBe('SETUP FAILED');
    expect(finalBadge(r)).toMatchObject({ label: 'NO TRADE — SETUP FAILED', tone: 'bad' });
    expect(decisionBadge(r).label).toBe('v1.1 TICKET — SETUP FAILED');
    const html = render(s[3].out.rows, at(4));
    expect(html).not.toContain('Copy TrendSpider order');
    expect(html).not.toContain('Mark order submitted');
    expect(html).toContain('SETUP FAILED');
  });
  it('frozen snapshot, score, tiers and plan are preserved (same object)', () => {
    const id = s[0].row.record.id;
    expect(s[3].frozen[id]).toBe(s[0].frozen[id]);
    expect(s[3].row.lifecycle.alertTimeTier).toBe(s[0].frozen[id].v11.tier);
    expect([s[3].row.candidate!.entry, s[3].row.candidate!.stop, s[3].row.candidate!.target, s[3].row.candidate!.shares]).toEqual([101.02, 100, 103.06, 197]);
  });
  it('the latched event is write-once (a later breach does not change it)', () => {
    const later = session(LONG(), [{ now: at(1), price: 100.95 }, { now: at(2), price: 99.95 }, { now: at(3), price: 99.5 }]);
    expect(later[2].terminal[later[0].row.record.id]).toMatchObject({ price: 99.95, observedAtMs: at(2) });
  });
});

describe('terminal SETUP FAILED — SHORT (GS 2026-11-03 replay: crossed the stop, then recovered)', () => {
  // 12:05 893.00 → 12:09 894.04 → 12:11 894.72 (≥ stop 894.16) → 12:13 893.40 → 12:14 893.805
  const s = session(GS(), [{ now: at(0.5), price: 893 }, { now: at(4), price: 894.04 }, { now: at(6), price: 894.72 }, { now: at(8), price: 893.4 }, { now: at(9), price: 893.805 }]);
  it('plan from the frozen snapshot: entry 892.32, stop 894.16, target 888.64, 22 shares', () => {
    expect([s[0].row.candidate!.entry, s[0].row.candidate!.stop, s[0].row.candidate!.target, s[0].row.candidate!.shares]).toEqual([892.32, 894.16, 888.64, 22]);
  });
  it('894.04 (below the stop) does not latch; 894.72 latches; recovery to 893.40 / 893.805 stays SETUP FAILED', () => {
    const id = s[0].row.record.id;
    expect(s[1].terminal[id]).toBeUndefined();
    expect(s[2].terminal[id]).toMatchObject({ direction: 'SHORT', price: 894.72, stop: 894.16 });
    for (const k of [3, 4]) expect(s[k].row.lifecycle).toMatchObject({ executionState: 'SETUP FAILED', finalActionability: 'NO TRADE', terminal: true });
    expect(s[4].row.live!.action).not.toBe('SKIP_SETUP_FAILED'); // the live calculator alone would have "revived" it
  });
  it('v1.2 queue score stays the frozen alert-time value through the drift, then shows Frozen · not ranked', () => {
    const id = s[0].row.record.id;
    const frozen = s[0].frozen[id].v12!;
    for (const k of [0, 1, 2, 3, 4]) {
      const c = v12col(s[k].row);
      expect([c.score, c.tiers]).toEqual([frozen.total, [frozen.tierOptionB, frozen.tierOptionA]]);
    }
    expect(v12col(s[4].row).frozen).toBe(frozen.total !== null);
  });
});

describe('a breach is latched only from a reliable, fresh observation', () => {
  const id = (s: ReturnType<typeof session>) => s[0].row.record.id;
  it('stale current price (data age > 5 s) → not latched', () => {
    const s = session(LONG(), [{ now: at(1), price: 100.95 }, { now: at(2), price: 99.95, q: (p, n) => quote(p, n, 6_000) }]);
    expect(s[1].terminal[id(s)]).toBeUndefined();
  });
  it('stale last trade (> 60 s before fetch) → not latched', () => {
    const s = session(LONG(), [{ now: at(1), price: 100.95 }, { now: at(2), price: 99.95, q: (p, n) => quote(p, n, 500, 120_000) }]);
    expect(s[1].terminal[id(s)]).toBeUndefined();
  });
  it('no current quote (missing data) → never inferred', () => {
    const s = session(LONG(), [{ now: at(1), price: 100.95 }, { now: at(2), price: 99.95, q: () => null }]);
    expect(s[1].terminal[id(s)]).toBeUndefined();
  });
  it('after the alert window → not latched (the alert is already terminal)', () => {
    const s = session(LONG(), [{ now: at(1), price: 100.95 }, { now: at(11), price: 99.95 }]);
    expect(s[1].terminal[id(s)]).toBeUndefined();
    expect(s[1].row.lifecycle.executionState).toBe('EXPIRED — STALE');
  });
  it('order already submitted (PENDING) or filled → not latched (the broker governs it)', () => {
    for (const st of ['PENDING', 'FILLED'] as const) {
      const s = session(LONG(), [{ now: at(1), price: 100.95 }, { now: at(2), price: 99.95, candidates: (cs) => cs.map((c) => ({ ...c, status: st })) }]);
      expect(s[1].terminal[id(s)]).toBeUndefined();
    }
  });
  it('observedSetupFailure requires the observed price itself to be through the planned stop', () => {
    const s = session(LONG(), [{ now: at(1), price: 100.95 }]);
    const r = s[0].row;
    const fake = { ...r, live: { ...r.live!, hardFails: [{ code: 'SETUP_FAILED', label: '', reason: '' }] } } as unknown as QueueRow;
    expect(observedSetupFailure(fake, at(1), DEFAULT_AUTOMATION)).toBeNull(); // quote 100.95 is above the 100.00 stop
  });
});

describe('frozen v1.2 score presentation', () => {
  const s = session(LONG(), [{ now: at(1), price: 100.95 }, { now: at(2), price: 100.95 }]);
  const r = s[1].row;
  it('the column shows the frozen score/tiers even when the live v1.2 score differs', () => {
    const drift = { ...r, shadow: { ...r.shadow!, score: { ...r.shadow!.score!, total: (r.lifecycle.frozenV12!.total ?? 0) + 3, tierOptionB: 'ELITE' as const } } };
    const c = v12col(drift as QueueRow);
    expect(c.score).toBe(r.lifecycle.frozenV12!.total);
    expect(c.tiers[0]).toBe(r.lifecycle.frozenV12!.tierOptionB);
  });
  it('a hard fail (no live v1.2 score) keeps the frozen score, marked Frozen · not ranked', () => {
    const failed = { ...r, shadow: { ...r.shadow!, score: null } } as QueueRow;
    const c = v12col(failed);
    expect([c.score, c.frozen]).toEqual([r.lifecycle.frozenV12!.total, true]);
  });
  it('a snapshot without a v1.2 score shows unavailable — never a later live score', () => {
    const none = { ...r, lifecycle: { ...r.lifecycle, frozenV12: { total: null, max: 91, tierOptionA: null, tierOptionB: null } } } as QueueRow;
    expect(v12col(none)).toMatchObject({ score: null, tiers: [null, null] });
  });
  it('before the snapshot exists (first pass) the alert-time evaluation itself is shown', () => {
    const first = s[0].row;
    expect(first.lifecycle.frozenV12).toBeNull();
    expect(v12col(first).score).toBe(first.shadow?.score?.total ?? null);
  });
});
