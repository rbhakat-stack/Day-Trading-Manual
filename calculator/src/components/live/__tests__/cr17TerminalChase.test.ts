/**
 * CR-17 — terminal chase safety and entry-state clarity.
 *
 * A setup whose price was RELIABLY observed beyond the existing 0.25 ATR chase limit (unsubmitted) is terminally
 * MISSED — DO NOT CHASE: a later pullback can never make it READY again. Exactly three entry states are presented
 * (READY — PLACE STOP ORDER · TRIGGER CROSSED — REVIEW ENTRY · MISSED — DO NOT CHASE); every other outcome keeps the
 * existing final decision. Scores, tickets, formulas, thresholds and the RB v1.1 decision are unchanged.
 *
 * The VRSK case replays the production record VRSK-L-103509-494e49 (2026-11-04 10:35:09 ET) against real SIP
 * round-lot prices (vrsk-2026-11-04.json). It is a REPLAY: it does not claim what the production browser displayed.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../../../engine/automation/alertDecision';
import { recordWith } from '../../../engine/automation/__tests__/fixtures';
import { buildQueue, type QueueRow } from '../../../engine/automation/liveQueue';
import { receiptAudit, withReconstruction, type AutoAlertRecordV12 } from '../../../engine/automation/v12/audit';
import type { RuleSetEntry } from '../../../engine/automation/v12/ruleSets';
import { freezeAlertSnapshots, type AlertSnapshotMap } from '../../../engine/automation/lifecycle/alertTimeSnapshot';
import { chaseKey, latchTerminalEvents, observedChase, type TerminalEventMap } from '../../../engine/automation/lifecycle/terminalEvents';
import { executionStatus } from '../../../engine/automation/lifecycle/executionStatus';
import { KNOWN_CLASSIFICATIONS } from '../../../engine/ranker/correlationRules';
import type { Candidate } from '../../../engine/ranker/opportunityTypes';
import { cloneRankerDefaults } from '../../../engine/ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../../engine/settings';
import { LiveQueuePage } from '../LiveQueuePage';
import { QueueDetails } from '../QueueParts';
import { decisionBadge, entryState, finalBadge, MISSED_DO_NOT_CHASE, presentationFor, queueLayout, READY_PLACE_STOP, ticketActionable, TRIGGER_CROSSED_REVIEW } from '../queueView';

const RK = cloneRankerDefaults();
const ALERT = '2026-10-30T10:15:04-04:00';
const T0 = Date.parse(ALERT);
const at = (min: number) => T0 + min * 60_000;
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
/** LONG: entry 101.02, stop 100.00, ATR 1 → chase limit 101.27. */
const LONG = (o: Partial<Parameters<typeof recordWith>[0]> = {}) => withV12(recordWith({ symbol: 'AAA', direction: 'LONG', alertIso: ALERT, price: 100.95, values: {}, ...o }));
/** SHORT (mirror of LONG, TRADE NOW — ELITE): entry 99.98, stop 101.00, ATR 1 → chase limit 99.73. */
const SHORT = () => withV12(recordWith({ symbol: 'BBB', direction: 'SHORT', alertIso: ALERT, price: 100.05, values: { open: 101, high: 101, low: 100, close: 100, atr: 1, ema9: 100.3, ema20: 100.9, rsi: 33, rvol: 4, vwap: 100.7, close15m: 100, ema20_15m: 101 } }));
const WEAK = () => withV12(recordWith({ symbol: 'FIS', direction: 'LONG', alertIso: ALERT, price: 100.95, values: { rvol: 1.5, rsi: 56, ema9: 100.15, ema20: 100.1 } }));
const quote = (price: number, now: number, ageMs = 500, tradeAgeMs = 1000): LiveQuote => ({ price, tradeIso: new Date(now - ageMs - tradeAgeMs).toISOString(), fetchedIso: new Date(now - ageMs).toISOString(), receivedMs: now - ageMs });

