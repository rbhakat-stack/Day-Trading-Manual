/**
 * Live Alert Queue presentation (UI only). Rows come from the real queue engine (buildQueue) over the shared test
 * fixtures; every assertion checks that the presentation shows the value the engine produced — nothing is recomputed.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../../../engine/automation/alertDecision';
import { recordWith } from '../../../engine/automation/__tests__/fixtures';
import { buildQueue, type QueueRow } from '../../../engine/automation/liveQueue';
import { receiptAudit, withReconstruction, type AutoAlertRecordV12 } from '../../../engine/automation/v12/audit';
import { ACTIVE_LOGIC_VERSION } from '../../../engine/automation/v12/dispatch';
import type { RuleSetEntry } from '../../../engine/automation/v12/ruleSets';
import { v12MaxScore } from '../../../engine/automation/v12/v12Thresholds';
import type { ManualPosition } from '../../../engine/ranker/opportunityTypes';
import { cloneRankerDefaults } from '../../../engine/ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../../engine/settings';
import { LiveQueuePage, type LiveActions } from '../LiveQueuePage';
import { QueueDetails } from '../QueueParts';
import { chaseStatus, dataStatus, decisionBadge, finalBadge, finalState, isDataReview, portfolioStatus, portfolioSummary, presentationFor, qualificationStatus, queueLayout, ruleSetText, scoreTone } from '../queueView';

const ALERT = '2026-10-30T10:15:04-04:00';
const T0 = Date.parse(ALERT);
const NOW = T0 + 60_000;
const RK = cloneRankerDefaults();
const CTX = { v12MaxScore: v12MaxScore(RK) };
const TEST_REG: RuleSetEntry[] = [
  { id: 'RBTS-L-TEST', direction: 'LONG', rulesVersion: 'RB v1.2', audited: 'TEST', checklistRef: 'TEST', active: true, rules: ['TEST'] },
  { id: 'RBTS-S-TEST', direction: 'SHORT', rulesVersion: 'RB v1.2', audited: 'TEST', checklistRef: 'TEST', active: true, rules: ['TEST'] },
];
const quote = (price: number): LiveQuote => ({ price, tradeIso: new Date(NOW - 1000).toISOString(), fetchedIso: new Date(NOW - 500).toISOString(), receivedMs: NOW - 500 });

/** Adds the v1.2 receipt audit + reconstruction. The fixture's snapshot gets the mapped 10:10–10:15 signal candle (as the
 *  server snapshot would carry), so v1.2 does not flag SIGNAL_CANDLE_MISMATCH. */
function withV12(r: AutoAlertRecord, ruleSet: string | null = 'RBTS-L-TEST'): AutoAlertRecordV12 {
  const end = Date.parse('2026-10-30T10:15:00-04:00');
  if (r.snapshot) r.snapshot.signal = { startIso: new Date(end - 300_000).toISOString(), endIso: new Date(end).toISOString(), label: '10:10–10:15' };
  const a = receiptAudit({ body: ruleSet ? { rule_set: ruleSet } : {}, symbol: r.alert.symbol, direction: r.alert.direction, receivedMs: r.receivedMs, v11Key: r.dedupeKey, registry: TEST_REG });
  return { ...r, v12: withReconstruction(a, r, [], r.alert.direction, DEFAULT_AUTOMATION.parity, null) };
}
const strong = (symbol: string, extra: Partial<Parameters<typeof recordWith>[0]> = {}) => recordWith({ symbol, direction: 'LONG', alertIso: ALERT, price: 100.95, values: {}, ...extra });

function run(records: AutoAlertRecord[], o: { prices?: Record<string, number>; positions?: ManualPosition[] } = {}) {
  const quotes = Object.fromEntries(records.map((r) => [r.alert.symbol, quote(o.prices?.[r.alert.symbol] ?? r.initialQuote!.price)]));
  let out = buildQueue({ records, candidates: [], positions: o.positions ?? [], quotes, now: NOW, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: RK, classify: (s) => ({ sector: `S-${s}`, industry: `I-${s}`, theme: '' }), parity: {}, strategyVersion: 'RB v1.1' });
  out = buildQueue({ records, candidates: out.candidates, positions: o.positions ?? [], quotes, now: NOW, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: RK, classify: (s) => ({ sector: `S-${s}`, industry: `I-${s}`, theme: '' }), parity: {}, strategyVersion: 'RB v1.1' });
  return out;
}
const row = (rows: QueueRow[], sym: string) => rows.find((r) => r.record.alert.symbol === sym)!;

