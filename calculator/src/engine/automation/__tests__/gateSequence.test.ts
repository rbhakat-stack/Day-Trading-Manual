/**
 * CR-10 gate sequencing when a full portfolio also lowers the score. Portfolio hard rules are evaluated by RB v1.1
 * regardless of the score, so a real block is reported as BLOCKED (never hidden behind NOT EVALUATED); NOT EVALUATED is
 * only for a score failure with no portfolio rule failing.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue } from '../liveQueue';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import type { ManualPosition } from '../../ranker/opportunityTypes';
import { RB_V1_DEFAULTS } from '../../settings';
import { recordWith } from './fixtures';
import { portfolioStatus } from '../../../components/live/queueView';

const ALERT = '2026-10-30T10:15:04-04:00';
const NOW = Date.parse(ALERT) + 60_000;
const q = (price: number): LiveQuote => ({ price, tradeIso: new Date(NOW - 1000).toISOString(), fetchedIso: new Date(NOW - 500).toISOString(), receivedMs: NOW - 500 });
const run = (rec: AutoAlertRecord, positions: ManualPosition[] = []) =>
  buildQueue({ records: [rec], candidates: [], positions, quotes: { [rec.alert.symbol]: q(100.95) }, now: NOW, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify: (s) => ({ sector: `S-${s}`, industry: `I-${s}`, theme: '' }), parity: {}, strategyVersion: 'RB v1.1' }).rows[0];
const held: ManualPosition[] = [1, 2, 3, 4].map((i) => ({ id: `p${i}`, ticker: `H${i}`, direction: 'LONG', sector: `HS${i}`, industry: `HI${i}`, theme: '', positionValue: 5000, plannedRisk: 250, entry: 10, stop: 9, target: 12, status: 'OPEN' }));

describe('CR-10 gate sequencing with a full portfolio', () => {
  it('score below 85 because the portfolio is full → Score FAIL, Portfolio BLOCKED — NO_POSITION_SLOT, Capital NOT ATTEMPTED', () => {
    const r = run(recordWith({ symbol: 'BBB', direction: 'LONG', alertIso: ALERT, price: 100.95, values: {} }), held);
    expect(r.lifecycle.gates).toEqual({ score: 'FAIL', portfolio: 'BLOCKED — NO_POSITION_SLOT', capital: 'NOT ATTEMPTED' });
    expect(portfolioStatus(r)).toMatchObject({ label: 'BLOCKED' });
  });
  it('weak setup, empty portfolio → Portfolio NOT EVALUATED in both the gate row and the Portfolio column', () => {
    const r = run(recordWith({ symbol: 'FIS', direction: 'LONG', alertIso: ALERT, price: 100.95, values: { rvol: 1.5, rsi: 56, ema9: 100.15, ema20: 100.1 } }));
    expect(r.lifecycle.gates).toEqual({ score: 'FAIL', portfolio: 'NOT EVALUATED — NOT REQUIRED', capital: 'NOT ATTEMPTED' });
    expect(portfolioStatus(r)).toMatchObject({ label: 'NOT EVALUATED' });
  });
});