interface Step { now: number; price: number; q?: (price: number, now: number) => LiveQuote | null; candidates?: (cs: Candidate[]) => Candidate[]; portfolioGate?: string | null }
interface State { candidates: Candidate[]; frozen: AlertSnapshotMap; terminal: TerminalEventMap }
/** The app loop: build → freeze snapshots → latch terminal events, feeding them into the next pass. `latch: false` = pre-CR-17 behaviour of the chase. */
function session(records: AutoAlertRecord[], steps: Step[], o: { latch?: boolean; start?: State; classify?: (s: string) => { sector: string; industry: string; theme: string } } = {}) {
  let { candidates, frozen, terminal } = o.start ?? { candidates: [] as Candidate[], frozen: {} as AlertSnapshotMap, terminal: {} as TerminalEventMap };
  const classify = o.classify ?? ((x: string) => ({ sector: `S-${x}`, industry: `I-${x}`, theme: '' }));
  return steps.map((s) => {
    if (s.candidates) candidates = s.candidates(candidates);
    const quotes: Record<string, LiveQuote> = {};
    for (const r of records) {
      const qt = s.q ? s.q(s.price, s.now) : quote(s.price, s.now);
      if (qt) quotes[r.alert.symbol] = qt;
    }
    const out = buildQueue({ records, candidates, positions: [], quotes, now: s.now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: RK, classify, parity: {}, strategyVersion: 'RB v1.1', frozen, terminal, portfolioGate: s.portfolioGate ?? null });
    candidates = out.candidates;
    frozen = freezeAlertSnapshots(frozen, out.rows, s.now, 91).map;
    if (o.latch !== false) terminal = latchTerminalEvents(terminal, out.rows, s.now, DEFAULT_AUTOMATION).map;
    return { rows: out.rows, row: out.rows[0], state: { candidates, frozen, terminal } as State };
  });
}
const actions = { submit: vi.fn(), skip: vi.fn(), watch: vi.fn(), openInCalculator: vi.fn(), classify: vi.fn(), reprocess: vi.fn(), keep: vi.fn(), replace: vi.fn() };
const page = (rows: QueueRow[], now: number) => renderToStaticMarkup(createElement(LiveQueuePage, {
  rows, suggestions: [], now, enabled: true, feed: { lastOkMs: now, error: null }, quoteError: null, parityStatus: 'VALIDATED', versionLabel: 'RB v1.1',
  actions, onOpenSettings: () => {}, shadow: { maxScore: 91, optionAGrades: RK.grades, logCount: 0, onExportLog: () => {} },
}));
const details = (r: QueueRow, now: number) => renderToStaticMarkup(createElement(QueueDetails, { r, now, actions, layout: queueLayout(presentationFor('RB v1.1'), { v12MaxScore: 91 }), maxScore: 91, optionAGrades: RK.grades }));
const count = (html: string, s: string) => html.split(s).length - 1;

/* ───────────────────────── 1 · VRSK 2026-11-04 10:35:09 replay ───────────────────────── */

const FX = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../engine/automation/__tests__/vrsk-2026-11-04.json'), 'utf8')) as { record: AutoAlertRecordV12; observations: { offsetMs: number; price: number; tradeIso: string }[] };
const VRSK = FX.record;
const A = VRSK.receivedMs;
const vrskSteps: Step[] = FX.observations.map((x) => ({ now: A + x.offsetMs, price: x.price, q: (p, now) => ({ price: p, tradeIso: x.tradeIso, fetchedIso: new Date(now - 300).toISOString(), receivedMs: now - 100 }) }));
const knownClassify = (s: string) => KNOWN_CLASSIFICATIONS[s] ?? { sector: `Sector-${s}`, industry: `Industry-${s}`, theme: '' };
const vrsk = (latch: boolean) => session([VRSK], vrskSteps, { latch, classify: knownClassify }).map((s, i) => ({ ...s, off: FX.observations[i].offsetMs }));
const READY = (s: { row: QueueRow }) => s.row.lifecycle.finalActionability === 'READY' && ticketActionable(s.row);