const clean = withV12(strong('AAA'));
const chased = withV12(strong('CCC'));
const review = withV12(strong('DDD', { issues: [{ kind: 'REVIEW', code: 'MISSING_BARS', message: 'More than 5% of 5m bars are missing.' }] }));
const errored: AutoAlertRecord = { ...strong('EEE'), status: 'DATA_ERROR', errors: ['Alpaca 500: upstream error'], snapshot: null };
const unqualified = withV12(strong('FFF'), null);
const main = run([clean, chased, review, errored, unqualified], { prices: { CCC: 101.6 } });
const held: ManualPosition[] = [1, 2, 3, 4].map((i) => ({ id: `p${i}`, ticker: `H${i}`, direction: 'LONG', sector: `HS${i}`, industry: `HI${i}`, theme: '', positionValue: 5000, plannedRisk: 250, entry: 10, stop: 9, target: 12, status: 'OPEN' }));
const blocked = run([withV12(strong('BBB'))], { positions: held });

describe('strategy layout is metadata-driven (today: RB v1.1 ACTIVE, RB v1.2 SHADOW)', () => {
  it('ACTIVE_LOGIC_VERSION is unchanged and drives the default layout', () => {
    expect(ACTIVE_LOGIC_VERSION).toBe('RB v1.1');
    const l = queueLayout(presentationFor(ACTIVE_LOGIC_VERSION), CTX);
    expect(l.map((c) => [c.version, c.role, c.title])).toEqual([['RB v1.1', 'ACTIVE', 'RB v1.1 (ACTIVE)'], ['RB v1.2', 'SHADOW', 'RB v1.2 (SHADOW)']]);
    expect(l[1].scoreLabel).toBe(`Score (${CTX.v12MaxScore})`);
    expect(l[1].tierLabels).toEqual(['Option B', 'Option A']);
  });
  it('future modes need only metadata: v1.2 ACTIVE + v1.1 COMPARISON, then v1.2 alone', () => {
    expect(queueLayout(presentationFor('RB v1.2'), CTX).map((c) => `${c.version}:${c.role}`)).toEqual(['RB v1.2:ACTIVE', 'RB v1.1:COMPARISON']);
    expect(queueLayout({ activeVersion: 'RB v1.2', hidden: ['RB v1.1'] }, CTX).map((c) => `${c.version}:${c.role}`)).toEqual(['RB v1.2:ACTIVE']);
  });
});

describe('cells show the engine output unchanged', () => {
  const [v11, v12] = queueLayout(presentationFor('RB v1.1'), CTX);
  it('RB v1.1: ranker total and tier, and the active decision', () => {
    for (const r of main.rows) expect(v11.cell(r)).toEqual({ score: r.ranked?.total ?? null, tiers: [r.ranked?.tier ?? null], decision: r.decision.decision });
    expect(v11.cell(row(main.rows, 'AAA')).score).toBeGreaterThan(0);
  });
  it('RB v1.2 SHADOW: raw score, Option B tier, Option A tier — and no decision (shadow is not executable)', () => {
    for (const r of main.rows) expect(v12.cell(r)).toEqual({ score: r.shadow?.score?.total ?? null, tiers: [r.shadow?.score?.tierOptionB ?? null, r.shadow?.score?.tierOptionA ?? null], decision: null });
    expect(v12.cell(row(main.rows, 'AAA')).score).not.toBeNull();
  });
  it('TS Qualified and rule set come from the v1.2 audit', () => {
    expect(qualificationStatus(row(main.rows, 'AAA'))).toMatchObject({ label: 'QUALIFIED', tone: 'ok' });
    expect(ruleSetText(row(main.rows, 'AAA'))).toEqual({ id: 'RBTS-L-TEST', status: 'RECOGNISED' });
    expect(qualificationStatus(row(main.rows, 'FFF')).label).toBe('NOT QUALIFIED');
    expect(ruleSetText(row(main.rows, 'FFF'))).toEqual({ id: 'none', status: 'MISSING' });
    expect(qualificationStatus(row(main.rows, 'EEE')).label).toBe('—');
  });
});

