/**
 * Step 3 (approved A + D) — signal-candle completeness with bounded retries, delayed-reconstruction trigger evidence, and
 * eligible current prices. Real Alpaca SIP data where it exists (CARR / FCX 2026-11-05, BSX trades 2026-11-04); the provider
 * lag itself is modelled (bars become available `lag` after their minute ends), and the model is checked against the exact
 * values production stored on 2026-11-05.
 */
import { describe, expect, it, vi } from 'vitest';
import FX from './step3-carr-fcx-2026-11-05.json';
import BSXT from './step3-bsx-trades-2026-11-04.json';
import { BarCache, createAlpacaData, type MarketDataClient, type RawTrade } from '../lib/alpaca';
import { enrichRecord, processAlert, retryGate, type ProcessDeps } from '../lib/processAlert';
import { MemoryStore } from '../lib/store';
import { buildAlertSnapshot } from '../../src/engine/automation/alertSnapshot';
import type { Bar } from '../../src/engine/automation/indicators';
import { CANDLE_MAX_ATTEMPTS, type AutoAlertRecord } from '../../src/engine/automation/alertDecision';
import { isEligibleTrade, isTriggerEvidence } from '../../src/engine/automation/tradeEligibility';
import { verifySignalCandle } from '../../src/engine/automation/signalCompleteness';

type Sym = 'CARR' | 'FCX';
const bars = (rows: (string | number)[][]): Bar[] => rows.map(([t, o, h, l, c, v]) => ({ t: Date.parse(t as string), o: o as number, h: h as number, l: l as number, c: c as number, v: v as number }));
const B5: Record<Sym, Bar[]> = { CARR: bars(FX.bars5.CARR), FCX: bars(FX.bars5.FCX) };
const B1: Record<Sym, Bar[]> = { CARR: bars(FX.bars1.CARR), FCX: bars(FX.bars1.FCX) };
const ALERT = { CARR: Date.parse(FX.alerts.CARR.alertTimeIso), FCX: Date.parse(FX.alerts.FCX.alertTimeIso) };
const MIN = 60_000;

/**
 * Provider-lag model: a 1-minute bar is served only once `lag` ms have passed after its minute ended; a 5-minute bar is
 * served as the aggregate of its minutes served so far (what Alpaca returned on 2026-11-05 10:05–10:15 ET).
 */
function served(sym: Sym, at: number, lag: number): { b5: Bar[]; b1: Bar[] } {
  const ok1 = B1[sym].filter((m) => m.t + MIN + lag <= at);
  const b5: Bar[] = [];
  for (const b of B5[sym]) {
    if (b.t + 5 * MIN <= Date.parse('2026-11-05T15:00:00Z')) { b5.push(b); continue; } // finalised long before the alert
    const ms = ok1.filter((m) => m.t >= b.t && m.t < b.t + 5 * MIN);
    if (!ms.length) continue;
    b5.push({ t: b.t, o: ms[0].o, h: Math.max(...ms.map((m) => m.h)), l: Math.min(...ms.map((m) => m.l)), c: ms[ms.length - 1].c, v: ms.reduce((a, m) => a + m.v, 0) });
  }
  return { b5, b1: ok1 };
}

function client(sym: Sym, clock: { now: number }, o: { lag: () => number; trades?: RawTrade[] | null; fail?: () => boolean } ): MarketDataClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: 'Alpaca', feed: 'sip', host: 'data.alpaca.markets', calls,
    async getBars5() { calls.push('bars5'); if (o.fail?.()) throw new Error('Alpaca 503: busy'); return served(sym, clock.now, o.lag()).b5; },
    async getBars1(_s, a, b) { calls.push('bars1'); if (o.fail?.()) throw new Error('Alpaca 503: busy'); return served(sym, clock.now, o.lag()).b1.filter((m) => m.t >= Date.parse(a) && m.t < Date.parse(b)); },
    async getLatestTrades(symbols) {
      calls.push('latest');
      const last = served(sym, clock.now, 0).b1.slice(-1)[0];
      return Object.fromEntries(symbols.map((s) => [s, { price: last.c, tradeIso: new Date(clock.now - 1000).toISOString(), fetchedIso: new Date(clock.now).toISOString(), conditions: [' '], tape: 'A', priceSource: 'LATEST' as const, skipped: null }]));
    },
    async getTrades() { calls.push('trades'); return o.trades === undefined ? null : o.trades; },
  };
}

