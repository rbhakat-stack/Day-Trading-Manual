import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../../alertDecision';
import type { AlertTimeValues, DataIssue } from '../../alertSnapshot';
import { liveState } from '../../autoCandidate';
import { buildQueue } from '../../liveQueue';
import { etToEpoch } from '../../etTime';
import { DEFAULT_STRATEGY_RULES, rankCandidates, strategyRules } from '../../../ranker/candidateRanker';
import { scoreRvol } from '../../../ranker/opportunityScorer';
import type { Candidate } from '../../../ranker/opportunityTypes';
import { cloneRankerDefaults } from '../../../ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../../settings';
import { recordWith } from '../../__tests__/fixtures';
import { scenarios, TODAY } from '../../../ranker/__tests__/v11RegressionSet';
import golden from '../../../ranker/__tests__/v11-ranker-golden.json';
import { receiptAudit, withReconstruction, type AutoAlertRecordV12 } from '../audit';
import type { RuleSetEntry } from '../ruleSets';
import { RVOL_PROVEN_MIN, shadowRanking, v12Candidate, waivedCalcState } from '../v12Ranking';

/** TEST / HYPOTHETICAL rule sets — the production registry stays EMPTY until the TrendSpider audit. */
const REG: RuleSetEntry[] = [
  { id: 'RBTS-L-901', direction: 'LONG', rulesVersion: 'RB v1.2', audited: 'TEST', checklistRef: 'TEST/HYPOTHETICAL', active: true, rules: ['TEST'] },
  { id: 'RBTS-S-901', direction: 'SHORT', rulesVersion: 'RB v1.2', audited: 'TEST', checklistRef: 'TEST/HYPOTHETICAL', active: true, rules: ['TEST'] },
];
const RK = cloneRankerDefaults();
const W = DEFAULT_STRATEGY_RULES;
const FIVE = 300_000;
const SECTORS: Record<string, string> = { VRSK: 'Data', IBM: 'IT', NEE: 'Utilities', MSFT: 'Software', GM: 'Autos', AAA: 'Tech' };

function rec(o: { symbol: string; direction?: 'LONG' | 'SHORT'; closeEt: string; values?: Partial<AlertTimeValues>; price?: number; issues?: DataIssue[]; ruleSet?: string | null; lagSec?: number }): AutoAlertRecordV12 {
  const direction = o.direction ?? 'LONG';
  const end = etToEpoch(TODAY, o.closeEt);
  const receivedMs = end + (o.lagSec ?? 12) * 1000;
  const r = recordWith({ symbol: o.symbol, direction, alertIso: new Date(receivedMs).toISOString(), receivedMs, values: o.values ?? {}, price: o.price, issues: o.issues });
  r.alert.timeSource = 'RECEIVED';
  r.snapshot!.signal = { startIso: new Date(end - FIVE).toISOString(), endIso: new Date(end).toISOString(), label: '' };
  const body = o.ruleSet === undefined ? { rule_set: direction === 'LONG' ? 'RBTS-L-901' : 'RBTS-S-901' } : o.ruleSet === null ? {} : { rule_set: o.ruleSet };
  return { ...r, v12: withReconstruction(receiptAudit({ body, symbol: o.symbol, direction, receivedMs, v11Key: r.dedupeKey, registry: REG }), r, [], direction, DEFAULT_AUTOMATION.parity) };
}
const quote = (price: number, now: number): LiveQuote => ({ price, tradeIso: new Date(now - 1000).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 });
function queue(records: AutoAlertRecord[], now: number) {
  const quotes: Record<string, LiveQuote> = {};
  for (const r of records) quotes[r.alert.symbol] = quote(r.initialQuote!.price, now);
  return buildQueue({ records, candidates: [], positions: [], quotes, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: RK, classify: (s) => (SECTORS[s] ? { sector: SECTORS[s], industry: SECTORS[s], theme: '' } : null), parity: {}, strategyVersion: 'RB v1.1' });
}
const rowOf = (r: AutoAlertRecordV12) => queue([r], r.receivedMs + 30_000).rows[0];
const qualified = (c: Candidate): Candidate => ({ ...c, qualification: { source: 'TRENDSPIDER', ruleSet: 'RBTS-L-901', rvolProvenMin: RVOL_PROVEN_MIN, waivedRules: [] } });
const VRSK: Partial<AlertTimeValues> = { open: 196.35, high: 196.55, low: 196.2, close: 196.535, atr: 0.3914, ema9: 196.2868, ema20: 196.0679, rsi: 59.58, rvol: 1.413, vwap: 196.43096, close15m: 196.537, ema20_15m: 194.1874 };
const NOT_REPRODUCED: DataIssue = { kind: 'REVIEW', code: 'ALERT_NOT_REPRODUCED', message: 'RVOL20 > 1.5 not reproduced' };