describe('1 · VRSK 10:35:09 — replay of the production record against real SIP round-lot prices', () => {
  const before = vrsk(false);
  const after = vrsk(true);
  const firstChase = after.findIndex((s) => s.row.live?.hardFails.some((f) => f.code === 'CHASED_SETUP'));

  it('reproduces the pre-CR-17 revival: READY at 10:35:12, CHASED at 10:35:13, READY AGAIN at 10:36:45.5', () => {
    expect(READY(before.find((s) => s.off === 3000)!)).toBe(true);
    expect(before.find((s) => s.off === 4700)!.row.lifecycle.executionState).toBe('CHASED');
    const revival = before.find((s) => s.off === 96500)!;
    expect(revival.row.live!.chase!.crossed).toBe(false); // 201.2334 < 201.26
    expect(READY(revival)).toBe(true); // the defect
  });
  it('CR-17: READY at 10:35:12 → MISSED — DO NOT CHASE latched at the first reliable chase (201.465, +0.26 ATR) → never READY again', () => {
    expect(READY(after.find((s) => s.off === 3000)!)).toBe(true);
    expect(entryState(after.find((s) => s.off === 3000)!.row)!.label).toBe(READY_PLACE_STOP);
    expect(FX.observations[firstChase].offsetMs).toBe(4700);
    const ev = after[firstChase].state.terminal[chaseKey(VRSK.id)];
    expect(ev).toMatchObject({ kind: 'CHASED', price: 201.465, entry: 201.26, distanceAtr: 0.26, thresholdAtr: 0.25, quoteTradeIso: FX.observations[firstChase].tradeIso });
    for (const s of after.slice(firstChase + 1)) {
      expect(READY(s)).toBe(false);
      expect(s.row.lifecycle.chaseMissed).not.toBeNull();
      expect(entryState(s.row)!.label).toBe(MISSED_DO_NOT_CHASE);
    }
    const revival = after.find((s) => s.off === 96500)!;
    expect(revival.row.decision.ticket).not.toBeNull(); // the RB v1.1 decision itself is unchanged …
    expect(ticketActionable(revival.row)).toBe(false); // … but its ticket is withheld
  });
  it('the 10-minute expiry keeps the chase as the terminal reason (never "no trigger")', () => {
    for (const off of [600100, 610000]) {
      const s = after.find((x) => x.off === off)!;
      expect(s.row.lifecycle).toMatchObject({ executionState: 'CHASED', finalActionability: 'NO TRADE', terminal: true });
      expect(s.row.lifecycle.reason).toMatch(/^MISSED — DO NOT CHASE — price 201\.465 was beyond the 201\.26 trigger \(0\.26 ATR, limit 0\.25 ATR\) at 10:35:13 ET/);
      expect(s.row.lifecycle.reason).not.toMatch(/no trigger/);
    }
    expect(before.find((x) => x.off === 610000)!.row.lifecycle.reason).not.toMatch(/no trigger/); // CR-17 wording fix also without a latch
  });
  it('19–21 · frozen v1.1 86 HIGH and v1.2 80/91 HIGH (Option B), and the trade plan, are unchanged', () => {
    for (const run of [before, after]) {
      const last = run[run.length - 1];
      const snap = last.state.frozen[VRSK.id];
      expect(snap.v11).toMatchObject({ total: 86, tier: 'HIGH_PRIORITY' });
      expect(snap.v12).toMatchObject({ total: 80, max: 91, tierOptionB: 'HIGH_PRIORITY', tierOptionA: 'WATCHLIST' });
      expect(snap.trade).toMatchObject({ entry: 201.26, stop: 200.3, target: 203.18, shares: 99, plannedRisk: 95.04, orderType: 'BUY STOP' });
      expect(last.row.candidate).toMatchObject({ entry: 201.26, stop: 200.3, target: 203.18, shares: 99 });
    }
    expect(after[after.length - 1].state.frozen[VRSK.id]).toEqual(before[before.length - 1].state.frozen[VRSK.id]);
  });
  it('the only behavioural difference is the withheld revival (decisions and rankings identical at every step)', () => {
    before.forEach((b, i) => {
      expect(after[i].row.decision).toEqual(b.row.decision);
      expect(after[i].row.ranked).toEqual(b.row.ranked);
      expect(after[i].row.live).toEqual(b.row.live);
    });
    const diff = before.map((b, i) => (READY(b) !== READY(after[i]) ? b.off : null)).filter((x) => x !== null);
    expect(diff).toEqual([96500, 97000, 98000, 98700]); // 10:36:45.5 – 10:36:47.7 (last round lot 201.2334 @ 10:36:45.138 until 10:36:47.663)
  });
  it('25 · no duplicate entry ticket for the single alert: exactly one READY window', () => {
    const windows = after.reduce((n, s, i) => n + (READY(s) && !(i > 0 && READY(after[i - 1])) ? 1 : 0), 0);
    expect(windows).toBe(1);
  });
});