const body = (sym: Sym) => ({ strategy: 'RB_V1', symbol: sym, direction: 'SHORT', alert_name: 'RB v1 SHORT Setup', alert_time: FX.alerts[sym].alertTimeIso });
function deps(_sym: Sym, clock: { now: number }, data: MarketDataClient, store = new MemoryStore(), cache?: BarCache): ProcessDeps & { logs: string[] } {
  const logs: string[] = [];
  return { store, data, cache, log: (e) => void logs.push(e), now: () => clock.now, sleep: async (ms) => void (clock.now += ms), lookbackDays: 2, logs };
}

describe('Step 3 · A — the lag model reproduces what production stored on 2026-11-05', () => {
  it('CARR 10:05:18 and FCX 10:05:11: the served 10:00–10:05 bar equals production\'s stored signal candle exactly (3 of 5 minutes)', () => {
    for (const sym of ['CARR', 'FCX'] as Sym[]) {
      const { b5 } = served(sym, ALERT[sym] + 3000, 120_000);
      const sig = b5.find((b) => b.t === Date.parse('2026-11-05T15:00:00Z'))!;
      const p = FX.alerts[sym].productionStoredSignal;
      expect([sig.o, sig.h, sig.l, sig.c, sig.v]).toEqual([p.open, p.high, p.low, p.close, p.volume]);
    }
  });
});