describe('(1) RB v1.1 ranker output is byte-for-byte unchanged', () => {
  const G = golden as { generatedFrom: string; scenarios: Record<string, { sha256: string; rows: unknown[] }> };
  for (const sc of scenarios()) {
    it(`identical to the pre-step-6 ranker: ${sc.name}`, () => {
      const r = rankCandidates(sc.candidates, sc.positions, sc.s, TODAY, sc.w);
      const g = G.scenarios[sc.name];
      expect(g, 'scenario missing from golden').toBeTruthy();
      expect(r.ranked.map((x) => ({ id: x.candidate.id, total: x.total, tier: x.tier, rank: x.rank, recommendation: x.recommendation, rvol: x.components.find((k) => k.key === 'rvol')?.points ?? null, fails: x.hardFails.map((f) => f.code) }))).toEqual(g.rows);
      expect(createHash('sha256').update(JSON.stringify(r)).digest('hex')).toBe(g.sha256);
    });
  }
  it('the golden covers scores, tiers, thresholds and every hard-rule family incl. candle direction and 15m', () => {
    const all = Object.values(G.scenarios).flatMap((s) => s.rows as { total: number | null; tier: string | null; fails: string[] }[]);
    expect(new Set(all.map((x) => x.tier))).toEqual(new Set(['ELITE', 'HIGH_PRIORITY', 'WATCHLIST', 'LOW_PRIORITY', 'SKIP', null]));
    for (const code of ['INVALID_CANDLE_DIRECTION', 'HTF_CONFIRMATION_FAILED', 'OUTSIDE_ENTRY_WINDOW', 'CHASED_SETUP', 'STALE_SETUP']) expect(all.some((x) => x.fails.includes(code)), code).toBe(true);
    expect(G.generatedFrom).toMatch(/dd74339/);
  });
});

describe('(2)–(4) v1.2 QUALIFIED_FLOOR: exactly 6/15, independent of SIP RVOL', () => {
  const base = scenarios().find((s) => s.name === 'LONG rvol 2.2')!.candidates[0];
  it.each([[1.0], [1.413], [2.2], [5.0], [Number.NaN]])('SIP RVOL %s → RVOL component 6 (v1.1 bands would differ)', (sip) => {
    const c = qualified({ ...base, inputs: { ...base.inputs, rvol: sip } });
    expect(scoreRvol(c, RK).points).toBe(6);
    expect(scoreRvol(c, RK).summary).toMatch(/QUALIFIED_FLOOR/);
  });
  it('v1.1 (no qualification) keeps the bands: 1.0 → 0, 5.0 → 15', () => {
    expect(scoreRvol({ ...base, inputs: { ...base.inputs, rvol: 1.0 } }, RK).points).toBe(0);
    expect(scoreRvol({ ...base, inputs: { ...base.inputs, rvol: 5.0 } }, RK).points).toBe(15);
  });
  it('a missing SIP RVOL is not a required input for a qualified candidate (it is for v1.1)', () => {
    const missingRvol = { ...base, inputs: { ...base.inputs, rvol: Number.NaN } };
    expect(rankCandidates([missingRvol], [], RK, TODAY, W).ranked[0].missing).toContain('RVOL(20)');
    expect(rankCandidates([qualified(missingRvol)], [], RK, TODAY, W).ranked[0].missing).not.toContain('RVOL(20)');
  });
});