/* ───────────────────────── 2–8 · entry states and the terminal latch ───────────────────────── */

describe('2–8 · entry states', () => {
  it('2 · initial READY with an untriggered entry (LONG → BUY STOP)', () => {
    const [s] = session([LONG()], [{ now: at(1), price: 100.95 }]);
    expect(entryState(s.row)).toMatchObject({ label: READY_PLACE_STOP, tone: 'ok' });
    expect(entryState(s.row)!.detail).toMatch(/^BUY STOP · entry 101\.02 — recheck live/);
    expect(entryState(s.row)!.detail).toMatch(/not guaranteed to fill/);
  });
  it('3 · LONG crossed within the chase band → TRIGGER CROSSED — REVIEW ENTRY, no ticket, not latched', () => {
    const [, s] = session([LONG()], [{ now: at(1), price: 100.95 }, { now: at(2), price: 101.1 }]);
    expect(entryState(s.row)).toMatchObject({ label: TRIGGER_CROSSED_REVIEW, tone: 'warn' });
    expect(s.row.decision.ticket).toBeNull();
    expect(ticketActionable(s.row)).toBe(false);
    expect(s.state.terminal[chaseKey(s.row.record.id)]).toBeUndefined();
  });
  it('4 · SHORT crossed within the chase band → TRIGGER CROSSED — REVIEW ENTRY', () => {
    const [a, s] = session([SHORT()], [{ now: at(1), price: 100.05 }, { now: at(2), price: 99.9 }]);
    expect(entryState(a.row)!.label).toBe(READY_PLACE_STOP);
    expect(entryState(a.row)!.detail).toMatch(/^SELL STOP · entry 99\.98/);
    expect(entryState(s.row)!.label).toBe(TRIGGER_CROSSED_REVIEW);
    expect(s.row.decision.ticket).toBeNull();
  });
  it('5 · LONG beyond +0.25 ATR → terminal MISSED — DO NOT CHASE (latched after the observing pass, as SETUP FAILED)', () => {
    const [, s, t] = session([LONG()], [{ now: at(1), price: 100.95 }, { now: at(2), price: 101.4 }, { now: at(2.05), price: 101.4 }]);
    expect(s.state.terminal[chaseKey(s.row.record.id)]).toMatchObject({ kind: 'CHASED', direction: 'LONG', price: 101.4, entry: 101.02, distanceAtr: 0.38, thresholdAtr: 0.25 });
    expect(s.row.lifecycle).toMatchObject({ executionState: 'CHASED', finalActionability: 'NO TRADE' }); // observing pass: existing CHASED, no ticket
    expect(ticketActionable(s.row)).toBe(false);
    expect(entryState(t.row)!.label).toBe(MISSED_DO_NOT_CHASE);
  });
  it('6 · SHORT beyond −0.25 ATR → terminal MISSED — DO NOT CHASE', () => {
    const [, s, t] = session([SHORT()], [{ now: at(1), price: 100.05 }, { now: at(2), price: 99.6 }, { now: at(3), price: 100.05 }]);
    expect(s.state.terminal[chaseKey(s.row.record.id)]).toMatchObject({ kind: 'CHASED', direction: 'SHORT', price: 99.6, entry: 99.98, distanceAtr: 0.38 });
    expect(t.row.decision.ticket).not.toBeNull(); // the live calculator alone would have revived it
    expect(entryState(t.row)!.label).toBe(MISSED_DO_NOT_CHASE);
    expect(ticketActionable(t.row)).toBe(false);
  });
  it('7 · price returns to / below the entry after the chase → stays MISSED (no READY, no ticket, no submit control)', () => {
    const s = session([LONG()], [{ now: at(1), price: 100.95 }, { now: at(2), price: 101.4 }, { now: at(3), price: 101.02 }, { now: at(4), price: 100.95 }]);
    for (const x of s.slice(2)) {
      expect(x.row.decision.ticket === null || !ticketActionable(x.row)).toBe(true);
      expect(entryState(x.row)!.label).toBe(MISSED_DO_NOT_CHASE);
      expect(decisionBadge(x.row).label).toBe(MISSED_DO_NOT_CHASE);
      expect(finalBadge(x.row).label).toBe('NO TRADE');
      expect(page(x.rows, at(4))).not.toContain('Mark order submitted');
    }
    expect(s[3].row.decision.ticket).not.toBeNull(); // the live calculator alone would have revived it
  });
  it('8 · price crosses the opposite way after the chase (below entry, above stop) → stays MISSED', () => {
    const s = session([LONG()], [{ now: at(1), price: 100.95 }, { now: at(2), price: 101.4 }, { now: at(3), price: 100.5 }]);
    expect(entryState(s[2].row)!.label).toBe(MISSED_DO_NOT_CHASE);
    expect(s[2].row.lifecycle.finalActionability).toBe('NO TRADE');
  });
  it('a score below threshold shows the existing decision (SKIP), never an entry state, even when the price is in the band', () => {
    const s = session([WEAK()], [{ now: at(1), price: 100.95 }, { now: at(2), price: 101.1 }]);
    expect(s[0].row.decision.decision).toBe('SKIP');
    for (const x of s) {
      expect(entryState(x.row)).toBeNull();
      expect(ticketActionable(x.row)).toBe(false);
    }
  });
});