describe('Step 3 · A — signal-candle completeness (real CARR / FCX data)', () => {
  it('the partial 3-minute candle is detected: DATA_ERROR SIGNAL_CANDLE_INCOMPLETE, no snapshot, no ticket data, retry in ~30 s', async () => {
    const clock = { now: ALERT.CARR };
    const d = deps('CARR', clock, client('CARR', clock, { lag: () => 120_000 }));
    const out = await processAlert(body('CARR'), d);
    const rec = (out as Extract<typeof out, { kind: 'STORED' }>).record;
    expect(rec).toMatchObject({ status: 'DATA_ERROR', errorCode: 'SIGNAL_CANDLE_INCOMPLETE', snapshot: null, calcAtAlert: null, attempts: 1 });
    expect(rec.errors[0]).toMatch(/final minute \(10:04 ET\) .* not yet in the 1-minute data .*3 of 5 minutes: 10:00, 10:01, 10:02/);
    expect(rec.nextAttemptMs).toBe(clock.now + 30_000);
    expect(rec.enrichmentAudit![0]).toMatchObject({ attempt: 1, outcome: 'SIGNAL_CANDLE_INCOMPLETE', provisional: { bar5: { v: 75437, c: 55.05 }, minutes: ['10:00', '10:01', '10:02'] } });
    expect(rec.alert.alertTimeMs).toBe(ALERT.CARR); // the original alert time (and so the 10-minute expiry) is never moved
  });

  it('bounded retries at ~30 / 60 / 120 s: 3 → 4 minutes → complete; the final snapshot equals the one built from the final bars', async () => {
    const clock = { now: ALERT.CARR };
    let lag = 120_000;
    const data = client('CARR', clock, { lag: () => lag });
    const d = deps('CARR', clock, data);
    let rec = (await processAlert(body('CARR'), d) as { record: AutoAlertRecord }).record;
    const t1 = clock.now;
    clock.now = rec.nextAttemptMs!; // +30 s: still 3 minutes
    rec = await enrichRecord(rec, d);
    expect(rec).toMatchObject({ status: 'DATA_ERROR', errorCode: 'SIGNAL_CANDLE_INCOMPLETE', attempts: 2 });
    expect(rec.nextAttemptMs).toBe(clock.now + 60_000);
    clock.now = rec.nextAttemptMs!; // +60 s: 4 minutes
    rec = await enrichRecord(rec, d);
    expect(rec).toMatchObject({ status: 'DATA_ERROR', attempts: 3 });
    expect(rec.enrichmentAudit![2].provisional!.minutes).toEqual(['10:00', '10:01', '10:02', '10:03']);
    expect(rec.nextAttemptMs).toBe(clock.now + 120_000);
    lag = 0; // provider caught up
    clock.now = rec.nextAttemptMs!;
    rec = await enrichRecord(rec, d);
    expect(rec).toMatchObject({ status: 'OK', attempts: 4, nextAttemptMs: null });
    expect(rec.errorCode).toBeUndefined();
    expect(rec.snapshot).toEqual(buildAlertSnapshot(B5.CARR, ALERT.CARR, 'SHORT')); // final bars, not the provisional ones
    expect(rec.snapshot!.values!.volume).toBe(96626);
    // the RVOL disagreement with TrendSpider remains (SIP RVOL 0.958 < 1.5): still DATA REVIEW — not a candle defect
    expect(rec.snapshot!.issues.map((i) => i.code)).toContain('ALERT_NOT_REPRODUCED');
    // audit trail: every attempt, outcome and time; first decision time written once
    expect(rec.enrichmentAudit!.map((a) => a.outcome)).toEqual(['SIGNAL_CANDLE_INCOMPLETE', 'SIGNAL_CANDLE_INCOMPLETE', 'SIGNAL_CANDLE_INCOMPLETE', 'OK']);
    expect(Date.parse(rec.firstProcessedIso!)).toBe(t1);
    expect(rec.delayedReconstruction).toMatchObject({ attempts: 4, firstAttemptIso: new Date(t1).toISOString() });
  });

  it('retries are bounded: still incomplete after the 4th attempt → SIGNAL_CANDLE_INCOMPLETE_FINAL, no more attempts accepted', async () => {
    const clock = { now: ALERT.CARR };
    const d = deps('CARR', clock, client('CARR', clock, { lag: () => 600_000 }));
    let rec = (await processAlert(body('CARR'), d) as { record: AutoAlertRecord }).record;
    for (let i = 0; i < 3; i++) { clock.now = rec.nextAttemptMs!; rec = await enrichRecord(rec, d); }
    expect(rec).toMatchObject({ status: 'DATA_ERROR', errorCode: 'SIGNAL_CANDLE_INCOMPLETE_FINAL', attempts: CANDLE_MAX_ATTEMPTS, nextAttemptMs: null });
    expect(rec.errors[0]).toMatch(/Retries exhausted after 4 attempts — MANUAL REVIEW REQUIRED/);
    expect(retryGate(rec, clock.now + 3_600_000)).toMatch(/MANUAL REVIEW REQUIRED/);
  });

  it('the server enforces the schedule: an early reprocess is refused; a due one is allowed', async () => {
    const clock = { now: ALERT.CARR };
    const d = deps('CARR', clock, client('CARR', clock, { lag: () => 120_000 }));
    const rec = (await processAlert(body('CARR'), d) as { record: AutoAlertRecord }).record;
    expect(retryGate(rec, rec.nextAttemptMs! - 1)).toMatch(/retry scheduled/);
    expect(retryGate(rec, rec.nextAttemptMs!)).toBeNull();
    expect(retryGate({ ...rec, errorCode: undefined, attempts: 3 }, 0)).toMatch(/Retry limit reached/); // other DATA_ERRORs: unchanged
  });

  it('cache: a partial candle is never cached; a later alert on the same symbol and candle refetches', async () => {
    const clock = { now: ALERT.CARR };
    let lag = 120_000;
    const data = client('CARR', clock, { lag: () => lag });
    const cache = new BarCache(60_000);
    const d = deps('CARR', clock, data, new MemoryStore(), cache);
    await processAlert(body('CARR'), d);
    const before = data.calls.filter((c) => c === 'bars5').length;
    lag = 0;
    const second = await processAlert({ ...body('CARR'), alert_name: 'RB v1 SHORT Setup (2)', alert_time: new Date(ALERT.CARR + 5000).toISOString() }, d);
    expect(data.calls.filter((c) => c === 'bars5').length).toBe(before + 1);
    expect((second as { record: AutoAlertRecord }).record.status).toBe('OK');
  });

  it('server restart: a stored DATA_ERROR record resumes its schedule with a fresh process (no in-memory state needed)', async () => {
    const clock = { now: ALERT.CARR };
    const store = new MemoryStore();
    const d1 = deps('CARR', clock, client('CARR', clock, { lag: () => 120_000 }), store);
    const rec = (await processAlert(body('CARR'), d1) as { record: AutoAlertRecord }).record;
    clock.now = rec.nextAttemptMs! + 200_000;
    const d2 = deps('CARR', clock, client('CARR', clock, { lag: () => 0 }), store); // new instance, empty cache
    const stored = await store.get('2026-11-05', rec.id);
    const done = await enrichRecord(stored!, d2);
    expect(done).toMatchObject({ status: 'OK', attempts: 2 });
    expect(done.enrichmentAudit!.map((a) => a.attempt)).toEqual([1, 2]);
  });

  it('a provider outage while waiting keeps the bounded candle schedule (never an unbounded retry)', async () => {
    const clock = { now: ALERT.CARR };
    let down = false;
    const d = deps('CARR', clock, client('CARR', clock, { lag: () => 120_000, fail: () => down }));
    let rec = (await processAlert(body('CARR'), d) as { record: AutoAlertRecord }).record;
    down = true;
    clock.now = rec.nextAttemptMs!;
    rec = await enrichRecord(rec, d);
    expect(rec).toMatchObject({ status: 'DATA_ERROR', errorCode: 'SIGNAL_CANDLE_INCOMPLETE', attempts: 2 });
    expect(rec.enrichmentAudit![1].detail).toMatch(/Market data fetch failed/);
    expect(rec.nextAttemptMs).toBe(clock.now + 60_000);
  });

  it('an OK record is immutable: a later enrichment never overwrites the frozen snapshot', async () => {
    const clock = { now: ALERT.CARR };
    const d = deps('CARR', clock, client('CARR', clock, { lag: () => 0 }));
    const rec = (await processAlert(body('CARR'), d) as { record: AutoAlertRecord }).record;
    expect(rec.status).toBe('OK');
    clock.now += 600_000;
    expect(await enrichRecord(rec, d)).toBe(rec);
  });
});

