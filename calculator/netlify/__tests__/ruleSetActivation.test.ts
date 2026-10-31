import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../../src/engine/automation/alertDecision';
import { daysUpTo, sessionBars } from '../../src/engine/automation/__tests__/fixtures';
import { etToEpoch } from '../../src/engine/automation/etTime';
import { buildQueue } from '../../src/engine/automation/liveQueue';
import type { AutoAlertRecordV12 } from '../../src/engine/automation/v12/audit';
import { cloneRankerDefaults } from '../../src/engine/ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../src/engine/settings';
import type { MarketDataClient } from '../lib/alpaca';
import { processAlert, type ProcessDeps } from '../lib/processAlert';
import { MemoryStore } from '../lib/store';

/**
 * CR-012 — the audited RBTS-L-001 / RBTS-S-001 webhooks, using the exact production payload shape with SYNTHETIC
 * tokens (never a real secret). Registration may only change the v1.2 SHADOW qualification.
 */
const D = '2026-10-30';
const OLD_TOKEN = 'synthetic-old-token-for-tests-only';
const NEW_TOKEN = 'synthetic-new-token-for-tests-only';
const BARS_UP = sessionBars(daysUpTo(D), { untilEt: '10:20' });
const BARS_DOWN = sessionBars(daysUpTo(D), { untilEt: '10:20', price: (i) => 200 - 0.015 * i - (i % 2 ? 0.045 : 0) });

const LONG_PAYLOAD = { strategy: 'RB_V1', symbol: 'GM', direction: 'LONG', alert_name: 'RB v1 LONG Setup', rule_set: 'RBTS-L-001', token: NEW_TOKEN };
const SHORT_PAYLOAD = { strategy: 'RB_V1', symbol: 'F', direction: 'SHORT', alert_name: 'RB v1 SHORT Setup', rule_set: 'RBTS-S-001', token: NEW_TOKEN };
const without = (p: Record<string, unknown>, k: string) => Object.fromEntries(Object.entries(p).filter(([x]) => x !== k));

function fakeData(bars = BARS_UP): MarketDataClient {
  return {
    name: 'Alpaca', feed: 'sip', host: 'data.alpaca.markets',
    async getBars5() { return bars; },
    async getLatestTrades(symbols) {
      return Object.fromEntries(symbols.map((s) => [s, { price: bars[bars.length - 2].c, tradeIso: new Date(etToEpoch(D, '10:15:05')).toISOString(), fetchedIso: new Date(etToEpoch(D, '10:15:06')).toISOString() }]));
    },
  };
}
const deps = (bars = BARS_UP) => {
  const logs: [string, Record<string, unknown>][] = [];
  const d: ProcessDeps & { logs: typeof logs } = { store: new MemoryStore(), data: fakeData(bars), log: (e, f = {}) => void logs.push([e, f]), now: () => etToEpoch(D, '10:15:12'), sleep: async () => {}, logs };
  return d;
};
async function stored(body: unknown, d = deps()) {
  const out = await processAlert(body, d);
  if (out.kind !== 'STORED') throw new Error(`expected STORED, got ${out.kind}`);
  return { rec: out.record as AutoAlertRecordV12, d };
}
function queue(records: AutoAlertRecord[]) {
  const now = etToEpoch(D, '10:15:45');
  const quotes: Record<string, LiveQuote> = Object.fromEntries(records.map((r) => [r.alert.symbol, { price: r.initialQuote!.price, tradeIso: new Date(now - 1000).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 }]));
  return buildQueue({ records, candidates: [], positions: [], quotes, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify: (s) => ({ sector: s, industry: s, theme: '' }), parity: {}, strategyVersion: 'RB v1.1' });
}