describe('(5)–(7) candle direction and 15m: TrendSpider-owned in v1.2, hard rules in v1.1', () => {
  const red = scenarios().find((s) => s.name === 'LONG SIP candle red (INVALID_CANDLE_DIRECTION)')!.candidates[0];
  const htf = scenarios().find((s) => s.name === 'LONG SIP 15m below EMA20 (HTF_CONFIRMATION_FAILED)')!.candidates[0];
  const pf = (c: Candidate) => rankCandidates([c], [], RK, TODAY, W).ranked[0];
  it('(7) v1.1 still hard-fails both exactly as before', () => {
    expect(pf(red).hardFails.map((f) => f.code)).toContain('INVALID_CANDLE_DIRECTION');
    expect(pf(htf).hardFails.map((f) => f.code)).toContain('HTF_CONFIRMATION_FAILED');
    expect(pf(red).total).toBeNull();
  });
  it('(5) v1.2 candle-direction disagreement does not hard-fail; the rule detail keeps the SIP diagnostic', () => {
    const rule = strategyRules(qualified(red), rankCandidates([], [], RK, TODAY, W).portfolio, W).find((r) => r.key === 'candle')!;
    expect(rule.pass).toBe(true);
    expect(rule.detail).toMatch(/TrendSpider-qualified .* SIP check differs/);
  });
  it('(6) v1.2 15m disagreement does not hard-fail', () => {
    const rule = strategyRules(qualified(htf), rankCandidates([], [], RK, TODAY, W).portfolio, W).find((r) => r.key === 'htf')!;
    expect(rule.pass).toBe(true);
    expect(rule.detail).toMatch(/SIP check differs/);
  });
  it('end to end: the v1.2 copy (waived calculator state) is scored, the v1.1 candidate is not', () => {
    const r = rec({ symbol: 'GM', closeEt: '11:00', values: { open: 101.2, close: 100.6, high: 101.3, low: 100.4, close15m: 99, ema20_15m: 100 }, price: 100.9 });
    const row = rowOf(r);
    expect(row.ranked?.total).toBeNull();
    expect(row.shadow?.score?.total).not.toBeNull();
    expect(row.shadow?.score?.waivedRules.sort()).toEqual(['HTF_CONFIRMATION_FAILED', 'INVALID_CANDLE_DIRECTION']);
  });
});

describe('waived calculator state mirrors evaluateTrade branches (plan unchanged)', () => {
  const mk = (values: Partial<AlertTimeValues>, price: number, ageMin = 1) => {
    const r = recordWith({ symbol: 'AAA', direction: 'LONG', alertIso: `${TODAY}T10:15:04-04:00`, values, price });
    return liveState(r, price, Date.parse(`${TODAY}T10:15:04-04:00`) + ageMin * 60_000, RB_V1_DEFAULTS)!;
  };
  const RED = { open: 101.2, close: 100.6, high: 101.3, low: 100.4 };
  it('no waived rule → identical to the calculator', () => {
    const r = mk({}, 100.95);
    expect(waivedCalcState(r, 'LONG')).toEqual({ calcAction: r.action, calcReady: r.ready, calcHardFails: r.hardFails, waived: [] });
  });
  it('only waived rules, not crossed → BUY_STOP, ready', () => expect(waivedCalcState(mk(RED, 100.9), 'LONG')).toMatchObject({ calcAction: 'BUY_STOP', calcReady: true, calcHardFails: [], waived: ['INVALID_CANDLE_DIRECTION'] }));
  it('only waived rules, crossed within the chase limit → MARKET_LATE_ENTRY, not ready', () => expect(waivedCalcState(mk(RED, 101.4), 'LONG')).toMatchObject({ calcAction: 'MARKET_LATE_ENTRY', calcReady: false, calcHardFails: [] }));
  it('waived + a real fail (stale) → not ready, real fail kept first', () => {
    const w = waivedCalcState(mk(RED, 100.9, 12), 'LONG');
    expect(w.calcReady).toBe(false);
    expect(w.calcHardFails.map((f) => f.code)).toEqual(['STALE_SETUP']);
  });
  it('v12Candidate never changes geometry', () => {
    const r = rec({ symbol: 'AAA', closeEt: '10:15', values: RED, price: 100.9 });
    const row = rowOf(r);
    const c12 = v12Candidate(row.candidate!, row.live!, r.v12!);
    expect([c12.entry, c12.stop, c12.target, c12.shares]).toEqual([row.candidate!.entry, row.candidate!.stop, row.candidate!.target, row.candidate!.shares]);
  });
});