describe('Step 3 · A — completeness check on real and synthetic shapes', () => {
  const at = ALERT.CARR;
  const final5 = B5.CARR, final1 = B1.CARR;
  it('final data: COMPLETE (5 of 5 minutes, exact aggregate)', () => expect(verifySignalCandle(final5, final1, at).status).toBe('COMPLETE'));
  it('missing 1-minute bars (provider returned none) → INCOMPLETE', () => expect(verifySignalCandle(final5, [], at).status).toBe('INCOMPLETE'));
  it('late-arriving volume (5-minute bar behind its minutes) → INCOMPLETE', () => {
    const lagging = final5.map((b) => (b.t === Date.parse('2026-11-05T15:00:00Z') ? { ...b, v: b.v - 500 } : b));
    expect(verifySignalCandle(lagging, final1, at).reason).toMatch(/does not equal its 1-minute aggregate/);
  });
  it('a 1-minute series behind the 5-minute bar → INCOMPLETE', () => {
    const late = final1.map((m) => (m.t === Date.parse('2026-11-05T15:02:00Z') ? { ...m, v: m.v - 100 } : m));
    expect(verifySignalCandle(final5, late, at).status).toBe('INCOMPLETE');
  });
  it('a 1-minute bar off the minute grid → INCOMPLETE', () => {
    const first = final1.find((m) => m.t === Date.parse('2026-11-05T15:00:00Z'))!;
    expect(verifySignalCandle(final5, [...final1, { ...first, t: first.t + 30_000 }], at).reason).toMatch(/minute boundaries/);
  });
});