describe('safety / execution badges name existing states', () => {
  it('chase: PASS when the trigger is not crossed; CHASED when the calculator says so', () => {
    expect(chaseStatus(row(main.rows, 'AAA')).label).toBe('PASS');
    const c = row(main.rows, 'CCC');
    expect(c.live?.action).toBe('SKIP_CHASED');
    expect(chaseStatus(c)).toMatchObject({ label: 'CHASED', tone: 'bad' });
  });
  it('data: PASS, REVIEW (snapshot issue) and DATA ERROR are never collapsed', () => {
    expect(dataStatus(row(main.rows, 'AAA'))).toMatchObject({ label: 'PASS', tone: 'ok' });
    expect(dataStatus(row(main.rows, 'DDD'))).toMatchObject({ label: 'REVIEW', tone: 'warn', detail: 'MISSING_BARS' });
    expect(dataStatus(row(main.rows, 'EEE'))).toMatchObject({ label: 'DATA ERROR', tone: 'bad' });
  });
  it('portfolio: OK when allocated, BLOCKED with the allocator hard fails, N/A when held for data review', () => {
    expect(portfolioStatus(row(main.rows, 'AAA')).label).toBe('OK');
    const b = blocked.rows[0];
    expect(portfolioStatus(b)).toMatchObject({ label: 'BLOCKED', tone: 'bad' });
    expect(portfolioStatus(b).detail).toContain('NO_POSITION_SLOT');
    expect(portfolioStatus(row(main.rows, 'DDD')).label).toBe('N/A');
  });
  it('final state is the active decision and its ticket', () => {
    for (const r of [...main.rows, ...blocked.rows]) expect(finalState(r)).toMatchObject({ label: r.decision.decision, detail: r.decision.detail, ticket: !!r.decision.ticket });
    expect(finalState(row(main.rows, 'AAA')).ticket).toBe(true);
    expect(finalState(row(main.rows, 'CCC')).ticket).toBe(false);
    expect(finalState(blocked.rows[0]).ticket).toBe(false);
  });
  it('portfolio header reads the allocator snapshot', () => {
    const s = portfolioSummary(blocked.rows)!;
    expect(s.pf).toBe(blocked.rows[0].ranked!.portfolio);
    expect([s.pf.slotsUsed, s.pf.maxPositions, s.consistent]).toEqual([4, 4, true]);
    expect(portfolioSummary([])).toBeNull();
  });
});

const noop = () => {};
const actions: LiveActions = { submit: noop, skip: noop, watch: noop, openInCalculator: noop, classify: noop, reprocess: noop, keep: noop, replace: noop };
const page = (rows: QueueRow[], presentation?: Parameters<typeof LiveQueuePage>[0]['presentation']) =>
  renderToStaticMarkup(createElement(LiveQueuePage, {
    rows, suggestions: [], now: NOW, enabled: true, feed: { lastOkMs: NOW, error: null }, quoteError: null, parityStatus: 'NOT VALIDATED', versionLabel: 'RB v1.1', actions, onOpenSettings: noop,
    shadow: { maxScore: CTX.v12MaxScore, optionAGrades: RK.grades, logCount: 0, onExportLog: noop }, presentation,
  }));

describe('compact badges map existing states only', () => {
  it('Decision: TRADE READY only with an active ticket; CHASED only when the calculator chased; DATA REVIEW from the decision', () => {
    for (const r of [...main.rows, ...blocked.rows]) {
      const b = decisionBadge(r);
      if (r.decision.ticket) expect(b.label).toBe('TRADE READY');
      else expect(b.label).not.toBe('TRADE READY');
    }
    expect(decisionBadge(row(main.rows, 'CCC'))).toMatchObject({ label: 'CHASED', tone: 'bad' });
    expect(decisionBadge(row(main.rows, 'DDD'))).toMatchObject({ label: 'DATA REVIEW', tone: 'warn' });
  });
  it('Final State: READY with a ticket, NO TRADE for NOT ELIGIBLE, otherwise NO TICKET', () => {
    expect(finalBadge(row(main.rows, 'AAA')).label).toBe('READY');
    expect(finalBadge(row(main.rows, 'CCC')).label).toBe('NO TRADE');
    expect(finalBadge(row(main.rows, 'DDD')).label).toBe('NO TICKET');
    expect(finalBadge(blocked.rows[0]).label).toBe(blocked.rows[0].decision.ticket ? 'READY' : blocked.rows[0].decision.decision === 'NOT ELIGIBLE' ? 'NO TRADE' : 'NO TICKET');
  });
  it('Data Review filter = any non-PASS data state', () => {
    expect(main.rows.filter(isDataReview).map((r) => r.record.alert.symbol).sort()).toEqual(['DDD', 'EEE']);
  });
  it('score colour follows the tier the ranker assigned', () => {
    expect([scoreTone('ELITE'), scoreTone('HIGH_PRIORITY'), scoreTone('WATCHLIST'), scoreTone('LOW_PRIORITY'), scoreTone('SKIP')]).toEqual(['elite', 'ok', 'warn', 'bad', 'bad']);
  });
});