/* ───────────────────────── 9–18 · lifecycle, data and broker safety ───────────────────────── */

describe('9–18 · lifecycle, data and broker safety', () => {
  it('9 · a terminally chased alert reaching ten minutes → no revival, reason stays the chase', () => {
    const s = session([LONG()], [{ now: at(1), price: 100.95 }, { now: at(2), price: 101.4 }, { now: at(10.1), price: 100.95 }, { now: at(12), price: 100.9 }]);
    for (const x of s.slice(2)) {
      expect(x.row.lifecycle).toMatchObject({ executionState: 'CHASED', finalActionability: 'NO TRADE', terminal: true });
      expect(x.row.lifecycle.reason).toMatch(/^MISSED — DO NOT CHASE/);
    }
  });
  it('10 · a later, independent TrendSpider alert for the same ticker is evaluated fresh', () => {
    const first = LONG();
    const later = LONG({ alertIso: '2026-10-30T10:30:04-04:00' });
    expect(later.id).not.toBe(first.id);
    const s = session([first, later], [{ now: at(1), price: 100.95 }, { now: at(2), price: 101.4 }, { now: Date.parse('2026-10-30T10:31:04-04:00'), price: 100.95 }]);
    const row = s[2].rows.find((r) => r.record.id === later.id)!;
    expect(s[2].state.terminal[chaseKey(first.id)]).toBeDefined();
    expect(s[2].state.terminal[chaseKey(later.id)]).toBeUndefined();
    expect(row.lifecycle.chaseMissed).toBeNull();
    expect(entryState(row)?.label).toBe(READY_PLACE_STOP);
  });
  it('11 · stale market data at the chase → no terminal chase; a fresh pullback is READY again (existing behaviour)', () => {
    const s = session([LONG()], [
      { now: at(1), price: 100.95 },
      { now: at(2), price: 101.4, q: (p, now) => quote(p, now, 6000) }, // data 6 s old (> 5 s)
      { now: at(2.2), price: 101.4, q: (p, now) => quote(p, now, 500, 90_000) }, // last trade 90 s old (> 60 s)
      { now: at(3), price: 100.95 },
    ]);
    expect(s[3].state.terminal[chaseKey(s[0].row.record.id)]).toBeUndefined();
    expect(entryState(s[3].row)!.label).toBe(READY_PLACE_STOP);
  });
  it('12 · out-of-order observation (a trade older than the alert) never latches; after a latch nothing rearms', () => {
    const rec = LONG();
    const old = (p: number, now: number): LiveQuote => ({ price: p, tradeIso: new Date(rec.receivedMs - 5000).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 });
    const s = session([rec], [{ now: rec.receivedMs + 20_000, price: 100.95 }, { now: rec.receivedMs + 30_000, price: 101.4, q: old }]);
    expect(s[1].state.terminal[chaseKey(rec.id)]).toBeUndefined();
    const t = session([rec], [{ now: at(2), price: 101.4 }, { now: at(3), price: 100.95, q: old }, { now: at(4), price: 100.95 }]);
    for (const x of t.slice(1)) expect(entryState(x.row)!.label).toBe(MISSED_DO_NOT_CHASE);
  });
  it('13 · a submitted resting entry stays ORDER SUBMITTED when the market runs past it (never MISSED)', () => {
    const s = session([LONG()], [{ now: at(1), price: 100.95 }, { now: at(2), price: 101.4, candidates: (cs) => cs.map((c) => ({ ...c, status: 'PENDING' as const })) }, { now: at(3), price: 100.95 }]);
    for (const x of s.slice(1)) {
      expect(x.row.lifecycle).toMatchObject({ executionState: 'SUBMITTED', chaseMissed: null });
      expect(entryState(x.row)).toBeNull();
      expect(x.state.terminal[chaseKey(x.row.record.id)]).toBeUndefined();
    }
  });
  it('14 · a filled entry stays IN POSITION', () => {
    const s = session([LONG()], [{ now: at(1), price: 100.95 }, { now: at(2), price: 101.6, candidates: (cs) => cs.map((c) => ({ ...c, status: 'FILLED' as const })) }]);
    expect(s[1].row.lifecycle).toMatchObject({ executionState: 'IN POSITION', chaseMissed: null });
    expect(entryState(s[1].row)).toBeNull();
  });
  it('14b · an order marked submitted AFTER a latched chase is shown as submitted (broker dimension wins)', () => {
    const s = session([LONG()], [{ now: at(1), price: 100.95 }, { now: at(2), price: 101.4 }, { now: at(3), price: 101.4, candidates: (cs) => cs.map((c) => ({ ...c, status: 'PENDING' as const })) }]);
    expect(s[2].state.terminal[chaseKey(s[2].row.record.id)]).toBeDefined();
    expect(s[2].row.lifecycle.executionState).toBe('SUBMITTED');
    expect(entryState(s[2].row)).toBeNull();
  });
  it('15 · broker status unavailable → the submitted candidate stays no-new-entry (conservative)', () => {
    const s = session([LONG()], [{ now: at(1), price: 100.95 }, { now: at(2), price: 100.95, candidates: (cs) => cs.map((c) => ({ ...c, status: 'PENDING' as const })) }]);
    expect(ticketActionable(s[1].row)).toBe(false);
    const x = executionStatus(s[1].row.candidate!, null, { verified: false, asOfMs: null });
    expect(x).toMatchObject({ newEntryPermitted: false, verified: false });
  });
  it('16 · portfolio verification fails → no READY entry state, ticket withheld', () => {
    const [s] = session([LONG()], [{ now: at(1), price: 100.95, portfolioGate: 'Broker data unavailable' }]);
    expect(s.row.lifecycle.portfolioUnverified).toBe(true);
    expect(entryState(s.row)).toBeNull();
    expect(ticketActionable(s.row)).toBe(false);
  });
  it('17 · SETUP FAILED remains terminal and takes precedence; no chase is latched over it', () => {
    const s = session([LONG()], [{ now: at(1), price: 100.95 }, { now: at(2), price: 99.95 }, { now: at(3), price: 101.4 }, { now: at(4), price: 100.95 }]);
    expect(s[1].state.terminal[s[1].row.record.id]).toMatchObject({ kind: 'SETUP_FAILED' });
    for (const x of s.slice(2)) expect(x.row.lifecycle.executionState).toBe('SETUP FAILED');
    expect(s[3].state.terminal[chaseKey(s[3].row.record.id)]).toBeUndefined();
    expect(entryState(s[3].row)).toBeNull();
  });
  it('17b · a chase followed by a stop breach is still latched SETUP FAILED (both terminal; no ticket)', () => {
    const s = session([LONG()], [{ now: at(1), price: 100.95 }, { now: at(2), price: 101.4 }, { now: at(3), price: 99.95 }, { now: at(4), price: 100.95 }]);
    expect(s[3].state.terminal[s[3].row.record.id]).toMatchObject({ kind: 'SETUP_FAILED' });
    expect(s[3].row.lifecycle.executionState).toBe('SETUP FAILED');
    expect(ticketActionable(s[3].row)).toBe(false);
  });
  it('18 · EXPIRED — STALE remains terminal; "no trigger" only when the trigger is not crossed', () => {
    const s = session([LONG()], [{ now: at(1), price: 100.95 }, { now: at(10.1), price: 100.95 }, { now: at(12), price: 100.9 }]);
    for (const x of s.slice(1)) {
      expect(x.row.lifecycle).toMatchObject({ executionState: 'EXPIRED — STALE', terminal: true });
      expect(x.row.lifecycle.reason).toMatch(/no trigger within 10 minutes/);
    }
    const c = session([LONG()], [{ now: at(1), price: 100.95 }, { now: at(10.1), price: 101.1 }]);
    expect(c[1].row.lifecycle).toMatchObject({ executionState: 'EXPIRED — STALE', terminal: true });
    expect(c[1].row.lifecycle.reason).toMatch(/entry trigger was crossed but no order was submitted/);
  });
});