describe('Step 3 · A — trigger continuity across a delayed reconstruction (requirement 11)', () => {
  const clockFor = (sym: Sym) => ({ now: ALERT[sym] });
  /** Partial candle at attempts 1–3 (lag 120 s → 3/4 minutes), final at the 4th attempt (~3.5 min after the first). */
  async function delayed(sym: Sym, lagAtEnd: number, trades: RawTrade[] | null) {
    const clock = clockFor(sym);
    let lag = 600_000;
    const d = deps(sym, clock, client(sym, clock, { lag: () => lag, trades }));
    let rec = (await processAlert(body(sym), d) as { record: AutoAlertRecord }).record;
    for (let i = 0; i < 2; i++) { clock.now = rec.nextAttemptMs!; rec = await enrichRecord(rec, d); }
    expect(rec.status).toBe('DATA_ERROR');
    clock.now = rec.nextAttemptMs!;
    lag = lagAtEnd;
    return enrichRecord(rec, d);
  }
  // CARR's planned SHORT entry from the final candle (computed by the same server path, no delay)
  const carrEntry = async () => {
    const clock = { now: ALERT.CARR };
    const d = deps('CARR', clock, client('CARR', clock, { lag: () => 0 }));
    return ((await processAlert(body('CARR'), d)) as { record: AutoAlertRecord }).record.calcAtAlert!.entry!;
  };
  const print = (iso: string, p: number, c: string[]): RawTrade => ({ t: iso, p, s: 50, x: 'N', c, z: 'A' });
  it('the delay\'s trades cannot be retrieved completely → UNVERIFIED (fail closed), even though the candle itself is final', async () => {
    const rec = await delayed('CARR', 150_000, null); // candle final; trade record of the delay unavailable
    expect(rec.status).toBe('OK');
    expect(rec.delayedReconstruction!.gap.status).toBe('UNVERIFIED');
    expect(rec.delayedReconstruction!.gap.reason).toMatch(/could not be retrieved completely/);
  });
  it('an odd-lot print at/through the entry during the delay → CROSSED (conservative trigger evidence)', async () => {
    const entry = await carrEntry();
    const rec = await delayed('CARR', 0, [print('2026-11-05T15:06:30Z', entry, [' ', 'I'])]);
    expect(rec.delayedReconstruction!.gap).toMatchObject({ status: 'CROSSED', crossedPrice: entry, crossedAtIso: '2026-11-05T15:06:30Z' });
    // Step 5 · provenance and wording: an odd lot, its conditions and its print time
    expect(rec.delayedReconstruction!.gap).toMatchObject({ crossedVia: 'ODD_LOT_TRADE', crossedConditions: [' ', 'I'], crossedTape: 'A' });
    expect(rec.delayedReconstruction!.gap.reason).toBe(`an odd-lot trade at ${entry} [regular I] printed at 10:06:30 ET, at or through the ${entry} entry, during the delayed reconstruction.`);
  });
  it('an average-price / derivatively priced print at/through the entry is NOT trigger evidence; the complete trade record proves NOT_CROSSED', async () => {
    const entry = await carrEntry();
    const rec = await delayed('CARR', 150_000, [print('2026-11-05T15:06:30Z', entry - 0.2, [' ', '4', 'B']), print('2026-11-05T15:06:31Z', entry + 0.1, [' '])]);
    expect(rec.delayedReconstruction!.gap.status).toBe('NOT_CROSSED');
  });
  it('FCX 10:05:11 (real data): the final candle\'s entry was reached during the delay → CROSSED (the app latches MISSED)', async () => {
    const rec = await delayed('FCX', 0, []);
    const g = rec.delayedReconstruction!.gap;
    expect(g.status).toBe('CROSSED');
    expect(g.crossedPrice!).toBeLessThanOrEqual(g.entry); // SHORT: at or through the entry
    expect(g.crossedVia).toBe('MINUTE_BAR'); // Step 5 · provenance: proven by a complete 1-minute bar
    expect(g.reason).toMatch(/^the 1-minute bar 10:0\d–10:0\d ET reached [\d.]+ \(its low\), at or through the [\d.]+ entry, during the delayed reconstruction\.$/);
  });
});

