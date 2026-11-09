/**
 * Defect 1 — one authoritative account equity. Real calculator / allocator / queue code; nothing mocked.
 */
import { describe, expect, it } from 'vitest';
import FX from '../automation/__tests__/rvol-policy-b-2026-11-05.json';
import { effectiveAccountEquity, equityConflictText, syncAccountEquity, withEffectiveEquity } from '../accountEquity';
import { RB_V1_DEFAULTS, type RbSettings } from '../settings';
import { cloneRankerDefaults, type RankerSettings } from '../ranker/rankerSettings';
import { buildPortfolio } from '../ranker/portfolioAllocator';
import { evaluateTrade } from '../tradeCalculator';
import { emptyForm, toInputs } from '../../lib/form';
import { FROZEN_FINGERPRINT, coreFingerprint, isFrozenDefinition } from '../strategyVersion';
import { buildQueue } from '../automation/liveQueue';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../automation/alertDecision';
import { KNOWN_CLASSIFICATIONS } from '../ranker/correlationRules';
import type { ManualPosition } from '../ranker/opportunityTypes';

const rb = (equity: number): RbSettings => ({ ...RB_V1_DEFAULTS, accountEquity: equity });
const rk = (equity: number): RankerSettings => { const r = cloneRankerDefaults(); r.portfolio.accountEquity = equity; return r; };
/** A risk-bound LONG trade (wide stop): quantity = floor(equity × 0.25% ÷ R). */
const wideStopInputs = (s: RbSettings) => ({ ...toInputs({ ...emptyForm(s), ticker: 'TEST', open: '47.50', high: '50.00', low: '47.00', close: '49.80', atr: '0.50', currentPrice: '49.90', alertTime: '10:00', close15m: '49.80', ema20_15m: '48.00', minutesSinceAlert: '1' } as never, false) });
const open = (id: string, pv: number, risk: number, pending = false): ManualPosition => ({ id, ticker: id, direction: 'LONG', sector: `S-${id}`, industry: `I-${id}`, theme: '', positionValue: pv, plannedRisk: risk, entry: 100, stop: 99, target: 102, status: 'OPEN', pending } as unknown as ManualPosition);

describe('effective equity: one value', () => {
  it('copies agree → that value, no conflict, and the SAME objects are returned (no behaviour change)', () => {
    const a = rb(100_000), b = rk(100_000);
    const eq = effectiveAccountEquity(a, b);
    expect(eq).toEqual({ value: 100_000, source: 'SINGLE', conflict: null });
    const v = withEffectiveEquity(a, b, eq);
    expect(v.rb).toBe(a);
    expect(v.rk).toBe(b);
  });
  it('defaults (fresh browser) → 100,000 everywhere; the frozen RB v1.1 fingerprint is unchanged', () => {
    expect(effectiveAccountEquity(RB_V1_DEFAULTS, cloneRankerDefaults()).value).toBe(100_000);
    expect(coreFingerprint(RB_V1_DEFAULTS, cloneRankerDefaults())).toBe(FROZEN_FINGERPRINT);
  });
  it('equity is not part of the strategy definition: 150,000 keeps RB v1.1 FROZEN (risk 0.25 %, cap $20,000 unchanged)', () => {
    expect(isFrozenDefinition(rb(150_000), rk(150_000))).toBe(true);
    expect([RB_V1_DEFAULTS.riskPct, RB_V1_DEFAULTS.investmentCap, cloneRankerDefaults().portfolio.riskPerTradePct, cloneRankerDefaults().portfolio.maxPositionValue]).toEqual([0.0025, 20_000, 0.0025, 20_000]);
  });
});

