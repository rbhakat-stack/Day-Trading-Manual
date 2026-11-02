/** 15:30 cutoff — the operator cannot mistake a legacy RB v1.1 ticket for an order to place. Render test (SSR). */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUTOMATION, type LiveQuote } from '../../../engine/automation/alertDecision';
import { recordWith } from '../../../engine/automation/__tests__/fixtures';
import { buildQueue } from '../../../engine/automation/liveQueue';
import { cloneRankerDefaults } from '../../../engine/ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../../engine/settings';
import { LiveQueuePage } from '../LiveQueuePage';
import type { Candidate } from '../../../engine/ranker/opportunityTypes';
import { decisionBadge, finalBadge } from '../queueView';

const rec = recordWith({ symbol: 'XYZ', direction: 'LONG', alertIso: '2026-10-30T15:29:04-04:00', price: 100.95, values: {} });
const run = (now: number, candidates: Candidate[] = []) => {
  const q: LiveQuote = { price: 100.95, tradeIso: new Date(now - 1000).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 };
  return buildQueue({ records: [rec], candidates, positions: [], quotes: { XYZ: q }, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify: () => ({ sector: 'S', industry: 'I', theme: '' }), parity: {}, strategyVersion: 'RB v1.1' });
};
const page = (now: number) => {
  const out = run(now, run(Date.parse('2026-10-30T15:29:40-04:00')).candidates); // the candidate created at 15:29:40
  const actions = { submit: vi.fn(), skip: vi.fn(), watch: vi.fn(), openInCalculator: vi.fn(), classify: vi.fn(), reprocess: vi.fn(), keep: vi.fn(), replace: vi.fn() };
  const html = renderToStaticMarkup(createElement(LiveQueuePage, {
    rows: out.rows, suggestions: [], now, enabled: true, feed: { lastOkMs: now, error: null }, quoteError: null, parityStatus: 'VALIDATED', versionLabel: 'RB v1.1', actions, onOpenSettings: () => {},
    shadow: { maxScore: 91, optionAGrades: cloneRankerDefaults().grades, logCount: 0, onExportLog: () => {} },
  }));
  return { row: out.rows[0], html };
};

describe('15:30 entry cutoff UI (alert 15:29, viewed 15:31)', () => {
  const { row, html } = page(Date.parse('2026-10-30T15:31:00-04:00'));
  it('v1.1 output unchanged (it withdraws the ticket itself); historical ticket values kept; badges say not actionable', () => {
    expect(row.decision).toMatchObject({ detail: 'NOT ELIGIBLE — NEW ENTRY WINDOW CLOSED', ticket: null });
    expect(row.candidate).toMatchObject({ entry: 101.02, shares: 197 });
    expect(finalBadge(row)).toMatchObject({ label: 'NO TICKET — ENTRY WINDOW CLOSED', tone: 'bad' });
    expect(decisionBadge(row).label).not.toBe('TRADE READY');
  });
  it('prominent DO NOT EXECUTE warning; no copy / submit controls for the historical ticket', () => {
    expect(html).toContain('DO NOT EXECUTE — AFTER 3:30 PM ENTRY CUTOFF');
    expect(html).toContain('NO TICKET — ENTRY WINDOW CLOSED');
    expect(html).not.toContain('Copy TrendSpider order');
    expect(html).not.toContain('Mark order submitted');
    expect(html).not.toContain('>READY<');
    expect(html).toContain('historical BUY STOP 197 @ 101.02');
  });
  it('before 15:30 the same ticket is actionable as before', () => {
    const before = page(Date.parse('2026-10-30T15:29:40-04:00')).html;
    expect(before).toContain('Copy TrendSpider order');
    expect(before).not.toContain('DO NOT EXECUTE — AFTER 3:30 PM ENTRY CUTOFF');
  });
});