describe('Step 3 · D — eligible current-price data', () => {
  const T = BSXT.trades.map(([t, p, s, x, c, z]) => ({ t: t as string, p: p as number, s: s as number, x: x as string, c: c as string[], z: z as string }));
  it('real BSX prints: derivatively priced / average-price (4, B on tape A) and odd lots (I) are ineligible; regular and ISO prints are eligible', () => {
    const off = T.filter((t) => t.p < 46.4);
    expect(off.length).toBeGreaterThan(5);
    expect(off.every((t) => !isEligibleTrade(t))).toBe(true); // the 46.31 prints that drove the 87 scores
    expect(isEligibleTrade(T.find((t) => t.t.startsWith('2026-11-04T18:00:52.630'))!)).toBe(false); // 46.3158 × 200 [' ','4','B']
    expect(isEligibleTrade(T.find((t) => t.t.startsWith('2026-11-04T18:00:32.323') && t.s === 100)!)).toBe(true); // 46.46 ISO round lot
    expect(isEligibleTrade(T.find((t) => t.t.startsWith('2026-11-04T18:00:35.157'))!)).toBe(true); // the latch print 46.4651 × 250
    expect(T.filter((t) => t.c.includes('I')).every((t) => !isEligibleTrade(t))).toBe(true);
  });
  it('BSX: the first ELIGIBLE print at/through the 46.46 trigger is 13:00:32.323 — the confirmed crossing stands', () => {
    const first = T.filter((t) => isEligibleTrade(t) && t.p >= 46.46).sort((a, b) => a.t.localeCompare(b.t))[0];
    expect(first.t.slice(11, 23)).toBe('18:00:32.323');
  });
  it('trigger evidence (conservative): eligible and odd-lot prints count; average-price, derivatively priced, out-of-sequence do not', () => {
    expect(isTriggerEvidence({ c: [' ', 'I'], z: 'A' })).toBe(true);
    expect(isTriggerEvidence({ c: ['@', 'F', 'I'], z: 'C' })).toBe(true);
    expect(isTriggerEvidence({ c: ['I'], z: 'A' })).toBe(true);
    for (const c of [[' ', '4', 'I'], [' ', '4', 'B'], ['@', 'W'], [' ', 'Z'], [' ', 'T', 'I']]) expect([c, isTriggerEvidence({ c, z: c.includes('@') ? 'C' : 'A' })]).toEqual([c, false]);
  });
  it('VRSK 2026-11-04 (real prints): odd-lot ISO prints at 201.26–201.41 from 10:35:12.107 are trigger evidence before the first eligible crossing at 10:35:13.338', () => {
    expect(isTriggerEvidence({ c: ['@', 'F', 'I'], z: 'C' })).toBe(true); // 201.26 at 10:35:12.107
    expect(isEligibleTrade({ c: ['@', 'F', 'I'], z: 'C' })).toBe(false); // never the executable price
    expect(isEligibleTrade({ c: ['@'], z: 'C' })).toBe(true); // 201.465 at 10:35:13.338
  });
  it('codes are tape-specific: B is ineligible on tape A/B (average price) but eligible on tape C (bunched); W ineligible on C', () => {
    expect(isEligibleTrade({ c: [' ', 'B'], z: 'A' })).toBe(false);
    expect(isEligibleTrade({ c: ['@', 'B'], z: 'C' })).toBe(true);
    expect(isEligibleTrade({ c: ['@', 'W'], z: 'C' })).toBe(false);
    expect(isEligibleTrade({ c: [' ', 'B'], z: null })).toBe(false); // unknown tape: conservative
  });
  it('controlled cases: out of sequence, extended hours, prior reference, contingent, official open/close, corrected close, missing conditions → ineligible', () => {
    for (const c of ['Z', 'U', 'T', 'P', 'V', '7', 'Q', 'M', '9', 'C', 'N', 'R', 'H']) expect([c, isEligibleTrade({ c: [' ', c], z: 'A' })]).toEqual([c, false]);
    expect(isEligibleTrade({ c: [], z: 'A' })).toBe(false);
    expect(isEligibleTrade({ c: null, z: 'A' })).toBe(false);
    for (const c of ['F', 'L', 'X', 'O', '5', '6', 'K']) expect([c, isEligibleTrade({ c: [' ', c], z: 'A' })]).toEqual([c, true]);
  });

  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  it('client: an ineligible latest print is replaced by the newest eligible print (provenance recorded); the off-market price is never served', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(ok({ trades: { BSX: { t: '2026-11-04T18:00:52.630Z', p: 46.3158, c: [' ', '4', 'B'], z: 'A' } } }))
      .mockResolvedValueOnce(ok({ trades: [{ t: '2026-11-04T18:00:52.630Z', p: 46.3158, c: [' ', '4', 'B'], z: 'A' }, { t: '2026-11-04T18:00:51.779Z', p: 46.445, c: [' ', 'I'], z: 'A' }, { t: '2026-11-04T18:00:50.738Z', p: 46.445, c: [' '], z: 'A' }], next_page_token: null }));
    const c = createAlpacaData({ keyId: 'k', secretKey: 's', fetchImpl: f as never, now: () => Date.parse('2026-11-04T18:00:54Z') });
    const q = (await c.getLatestTrades(['BSX'])).BSX;
    expect(q).toMatchObject({ price: 46.445, tradeIso: '2026-11-04T18:00:50.738Z', priceSource: 'LATEST_ELIGIBLE', skipped: { price: 46.3158, conditions: [' ', '4', 'B'] } });
    expect(String(f.mock.calls[1][0])).toMatch(/\/v2\/stocks\/BSX\/trades\?.*sort=desc/);
  });
  it('client: no eligible print in the look-back → no price for that symbol (fail closed); other symbols are unaffected', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(ok({ trades: { BSX: { t: '2026-11-04T18:00:52Z', p: 46.3158, c: [' ', '4', 'B'], z: 'A' }, GM: { t: '2026-11-04T18:00:53Z', p: 50, c: [' '], z: 'A' } } }))
      .mockResolvedValueOnce(ok({ trades: [{ t: '2026-11-04T18:00:52Z', p: 46.3158, c: [' ', '4', 'B'], z: 'A' }], next_page_token: null }));
    const c = createAlpacaData({ keyId: 'k', secretKey: 's', fetchImpl: f as never });
    const q = await c.getLatestTrades(['BSX', 'GM']);
    expect(q.BSX).toBeUndefined();
    expect(q.GM).toMatchObject({ price: 50, priceSource: 'LATEST' });
  });
  it('client: a failed look-back request leaves only that symbol without a price', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(ok({ trades: { BSX: { t: '2026-11-04T18:00:52Z', p: 46.3158, c: [' ', 'I'], z: 'A' }, GM: { t: '2026-11-04T18:00:53Z', p: 50, c: [' '], z: 'A' } } }))
      .mockResolvedValue(new Response('nope', { status: 403 }));
    const c = createAlpacaData({ keyId: 'k', secretKey: 's', fetchImpl: f as never, attempts: 1 });
    const q = await c.getLatestTrades(['BSX', 'GM']);
    expect(Object.keys(q)).toEqual(['GM']);
  });
});