describe('existing conflicting browser values', () => {
  it('Settings 150k / Ranker 100k → conflict shown, the LOWER (100k) is used by every calculation, stored values preserved', () => {
    const a = rb(150_000), b = rk(100_000);
    const eq = effectiveAccountEquity(a, b);
    expect(eq).toEqual({ value: 100_000, source: 'CONFLICT_LOWER_USED', conflict: { settings: 150_000, ranker: 100_000 } });
    const v = withEffectiveEquity(a, b, eq);
    expect([v.rb.accountEquity, v.rk.portfolio.accountEquity]).toEqual([100_000, 100_000]);
    expect([a.accountEquity, b.portfolio.accountEquity]).toEqual([150_000, 100_000]); // inputs never mutated
    expect(equityConflictText(eq.conflict!)).toMatch(/Settings has \$150,000 but Ranker → Portfolio policy has \$100,000.*lower value, \$100,000/);
  });
  it('never a silent risk increase: sizing ≤ the old Settings-based sizing, limits ≤ the old Ranker-based limits', () => {
    for (const [s, r] of [[150_000, 100_000], [80_000, 120_000]] as const) {
      const v = withEffectiveEquity(rb(s), rk(r));
      const oldSize = evaluateTrade(wideStopInputs(rb(s)), rb(s)).plan!;
      const newSize = evaluateTrade(wideStopInputs(v.rb), v.rb).plan!;
      expect(newSize.maxDollarRisk).toBeLessThanOrEqual(oldSize.maxDollarRisk);
      expect(newSize.shares).toBeLessThanOrEqual(oldSize.shares);
      const oldPf = buildPortfolio([], [], rk(r)), newPf = buildPortfolio([], [], v.rk);
      for (const k of ['usableAllocation', 'available', 'heatLimit', 'perTradeRiskLimit'] as const) expect(newPf[k]).toBeLessThanOrEqual(oldPf[k]);
    }
  });
  it('refresh: the conflict is re-derived identically from the stored values (JSON round trip) until resolved', () => {
    const stored = JSON.parse(JSON.stringify({ s: rb(150_000), r: rk(100_000) }));
    expect(effectiveAccountEquity(stored.s, stored.r)).toEqual(effectiveAccountEquity(rb(150_000), rk(100_000)));
  });
  it('an invalid stored copy (0 / NaN) never wins: the valid one is used', () => {
    expect(effectiveAccountEquity(rb(120_000), rk(Number.NaN)).value).toBe(120_000);
    expect(effectiveAccountEquity(rb(0), rk(90_000)).value).toBe(90_000);
  });
});

describe('write rule: one value, written to both stores', () => {
  it('editing equity in Settings writes the same value to the Ranker copy', () => {
    const [a, b] = syncAccountEquity([rb(100_000), rk(100_000)], [rb(150_000), rk(100_000)]);
    expect([a.accountEquity, b.portfolio.accountEquity]).toEqual([150_000, 150_000]);
  });
  it('editing equity in Ranker → Portfolio policy writes the same value to Settings', () => {
    const [a, b] = syncAccountEquity([rb(100_000), rk(100_000)], [rb(100_000), rk(125_000)]);
    expect([a.accountEquity, b.portfolio.accountEquity]).toEqual([125_000, 125_000]);
  });
  it('editing another field while a conflict exists never resolves it silently', () => {
    const cur: [RbSettings, RankerSettings] = [rb(150_000), rk(100_000)];
    const other = rk(100_000); other.portfolio.brokerBuyingPower = 5_000;
    const [a, b] = syncAccountEquity(cur, [rb(150_000), other]);
    expect([a.accountEquity, b.portfolio.accountEquity]).toEqual([150_000, 100_000]);
    expect(effectiveAccountEquity(a, b).conflict).not.toBeNull();
  });
  it('explicit resolution (either button) → both copies equal, conflict gone, survives refresh', () => {
    for (const pick of [150_000, 100_000]) {
      const [a, b] = syncAccountEquity([rb(150_000), rk(100_000)], [rb(pick), rk(pick)]);
      const after = JSON.parse(JSON.stringify([a, b]));
      expect(effectiveAccountEquity(after[0], after[1])).toEqual({ value: pick, source: 'SINGLE', conflict: null });
    }
  });
  it('an edit to both sides at once (not produced by the UI) writes the lower value', () => {
    const [a, b] = syncAccountEquity([rb(100_000), rk(100_000)], [rb(150_000), rk(130_000)]);
    expect([a.accountEquity, b.portfolio.accountEquity]).toEqual([130_000, 130_000]);
  });
});

