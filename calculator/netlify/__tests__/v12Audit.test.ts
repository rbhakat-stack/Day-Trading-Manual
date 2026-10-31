import { describe, expect, it } from 'vitest';
import type { MarketDataClient } from '../lib/alpaca';
import { processAlert, type ProcessDeps } from '../lib/processAlert';
import { MemoryStore } from '../lib/store';
import { daysUpTo, sessionBars } from '../../src/engine/automation/__tests__/fixtures';
import { etToEpoch } from '../../src/engine/automation/etTime';
import type { Bar } from '../../src/engine/automation/indicators';
import type { AutoAlertRecordV12 } from '../../src/engine/automation/v12/audit';

/** RB v1.2 SHADOW audit written next to the unchanged v1.1 record (Phase 3B step 4). */
const D = '2026-10-30';
const BARS = sessionBars(daysUpTo(D), { untilEt: '10:20' });
// Real TrendSpider webhooks carry no alert_time: v1.1 uses the receipt time, v1.2 maps the receipt time.
const body = (o: Record<string, unknown> = {}) => ({ strategy: 'RB_V1', symbol: 'GM', direction: 'LONG', alert_name: 'RB v1 LONG Setup', token: 'whsec', ...o });

function fakeData(o: { bars?: Bar[]; fail?: string } = {}): MarketDataClient {
  return {
    name: 'Alpaca', feed: 'sip', host: 'data.alpaca.markets',
    async getBars5() {
      if (o.fail) throw new Error(o.fail);
      return o.bars ?? BARS;
    },
    async getLatestTrades(symbols) {
      if (o.fail) throw new Error(o.fail);
      return Object.fromEntries(symbols.map((s) => [s, { price: 106, tradeIso: new Date(etToEpoch(D, '10:15:05')).toISOString(), fetchedIso: new Date(etToEpoch(D, '10:15:06')).toISOString() }]));
    },
  };
}
const deps = (receivedEt: string, o: Partial<ProcessDeps> = {}) => {
  const logs: [string, Record<string, unknown>][] = [];
  const d: ProcessDeps & { logs: typeof logs } = { store: new MemoryStore(), data: fakeData(), log: (e, f = {}) => void logs.push([e, f]), now: () => etToEpoch(D, receivedEt), sleep: async () => {}, logs, ...o };
  return d;
};
const stored = async (b: unknown, d: ProcessDeps) => {
  const out = await processAlert(b, d);
  if (out.kind !== 'STORED') throw new Error(`expected STORED, got ${out.kind}`);
  return out.record as AutoAlertRecordV12;
};

describe('v1.2 receipt + enrichment audit', () => {
  it('records qualification, mapping, both dedupe keys, reconstruction and diagnostics; v1.1 fields unchanged', async () => {
    const d = deps('10:15:12');
    const r = await stored(body(), d);
    // v1.1 record exactly as before
    expect(r.status).toBe('OK');
    expect(r.versions).toEqual({ rules: 'RB v1.1', scoring: 'RB v1.1', strategy: 'RB v1.1' });
    expect(r.dedupeKey).toBe(`GM|LONG|${Math.floor(etToEpoch(D, '10:15:12') / 1000)}|RB_V1_LONG_SETUP`);
    expect(r.snapshot?.signal?.label).toBe('10:10–10:15');
    // v1.2 shadow audit
    const a = r.v12!;
    expect(a).toMatchObject({ schema: 1, logicVersion: 'RB v1.2', mode: 'SHADOW', duplicateOf: null });
    expect(a.qualification).toMatchObject({ status: 'NOT_QUALIFIED', numericValuesProvided: false });
    expect(a.qualification.ruleSet.status).toBe('MISSING');
    expect(a.signalMapping).toMatchObject({ status: 'ON_TIME', label: '10:10–10:15', lagSec: 12 });
    expect(a.dedupeKeys).toEqual({ v11: r.dedupeKey, v12: `v12|GM|LONG|C${new Date(etToEpoch(D, '10:10')).toISOString()}|-` });
    expect(a.reconstruction).toMatchObject({ source: 'SIP', high: r.snapshot!.values!.high, low: r.snapshot!.values!.low, atr14: r.snapshot!.values!.atr, sipRvol: r.snapshot!.values!.rvol });
    expect(a.reconstruction?.forming15m?.label).toBe('10:00–10:15');
    expect(a.conditionDiagnostics.map((x) => x.rule)).toEqual(['CLOSE_VS_VWAP', 'EMA9_VS_EMA20', 'RSI', 'CANDLE_DIRECTION', 'RVOL', 'CONFIRM_15M', 'CONFIRM_15M_FORMING']);
    expect(a.dataReview).toEqual([]);
    expect(a.ticketAtAlert).toEqual({ entry: r.calcAtAlert!.entry, stop: r.calcAtAlert!.stop, target: r.calcAtAlert!.target, shares: r.calcAtAlert!.shares, plannedRisk: r.calcAtAlert!.plannedRisk });
    expect(d.logs.map((l) => l[0])).toContain('v12_shadow_audit');
  });

  it('the audited RBTS-L-001 on a LONG webhook is QUALIFIED (shadow) and stays in the stored payload; v1.1 is unaffected by the extra field', async () => {
    const d = deps('10:15:12');
    const r = await stored(body({ rule_set: 'RBTS-L-001' }), d);
    expect(r.v12!.qualification.status).toBe('QUALIFIED');
    expect(r.v12!.qualification.ruleSet).toMatchObject({ status: 'RECOGNISED', ruleSet: 'RBTS-L-001' });
    expect(r.payload).toMatchObject({ rule_set: 'RBTS-L-001' });
    expect(r.payload).not.toHaveProperty('token');
    expect(r.v12!.dedupeKeys.v12.endsWith('|RBTS-L-001')).toBe(true);
    const plain = await stored(body(), deps('10:15:12'));
    const strip = (x: AutoAlertRecordV12) => ({ ...x, v12: undefined, payload: undefined });
    expect(strip(r)).toEqual(strip(plain)); // identical v1.1 record with or without rule_set
  });

  it('a delayed delivery (61–120 s) is mapped with a DELIVERY_DELAYED warning; > 120 s is an integrity problem', async () => {
    const late = await stored(body(), deps('10:16:30'));
    expect(late.v12!.signalMapping).toMatchObject({ status: 'DELAYED', label: '10:10–10:15' });
    expect(late.v12!.warnings[0]).toBe('DELIVERY_DELAYED');
    const amb = await stored(body(), deps('10:17:30', { data: fakeData({ bars: sessionBars(daysUpTo(D), { untilEt: '10:25' }) }) }));
    expect(amb.v12!.signalMapping.status).toBe('AMBIGUOUS');
    expect(amb.v12!.dataReview).toContain('SIGNAL_MAPPING_AMBIGUOUS');
  });

  it('provider failure: v1.1 DATA_ERROR as before; the receipt audit is kept, no reconstruction', async () => {
    const r = await stored(body(), deps('10:15:12', { data: fakeData({ fail: 'network down' }) }));
    expect(r.status).toBe('DATA_ERROR');
    expect(r.v12!.reconstruction).toBeNull();
    expect(r.v12!.signalMapping.status).toBe('ON_TIME');
  });
});