/* ───────────────────────── 22–24 · presentation, persistence, data review ───────────────────────── */

describe('22–24 · presentation, persistence and data review', () => {
  it('22 · the same entry state in the main queue row and the expanded header, Trade Construction and Portfolio & Execution', () => {
    const s = session([LONG()], [{ now: at(1), price: 100.95 }, { now: at(2), price: 101.4 }, { now: at(3), price: 100.95 }]);
    const html = page(s[2].rows, at(3));
    expect(html).toContain(`>${MISSED_DO_NOT_CHASE}<`);
    const d = details(s[2].row, at(3));
    expect(count(d, `>${MISSED_DO_NOT_CHASE}<`)).toBeGreaterThanOrEqual(3); // header pill, Trade Construction, Portfolio & Execution
    expect(d).not.toContain('Mark order submitted');
    const ready = details(s[0].row, at(1));
    expect(count(ready, `>${READY_PLACE_STOP}<`)).toBeGreaterThanOrEqual(3);
    expect(ready).toContain('Mark order submitted');
    for (const label of ['ENTRY NOT TRIGGERED', 'READY — NOT TRIGGERED']) expect(html + d + ready).not.toContain(label);
  });
  it('22b · when no entry state applies the existing decision is shown (SKIP)', () => {
    const [s] = session([WEAK()], [{ now: at(1), price: 100.95 }]);
    const d = details(s.row, at(1));
    expect(d).toContain('— (decision: SKIP)');
    expect(d).not.toContain(READY_PLACE_STOP);
  });
  it('23 · the latch survives a browser refresh (JSON round trip of the persisted maps)', () => {
    const s = session([LONG()], [{ now: at(1), price: 100.95 }, { now: at(2), price: 101.4 }]);
    const reloaded: State = JSON.parse(JSON.stringify(s[1].state));
    const [r] = session([LONG()], [{ now: at(3), price: 100.95 }], { start: reloaded });
    expect(entryState(r.row)!.label).toBe(MISSED_DO_NOT_CHASE);
    expect(ticketActionable(r.row)).toBe(false);
  });
  it('23b · rollback compatibility: the chase is stored under its own key, the record-id key (read by older builds) is untouched', () => {
    const s = session([LONG()], [{ now: at(1), price: 100.95 }, { now: at(2), price: 101.4 }]);
    const id = s[1].row.record.id;
    expect(Object.keys(s[1].state.terminal)).toEqual([chaseKey(id)]);
    expect(s[1].state.terminal[id]).toBeUndefined();
  });
  it('24 · no data-review bypass: an alert under DATA REVIEW never latches and never shows an entry state', () => {
    const rec = LONG({ issues: [{ kind: 'REVIEW', code: 'PRICE_MISMATCH', message: 'test' }] });
    const s = session([rec], [{ now: at(1), price: 100.95 }, { now: at(2), price: 101.4 }, { now: at(3), price: 100.95 }]);
    for (const x of s) {
      expect(entryState(x.row)).toBeNull();
      expect(ticketActionable(x.row)).toBe(false);
      expect(x.state.terminal[chaseKey(rec.id)]).toBeUndefined();
    }
  });
  it('observedChase refuses rows without a fresh quote', () => {
    const [s] = session([LONG()], [{ now: at(2), price: 101.4 }]);
    expect(observedChase({ ...s.row, quote: null }, at(2), DEFAULT_AUTOMATION)).toBeNull();
  });
});