describe('deliberate change 100,000 → 150,000: every dependent calculation moves together (new decisions)', () => {
  const before = withEffectiveEquity(rb(100_000), rk(100_000));
  const [s2, r2] = syncAccountEquity([rb(100_000), rk(100_000)], [rb(150_000), rk(100_000)]);
  const after = withEffectiveEquity(s2, r2);
  it('Calculator: prefill, max dollar risk 250 → 375, a risk-bound quantity grows; the $20,000 cap still binds', () => {
    expect([emptyForm(before.rb).accountEquity, emptyForm(after.rb).accountEquity]).toEqual(['100000', '150000']);
    const p0 = evaluateTrade(wideStopInputs(before.rb), before.rb).plan!;
    const p1 = evaluateTrade(wideStopInputs(after.rb), after.rb).plan!;
    expect([p0.maxDollarRisk, p1.maxDollarRisk]).toEqual([250, 375]);
    expect(p1.shares).toBeGreaterThan(p0.shares);
    expect(p1.positionValue).toBeLessThanOrEqual(20_000);
  });
  it('Portfolio: usable 80,000 → 120,000, heat limit 1,000 → 1,500, per-trade limit 250 → 375 (with an open position and a pending order)', () => {
    const pos = [open('AAA', 19_000, 200), open('BBB', 18_000, 150, true)];
    const a = buildPortfolio(pos, [], before.rk), b = buildPortfolio(pos, [], after.rk);
    expect([a.usableAllocation, a.available, a.heatLimit, a.perTradeRiskLimit, a.heatCommitted, a.slotsUsed]).toEqual([80_000, 43_000, 1_000, 250, 350, 2]);
    expect([b.usableAllocation, b.available, b.heatLimit, b.perTradeRiskLimit, b.heatCommitted, b.slotsUsed]).toEqual([120_000, 83_000, 1_500, 375, 350, 2]);
    expect([b.maxPositions, b.maxPositionValue]).toEqual([4, 20_000]); // slot and cap policy unchanged
  });
  it('Live Queue: the SAME effective equity drives sizing (rb) and allocation (rk) of a new alert', () => {
    const rec = structuredClone((FX.records as unknown as AutoAlertRecord[])[0]);
    const now = Date.parse(rec.processedIso!) + 4_000;
    const quotes: Record<string, LiveQuote> = { [rec.alert.symbol]: { ...rec.initialQuote!, tradeIso: new Date(now - 1500).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 } };
    const run = (v: { rb: RbSettings; rk: RankerSettings }) => buildQueue({ records: [rec], candidates: [], positions: [], quotes, now, cfg: DEFAULT_AUTOMATION, rb: v.rb, rk: v.rk, classify: (x) => KNOWN_CLASSIFICATIONS[x] ?? { sector: `S-${x}`, industry: `I-${x}`, theme: '' }, parity: {}, strategyVersion: 'RB v1.1', frozen: {}, terminal: {} });
    const q0 = run(before), q1 = run(after);
    expect([q0.portfolio.equity, q1.portfolio.equity]).toEqual([100_000, 150_000]);
    expect([q0.portfolio.heatLimit, q1.portfolio.heatLimit]).toEqual([1_000, 1_500]);
    const r0 = q0.rows[0], r1 = q1.rows[0];
    expect(r1.live?.plan?.maxDollarRisk).toBe(375);
    expect(r0.live?.plan?.maxDollarRisk).toBe(250);
    // entry / stop / target never depend on equity
    expect([r1.candidate?.entry, r1.candidate?.stop, r1.candidate?.target]).toEqual([r0.candidate?.entry, r0.candidate?.stop, r0.candidate?.target]);
  });
  it('an EXISTING candidate keeps its frozen plan (entry / stop / target / quantity) after the change', () => {
    const rec = structuredClone((FX.records as unknown as AutoAlertRecord[])[0]);
    const now = Date.parse(rec.processedIso!) + 4_000;
    const quotes: Record<string, LiveQuote> = { [rec.alert.symbol]: { ...rec.initialQuote!, tradeIso: new Date(now - 1500).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 } };
    const base = { records: [rec], positions: [], quotes, cfg: DEFAULT_AUTOMATION, classify: (x: string) => KNOWN_CLASSIFICATIONS[x] ?? { sector: `S-${x}`, industry: `I-${x}`, theme: '' }, parity: {}, strategyVersion: 'RB v1.1', frozen: {}, terminal: {} };
    const first = buildQueue({ ...base, candidates: [], now, rb: before.rb, rk: before.rk });
    const later = buildQueue({ ...base, candidates: first.candidates, now: now + 20_000, rb: after.rb, rk: after.rk });
    const pick = (c: typeof first.candidates[number] | undefined) => c && [c.entry, c.stop, c.target, c.shares, c.positionValue, c.plannedRisk];
    expect(pick(later.candidates[0])).toEqual(pick(first.candidates[0]));
  });
});

describe('source guard: App.tsx routes every calculation through the ONE effective equity', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resolve } = require('node:path') as typeof import('node:path');
  const app = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');
  it('the settings gate syncs equity; the queue, ranking, exposure, snapshots and Calculator prefill use rbEff / rkEff', () => {
    expect(app).toMatch(/const \[rb, rk\] = syncAccountEquity\(\[settings, rankerSettings\], \[rbIn, rkIn\]\);/);
    expect(app).toMatch(/rb: rbEff,\s*\n\s*rk: rkEff,/);
    expect(app).toMatch(/conservativeRisk: rkEff\.portfolio\.accountEquity \* rkEff\.portfolio\.riskPerTradePct/);
    expect(app).toMatch(/emptyForm\(rbEff, form\.direction\)/);
    expect(app).toMatch(/inputsFromRecord\(row\.record, .*Date\.now\(\), rbEff\)/);
  });
  it('no calculation reads a stored equity copy directly', () => {
    expect(app).not.toMatch(/rankerSettings\.portfolio\.accountEquity/);
    expect(app).not.toMatch(/settings\.accountEquity/);
    expect(app).not.toMatch(/rankCandidates\([^)]*rankerSettings/);
    expect(app).not.toMatch(/snapshotOf\([^)]*rankerSettings/);
    expect(app).not.toMatch(/(rb: settings|rk: rankerSettings),/);
  });
});
