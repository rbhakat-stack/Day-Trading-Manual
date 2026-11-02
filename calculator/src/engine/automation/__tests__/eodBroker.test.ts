/** CR-13 — EOD flatness includes read-only broker facts (positions RB never ticketed), and works with an empty queue. */
import { describe, expect, it } from 'vitest';
import { etToEpoch } from '../etTime';
import { eodStatus, withBrokerFacts } from '../lifecycle/executionState';
import { brokerEodFacts } from '../lifecycle/brokerSync';

const D = '2026-11-02';
const feed = {
  orders: [
    { id: 'a', symbol: 'FIS', side: 'buy', type: 'stop', status: 'filled', qty: '499', filled_qty: '499', legs: [] },
    { id: 'b', symbol: 'GM', side: 'buy', type: 'stop', status: 'accepted', qty: '100', filled_qty: '0', legs: [] },
  ],
  positions: [{ symbol: 'FIS', qty: '499' }],
};

describe('CR-13 EOD with broker facts', () => {
  it('broker facts: FIS open, GM unfilled', () => {
    expect(brokerEodFacts(feed)).toEqual({ openTickers: ['FIS'], pendingTickers: ['GM'] });
  });
  it('an RB-flat portfolio with a broker position is NOT flat after the close', () => {
    const now = etToEpoch(D, '16:45');
    expect(eodStatus(now, [], []).phase).toBe('CLOSED');
    expect(withBrokerFacts(eodStatus(now, [], []), now, brokerEodFacts(feed))).toMatchObject({ phase: 'NOT FLAT AFTER CLOSE', actionRequired: true, openTickers: ['FIS'], pendingTickers: ['GM'] });
  });
  it('15:50 broker pending order → EOD CANCEL REQUIRED; 15:58 open position → FLAT REQUIRED', () => {
    const f = { orders: feed.orders, positions: [] };
    expect(withBrokerFacts(eodStatus(etToEpoch(D, '15:50'), [], []), etToEpoch(D, '15:50'), brokerEodFacts(f)).phase).toBe('EOD CANCEL REQUIRED');
    expect(withBrokerFacts(eodStatus(etToEpoch(D, '15:58'), [], []), etToEpoch(D, '15:58'), brokerEodFacts(feed)).phase).toBe('FLAT REQUIRED');
  });
});