describe('(8)–(10) eligibility for the v1.2 pool and scoring-mode dispatch', () => {
  it('(8) missing / unknown rule set never enters the v1.2 ranking', () => {
    for (const ruleSet of [null, 'RBTS-L-001', 'RBTS-L-777']) {
      const row = rowOf(rec({ symbol: 'AAA', closeEt: '10:15', price: 100.95, ruleSet }));
      expect(row.shadow?.decision).toBe('NOT QUALIFIED');
      expect(row.shadow?.score).toBeNull();
    }
  });
  it('(8) shadowRanking excludes automated pool candidates that are not in the qualified pool', () => {
    const r = rec({ symbol: 'AAA', closeEt: '10:15', price: 100.95 });
    const row = rowOf(r);
    const out = shadowRanking({ candidates: [row.candidate!], poolIds: new Set(), lives: new Map([[r.id, row.live]]), audits: new Map([[r.id, r.v12!]]), positions: [], rk: RK, today: TODAY, window: W });
    expect(out.ranking.ranked).toEqual([]);
  });
  it('(9) SIP-only data cannot produce a v1.2 candidate: no record → nothing; a pool id without audit/live → nothing', () => {
    expect(queue([], etToEpoch(TODAY, '15:05:30')).rows).toEqual([]);
    const c = scenarios().find((s) => s.name === 'LONG rvol 2.2')!.candidates[0];
    const out = shadowRanking({ candidates: [c], poolIds: new Set([c.id]), lives: new Map(), audits: new Map(), positions: [], rk: RK, today: TODAY, window: W });
    expect(out.ranking.ranked).toEqual([]);
  });
  it('(10) dispatch: v1.1 candidates score with BANDS; only v1.2 shadow copies use QUALIFIED_FLOOR; persisted candidates never carry v1.2 state', () => {
    const r = rec({ symbol: 'AAA', closeEt: '10:15', price: 100.95, values: { rvol: 4 } });
    const out = queue([r], r.receivedMs + 30_000);
    const row = out.rows[0];
    expect(row.ranked!.components.find((k) => k.key === 'rvol')?.points).toBe(15); // v1.1 bands
    expect(row.shadow!.score?.rvolPoints).toBe(6); // v1.2 floor
    expect(out.candidates.every((c) => c.qualification === undefined)).toBe(true);
    expect(row.candidate!.qualification).toBeUndefined();
  });
});

describe('regression cases (TEST rule sets)', () => {
  it('VRSK 12:25 LONG: v1.1 data mismatch / unscored for allocation; v1.2 scored with the 6/15 floor', () => {
    const row = rowOf(rec({ symbol: 'VRSK', closeEt: '12:30', values: VRSK, price: 196.5, issues: [NOT_REPRODUCED] }));
    expect(row.decision.decision).toBe('DATA REVIEW REQUIRED');
    expect(row.shadow?.scoring).toBe('V12_RANKING');
    expect(row.shadow?.score?.rvolPoints).toBe(6);
    expect(row.ranked?.components.find((k) => k.key === 'rvol')?.points).toBe(0); // SIP 1.413 below the 1.5 band in v1.1
  });
  it('corrected MSFT 13:35 (SIP 1.946 → v1.1 band 6 = floor 6): identical totals', () => {
    const row = rowOf(rec({ symbol: 'MSFT', closeEt: '13:40', values: { rvol: 1.946 }, price: 100.95 }));
    expect(row.shadow?.score?.total).toBe(row.ranked?.total);
  });
  it.each([['IBM', 'LONG', '15:55'], ['NEE', 'SHORT', '15:45']] as const)('%s late alert: never reaches scoring in either version (entry window)', (symbol, direction, closeEt) => {
    const values: Partial<AlertTimeValues> = direction === 'SHORT' ? { open: 101, high: 101, low: 100, close: 100, ema9: 100.1, ema20: 100.7, vwap: 100.6, rsi: 35, close15m: 100, ema20_15m: 101 } : {};
    const row = rowOf(rec({ symbol, direction, closeEt, values, price: direction === 'SHORT' ? 100.05 : 100.95 }));
    expect(row.shadow?.decision).toBe('NOT ELIGIBLE');
    expect(row.shadow?.score).toBeNull();
    expect(row.ranked?.total ?? null).toBeNull();
  });
});