describe('rendered queue', () => {
  const html = page(main.rows);
  it('header, grouped strategy columns and the active/shadow roles', () => {
    for (const s of ['Live Alert Queue', 'Automated alerts on', 'RB v1.1 (ACTIVE) &amp; RB v1.2 (SHADOW)', 'RB v1.1 (ACTIVE)', 'RB v1.2 (SHADOW)', 'TS Qualified', `Score (${CTX.v12MaxScore})`, 'Option B', 'Option A', 'Decision', 'Final State', 'Cur Price', '$ Risk']) expect(html).toContain(s);
    expect(html.indexOf('RB v1.1 (ACTIVE)')).toBeLessThan(html.indexOf('RB v1.2 (SHADOW)'));
    expect(html).toContain('comparison only, not used for execution');
  });
  it('filter chips with counts', () => {
    for (const s of ['All (5)', 'LONG (5)', 'SHORT (0)', 'Data Review (2)']) expect(html).toContain(s);
  });
  it('status badges render as text (not colour alone)', () => {
    for (const s of ['YES', 'NO', 'CHASED', 'REVIEW', 'DATA ERROR', 'TRADE READY', 'READY', 'NO TICKET', 'NO TRADE', 'PASS', 'OK', 'ELITE', 'WATCHLIST']) expect(html).toContain(`>${s}<`);
  });
  it('execution controls exist only for active tickets', () => {
    const tickets = main.rows.filter((r) => r.decision.ticket).length;
    expect(tickets).toBeGreaterThan(0);
    expect(html.split('Mark order submitted').length - 1).toBe(tickets);
  });
  it('portfolio card renders the allocator values', () => {
    const b = page(blocked.rows);
    expect(b).toContain('Paper ($100,000)');
    expect(b).toMatch(/>4 \/ 4</);
    expect(b).toMatch(/>\$1,000\.00 \/ \$1,000</);
  });
  it('legend shows the configured grades and the calculator chase limit', () => {
    expect(html).toContain(`≥ ${RK.grades.elite}`);
    expect(html).toContain(`${RK.grades.high}–${RK.grades.elite - 1}`);
    expect(html).toContain(`(${RB_V1_DEFAULTS.chaseThresholdAtr} × ATR)`);
  });
  it('future layout preview: v1.2 first as ACTIVE, v1.1 COMPARISON; v1.1 can be hidden entirely', () => {
    const a = page(main.rows, { activeVersion: 'RB v1.2', versions: ['RB v1.1'] });
    expect(a.indexOf('RB v1.2 (ACTIVE)')).toBeGreaterThan(-1);
    expect(a.indexOf('RB v1.2 (ACTIVE)')).toBeLessThan(a.indexOf('RB v1.1 (COMPARISON)'));
    const only = page(main.rows, { activeVersion: 'RB v1.2', hidden: ['RB v1.1'] });
    expect(only).not.toContain('RB v1.1 (');
  });
});

describe('expanded details', () => {
  const props = { now: NOW, actions, layout: queueLayout(presentationFor('RB v1.1'), CTX), maxScore: CTX.v12MaxScore, optionAGrades: RK.grades };
  it('summary bar plus four panels with mapping, construction, diagnostics and portfolio values', () => {
    const r = row(main.rows, 'CCC');
    const html = renderToStaticMarkup(createElement(QueueDetails, { r, ...props }));
    for (const s of ['Alert &amp; Mapping', 'Trade Construction', 'Data &amp; Diagnostics', 'Portfolio &amp; Execution', 'Mapped candle (v1.2)', 'Receipt lag', 'Allowed chase distance', 'SIP RVOL (diagnostic)', 'RB v1.1 hard fails', 'Parity warnings', 'Portfolio slots', 'Portfolio heat', 'Final execution state']) expect(html).toContain(s);
    expect(html).toContain(`${r.live!.chase!.thresholdAtr} ATR`);
    expect(html).toContain('CHASED_SETUP');
    expect(html).toContain('Why CHASED?');
    expect(html).not.toContain('Mark order submitted');
  });
});