describe('RVOL transparency — written once at alert time from the verified bars; decision unchanged', () => {
  it('CARR 10:05 (complete candle): rvolDiagnostics = TrendSpider formula on SIP, live RVOL untouched, never recomputed later', async () => {
    const clock = { now: ALERT.CARR };
    const d = deps('CARR', clock, client('CARR', clock, { lag: () => 0 }));
    const rec = (await processAlert(body('CARR'), d) as { record: AutoAlertRecord }).record;
    expect(rec.status).toBe('OK');
    const diag = rec.rvolDiagnostics!;
    // independent computation from the fixture: volume / SMA20 of the 20 completed regular-session candles before the signal
    const sig = Date.parse('2026-11-05T15:00:00Z');
    const prior = B5.CARR.filter((b) => b.t < sig).filter((b) => { const m = new Date(b.t).getUTCHours() * 60 + new Date(b.t).getUTCMinutes(); return m >= 14 * 60 + 30 && m < 21 * 60; }).slice(-20);
    expect(prior).toHaveLength(20);
    const base = prior.reduce((a, b) => a + b.v, 0) / 20;
    expect(diag.baseline).toBeCloseTo(base, 6);
    expect(diag.tsFormulaSipRvol).toBeCloseTo(rec.snapshot!.values!.volume / base, 12);
    expect(diag.rbRvol).toBe(rec.snapshot!.values!.rvol); // live value untouched
    expect(diag.trendspiderActual).toBeNull();
    expect(diag.computedAtIso).toBe(rec.processedIso);
    // immutability: a later pass returns the same record (the diagnostic is never recomputed from later data)
    clock.now += 600_000;
    expect((await enrichRecord(rec, d)).rvolDiagnostics).toEqual(diag);
  });
});