describe('audited rule sets through the real webhook processing (synthetic tokens)', () => {
  it('(1) LONG payload with RBTS-L-001 → v1.2 shadow TS QUALIFIED, LONG, mapped; v1.1 stays active', async () => {
    const { rec } = await stored(LONG_PAYLOAD);
    expect(rec.versions.strategy).toBe('RB v1.1');
    expect(rec.v12!.qualification).toMatchObject({ status: 'QUALIFIED', ruleSet: { status: 'RECOGNISED', ruleSet: 'RBTS-L-001' } });
    expect(rec.v12!.qualification.ruleSet.entry?.direction).toBe('LONG');
    expect(rec.v12!.signalMapping).toMatchObject({ status: 'ON_TIME', label: '10:10–10:15' });
    const row = queue([rec]).rows[0];
    expect(row.shadow?.qualified).toBe(true);
    expect(row.shadow?.mode).toBe('SHADOW');
  });
  it('(2) SHORT payload with RBTS-S-001 → TS QUALIFIED, SHORT', async () => {
    const { rec } = await stored(SHORT_PAYLOAD, deps(BARS_DOWN));
    expect(rec.alert.direction).toBe('SHORT');
    expect(rec.v12!.qualification).toMatchObject({ status: 'QUALIFIED', ruleSet: { status: 'RECOGNISED', ruleSet: 'RBTS-S-001' } });
  });
  it('(3)/(4) swapped rule sets are direction CONFLICTs → NOT QUALIFIED', async () => {
    const a = (await stored({ ...SHORT_PAYLOAD, rule_set: 'RBTS-L-001' }, deps(BARS_DOWN))).rec;
    const b = (await stored({ ...LONG_PAYLOAD, rule_set: 'RBTS-S-001' })).rec;
    for (const r of [a, b]) {
      expect(r.v12!.qualification.status).toBe('NOT_QUALIFIED');
      expect(r.v12!.qualification.ruleSet.status).toBe('CONFLICT');
      expect(queue([r]).rows[0].shadow).toMatchObject({ decision: 'NOT QUALIFIED', score: null });
    }
  });
  it('(5)/(6) missing or unknown rule set fails closed', async () => {
    const missing = (await stored(without(LONG_PAYLOAD, 'rule_set'))).rec;
    const unknown = (await stored({ ...LONG_PAYLOAD, rule_set: 'RBTS-L-002' })).rec;
    expect(missing.v12!.qualification.ruleSet.status).toBe('MISSING');
    expect(unknown.v12!.qualification.ruleSet.status).toBe('UNKNOWN');
    for (const r of [missing, unknown]) expect(queue([r]).rows[0].shadow).toMatchObject({ decision: 'NOT QUALIFIED', qualified: false });
  });
  it('(7) a test webhook with an audited rule set is never stored, so never qualifies', async () => {
    const d = deps();
    const out = await processAlert({ ...LONG_PAYLOAD, test: true }, d);
    expect(out.kind).toBe('TEST_OK');
    expect(d.logs.map((l) => l[0])).not.toContain('v12_shadow_audit');
  });
  it('(8) v1.1 record, decision, ranking, ticket and candidates are identical with and without rule_set (LONG and SHORT)', async () => {
    for (const [payload, bars] of [[LONG_PAYLOAD, BARS_UP], [SHORT_PAYLOAD, BARS_DOWN]] as const) {
      const a = (await stored(payload, deps(bars))).rec;
      const b = (await stored(without(payload, 'rule_set'), deps(bars))).rec;
      const strip = (x: AutoAlertRecordV12) => ({ ...x, v12: undefined, payload: undefined });
      expect(strip(a)).toEqual(strip(b));
      expect(a.calcAtAlert).toEqual(b.calcAtAlert);
      const qa = queue([a]);
      const qb = queue([b]);
      expect(qa.rows[0].decision).toEqual(qb.rows[0].decision);
      expect(qa.rows[0].ranked).toEqual(qb.rows[0].ranked);
      expect(qa.rows[0].live).toEqual(qb.rows[0].live);
      expect(qa.candidates).toEqual(qb.candidates);
      expect(qa.suggestions).toEqual(qb.suggestions);
    }
  });
  it('the token never reaches the stored record or the logs', async () => {
    const { rec, d } = await stored(LONG_PAYLOAD);
    expect(JSON.stringify(rec)).not.toContain(NEW_TOKEN);
    expect(JSON.stringify(d.logs)).not.toContain(NEW_TOKEN);
  });
});

describe('webhook endpoint with synthetic secrets (rotation behaviour)', () => {
  const store = new MemoryStore();
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('TRENDSPIDER_WEBHOOK_SECRET', NEW_TOKEN);
    vi.stubEnv('ALPACA_API_KEY', 'AKTEST');
    vi.stubEnv('ALPACA_SECRET_KEY', 'SKTEST');
    vi.doMock('../lib/store', async (orig) => ({ ...(await orig<typeof import('../lib/store')>()), blobStore: async () => store }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('../lib/store');
  });
  const call = async (body: unknown) => (await import('../functions/trendspider-alert.mts')).default(new Request('https://site/.netlify/functions/trendspider-alert', { method: 'POST', body: JSON.stringify(body) }));
  it('the revised LONG and SHORT payloads are accepted with the current secret (test mode, nothing stored)', async () => {
    for (const p of [LONG_PAYLOAD, SHORT_PAYLOAD]) {
      const res = await call({ ...p, test: true, alert_time: new Date().toISOString() });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, test: true, parsed: { symbol: p.symbol, direction: p.direction } });
    }
  });
  it('after rotation the old secret is rejected (401) and never echoed', async () => {
    const res = await call({ ...LONG_PAYLOAD, token: OLD_TOKEN, test: true });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(OLD_TOKEN);
    expect(text).not.toContain(NEW_TOKEN);
  });
});
