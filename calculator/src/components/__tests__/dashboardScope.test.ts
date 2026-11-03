/** Dashboard scope bar and R availability (SSR render). Manual-override broker trades never mix into RB-strategy metrics. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Dashboard } from '../Dashboard';
import type { JournalEntry } from '../../engine/journal';

const base = { date: '2026-11-02', time: '14:00', direction: 'LONG', open: 0, high: 0, low: 0, close: 0, atr: 0, alertPrice: 0, decision: 'NOT_ELIGIBLE', orderType: 'BUY (broker)', plannedEntry: 0, stop: 0, target: 0, expectedReward: 0, notes: '' } as const;
const gm = { ...base, id: 'broker-gm', ticker: 'GM', actualFill: 89.49, quantity: 223, positionValue: 19956.27, expectedRisk: 0, outcome: 'STOP_HIT', exitPrice: 89.19, source: 'broker_sync', strategyDecision: 'NO ALERT', manualOverride: true, positionStatus: 'CLOSED' } as JournalEntry;
const rb = { ...base, id: 'm1', ticker: 'NVDA', plannedEntry: 100, actualFill: 100, stop: 99, target: 102, quantity: 10, positionValue: 1000, expectedRisk: 10, expectedReward: 20, outcome: 'TARGET_HIT', exitPrice: 102 } as JournalEntry;
const html = (entries: JournalEntry[]) => renderToStaticMarkup(createElement(Dashboard, { entries, failLabels: {} }));

describe('Dashboard scopes', () => {
  it('shows ALL / RB strategy / Manual overrides with counts and the browser-storage notice', () => {
    const h = html([rb, gm]);
    expect(h).toContain('All trades (2)');
    expect(h).toContain('RB strategy trades (1)');
    expect(h).toContain('Manual overrides (1)');
    expect(h).toContain('Journal data is stored only in this browser. Use Backup JSON regularly.');
  });
  it('R is shown as unavailable (never 0R) when no closed trade in the view has a planned risk', () => {
    const h = html([gm]);
    expect(h).toContain('— (no planned risk)');
    expect(h).not.toContain('0.00R');
    expect(html([rb])).toContain('+2.00R');
  });
  it('an empty journal still says so', () => {
    expect(html([])).toContain('No journal entries yet.');
  });
});
