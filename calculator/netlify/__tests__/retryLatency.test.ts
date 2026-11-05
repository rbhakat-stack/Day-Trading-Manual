/**
 * CR-01 — Decision Latency describes the ORIGINAL processing lifecycle. Retries record their own observability
 * (count, last processed time, duration) and never change signal close / first receipt / initial decision ready.
 * Runs the real webhook pipeline (processAlert → enrichRecord) with an in-memory store and synthetic data.
 */
import { describe, expect, it } from 'vitest';
import { daysUpTo, minuteBarsBetween, sessionBars } from '../../src/engine/automation/__tests__/fixtures';
import { etToEpoch } from '../../src/engine/automation/etTime';
import { alertLatency } from '../../src/engine/automation/lifecycle/latency';
import type { MarketDataClient } from '../lib/alpaca';
import { enrichRecord, processAlert, type ProcessDeps } from '../lib/processAlert';
import { MemoryStore } from '../lib/store';
import type { AutoAlertRecord } from '../../src/engine/automation/alertDecision';

const D = '2026-10-30';
const BARS = sessionBars(daysUpTo(D), { untilEt: '10:20' });
const ALERT = etToEpoch(D, '10:15:04');
const body = { strategy: 'RB_V1', symbol: 'GM', direction: 'LONG', alert_name: 'RB v1 LONG Setup', alert_time: new Date(ALERT).toISOString(), token: 'whsec' };

function data(failFirst: number, tick: () => void): MarketDataClient {
  let n = 0;
  return {
    name: 'Alpaca', feed: 'sip', host: 'data.alpaca.markets',
    async getBars1(_s, a, b) { return minuteBarsBetween(BARS, a, b); }, // Step 3 · A
    async getBars5() {
      tick(); // each market-data fetch takes 3 s of simulated time
      if (n++ < failFirst) throw new Error('Alpaca 503: temporarily unavailable');
      return BARS;
    },
    async getLatestTrades(symbols) {
      return Object.fromEntries(symbols.map((s) => [s, { price: 106, tradeIso: new Date(ALERT + 1000).toISOString(), fetchedIso: new Date(ALERT + 1500).toISOString() }]));
    },
  };
}

/** Webhook received at 10:15:06; first attempt ends at 10:15:09. Optionally retried `retryAfterMs` later. */
async function lifecycle(retryAfterMs: number | null) {
  let clock = etToEpoch(D, '10:15:06');
  const store = new MemoryStore();
  const deps: ProcessDeps = { store, data: data(retryAfterMs === null ? 0 : 1, () => { clock += 3000; }), log: () => {}, now: () => clock, sleep: async () => { clock += 3000; } };
  const first = await processAlert(body, { ...deps, now: () => clock });
  if (first.kind !== 'STORED') throw new Error(first.kind);
  let rec: AutoAlertRecord = first.record;
  const afterFirst = alertLatency(rec);
  if (retryAfterMs !== null) {
    expect(rec.status).toBe('DATA_ERROR');
    clock += retryAfterMs;
    rec = await enrichRecord(rec, { ...deps, settleMs: 0 });
    expect(rec.status).toBe('OK');
  }
  return { rec, afterFirst, latency: alertLatency(rec) };
}

describe('CR-01 retry latency semantics', () => {
  it('A — normal alert: webhook lag 6 s, RB processing 3 s, total 9 s; no retry facts', async () => {
    const { rec, latency } = await lifecycle(null);
    expect(rec.firstProcessedIso).toBe(rec.processedIso);
    expect(rec.retry).toBeUndefined();
    expect([latency.receiptLagSec, latency.processingSec, latency.totalSec, latency.retry]).toEqual([6, 3, 9, null]);
  });
  it('B — retried 5 minutes later: original latency unchanged; retry recorded separately', async () => {
    const a = await lifecycle(null);
    const { rec, afterFirst, latency } = await lifecycle(5 * 60_000);
    expect([latency.receiptLagSec, latency.processingSec, latency.totalSec]).toEqual([a.latency.receiptLagSec, a.latency.processingSec, a.latency.totalSec]);
    expect(latency.totalSec).toBe(afterFirst.totalSec);
    expect(rec.firstProcessedIso).not.toBe(rec.processedIso);
    expect(rec.retry).toMatchObject({ count: 1, lastProcessedIso: rec.processedIso });
    expect(latency.retry).toMatchObject({ count: 1 });
  });
  it('C — retried much later (45 min): original latency still identical', async () => {
    const a = await lifecycle(null);
    const { latency } = await lifecycle(45 * 60_000);
    expect([latency.receiptLagSec, latency.processingSec, latency.totalSec]).toEqual([a.latency.receiptLagSec, a.latency.processingSec, a.latency.totalSec]);
    expect(latency.totalSec).toBe(9);
  });
  it('older record retried without firstProcessedIso: original processing/total shown as unknown, never the retry time', () => {
    const legacy = { alert: { alertTimeMs: ALERT }, receivedMs: etToEpoch(D, '10:15:06'), attempts: 3, processedIso: new Date(etToEpoch(D, '11:00')).toISOString() } as AutoAlertRecord;
    const l = alertLatency(legacy);
    expect([l.receiptLagSec, l.processingSec, l.totalSec]).toEqual([6, null, null]);
    expect(l.retry).toMatchObject({ count: 2 });
  });
});