describe('dual dedupe (shadow: v1.2 key recorded, v1.1 key enforced)', () => {
  it('original webhook → stored, owns both keys', async () => {
    const d = deps('10:15:12');
    const r = await stored(body(), d);
    expect(await d.store.getDedupe(r.dedupeKey)).toBe(r.id);
    expect(await d.store.getDedupe(r.v12!.dedupeKeys.v12)).toBe(r.id);
  });
  it('exact retry (same second) → v1.1 DUPLICATE, not stored (unchanged behaviour)', async () => {
    const d = deps('10:15:12');
    const a = await stored(body(), d);
    expect(await processAlert(body(), d)).toMatchObject({ kind: 'DUPLICATE', id: a.id });
    expect((await (d.store as MemoryStore).list(D)).length).toBe(1);
  });
  it('retry within the same mapped candle (30 s later) → v1.1 stores it as before; its v1.2 audit links the original', async () => {
    let t = etToEpoch(D, '10:15:12');
    const d = deps('10:15:12', { now: () => t });
    const a = await stored(body(), d);
    t = etToEpoch(D, '10:15:42');
    const b = await stored(body(), d);
    expect(b.id).not.toBe(a.id); // v1.1 behaviour unchanged: a new record
    expect(b.v12!.duplicateOf).toBe(a.id);
    expect(b.v12!.dedupeKeys.v12).toBe(a.v12!.dedupeKeys.v12);
    expect(await d.store.getDedupe(b.v12!.dedupeKeys.v12)).toBe(a.id); // the original keeps ownership
  });
  it('same symbol/direction but the next candle → not a v1.2 duplicate', async () => {
    let t = etToEpoch(D, '10:15:12');
    const d = deps('10:15:12', { now: () => t, data: fakeData({ bars: sessionBars(daysUpTo(D), { untilEt: '10:25' }) }) });
    await stored(body(), d);
    t = etToEpoch(D, '10:20:09');
    const b = await stored(body(), d);
    expect(b.v12!.duplicateOf).toBeNull();
    expect(b.v12!.signalMapping.label).toBe('10:15–10:20');
  });
  it('different rule_set on the same candle → different v1.2 key', async () => {
    let t = etToEpoch(D, '10:15:12');
    const d = deps('10:15:12', { now: () => t });
    const a = await stored(body(), d);
    t = etToEpoch(D, '10:15:20');
    const b = await stored(body({ rule_set: 'RBTS-L-777' }), d);
    expect(b.v12!.duplicateOf).toBeNull();
    expect(b.v12!.dedupeKeys.v12).not.toBe(a.v12!.dedupeKeys.v12);
  });
});

describe('v1.2 RVOL-optional reconstruction at enrichment (Phase 3C.1)', () => {
  const sig = etToEpoch(D, '10:10');
  const noRvol = BARS.map((b) => (b.t === sig ? { ...b, v: 0 } : b));
  it('SIP RVOL unavailable: the v1.1 record is exactly as before; only the v1.2 audit carries the RVOL-optional rebuild', async () => {
    const r = await stored(body(), deps('10:15:12', { data: fakeData({ bars: noRvol }) }));
    expect(r.status).toBe('OK');
    expect(r.snapshot!.values).toBeNull();
    expect(r.snapshot!.issues.find((i) => i.code === 'RVOL20_UNAVAILABLE')?.kind).toBe('INCOMPLETE');
    expect(r.calcAtAlert).toBeNull();
    const s12 = r.v12!.rvolOptionalSnapshot!;
    expect(s12.values).not.toBeNull();
    expect(s12.config.optionalIndicators).toEqual(['RVOL20']);
    expect(r.v12!.reconstruction).toMatchObject({ high: s12.values!.high, low: s12.values!.low, atr14: s12.values!.atr, sipRvol: null });
    expect(r.v12!.dataReview).toEqual([]);
  });
  it('SIP RVOL available: no rebuild is stored', async () => {
    const r = await stored(body(), deps('10:15:12'));
    expect(r.snapshot!.values).not.toBeNull();
    expect(r.v12).not.toHaveProperty('rvolOptionalSnapshot');
  });
});
