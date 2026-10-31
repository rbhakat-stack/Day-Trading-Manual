import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, type LiveQuote } from '../../alertDecision';
import { buildQueue } from '../../liveQueue';
import { etToEpoch } from '../../etTime';
import { recordWith } from '../../__tests__/fixtures';
import { cloneRankerDefaults } from '../../../ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../../settings';
import { receiptAudit, withReconstruction, type AutoAlertRecordV12 } from '../audit';
import type { RuleSetEntry } from '../ruleSets';
import { freezeShadowScores, shadowLogCsv } from '../shadowLog';

/** TEST / HYPOTHETICAL rule set only. */
const REG: RuleSetEntry[] = [{ id: 'RBTS-L-901', direction: 'LONG', rulesVersion: 'RB v1.2', audited: 'TEST', checklistRef: 'TEST/HYPOTHETICAL', active: true, rules: ['TEST'] }];
function rec(symbol: string, closeEt: string, values: Record<string, number>, ruleSet: string | null = 'RBTS-L-901'): AutoAlertRecordV12 {
  const end = etToEpoch('2026-10-30', closeEt);
  const rm = end + 12_000;
  const r = recordWith({ symbol, direction: 'LONG', alertIso: new Date(rm).toISOString(), receivedMs: rm, values: { rvol: 1.6, ...values }, price: 100.95 });
  r.alert.timeSource = 'RECEIVED';
  r.snapshot!.signal = { startIso: new Date(end - 300_000).toISOString(), endIso: new Date(end).toISOString(), label: '' };
  return { ...r, v12: withReconstruction(receiptAudit({ body: ruleSet ? { rule_set: ruleSet } : {}, symbol, direction: 'LONG', receivedMs: rm, v11Key: r.dedupeKey, registry: REG }), r, [], 'LONG', DEFAULT_AUTOMATION.parity) };
}
function rows(records: AutoAlertRecordV12[], now: number) {
  const quotes: Record<string, LiveQuote> = {};
  for (const r of records) quotes[r.alert.symbol] = { price: 100.95, tradeIso: new Date(now - 1000).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 };
  return buildQueue({ records, candidates: [], positions: [], quotes, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify: (s) => ({ sector: s, industry: s, theme: '' }), parity: {}, strategyVersion: 'RB v1.1' }).rows;
}

describe('v1.2 shadow comparison log (A/B retained for calibration)', () => {
  const a = rec('NVDA', '10:15', { rsi: 78 });
  const b = rec('AMD', '10:15', { rsi: 52 });
  const unq = rec('GM', '10:15', {}, null);
  const now = a.receivedMs + 30_000;
  it('records raw score, Option B tier, Option A tier, v1.1 score and delta for every v1.2-scored alert only', () => {
    const { log, changed } = freezeShadowScores({}, rows([a, b, unq], now), now);
    expect(changed).toBe(true);
    expect(Object.keys(log).sort()).toEqual([a.id, b.id].sort()); // the unqualified record has no v1.2 score
    expect(log[a.id]).toMatchObject({ v12Total: 81, tierOptionB: 'HIGH_PRIORITY', tierOptionA: 'WATCHLIST', thresholdsB: '82/78/73/69', thresholdsA: '90/85/80/75', v11Total: 81, v11Tier: 'WATCHLIST', deltaVsV11: 0, ruleSet: 'RBTS-L-901', qualification: 'QUALIFIED', mapping: 'ON_TIME' });
    expect(log[b.id]).toMatchObject({ v12Total: 77, tierOptionB: 'WATCHLIST', tierOptionA: 'LOW_PRIORITY' });
  });
  it('is frozen: a later pass never rewrites an entry; unchanged log keeps identity', () => {
    const first = freezeShadowScores({}, rows([a], now), now).log;
    const later = freezeShadowScores(first, rows([a], now + 60_000), now + 60_000);
    expect(later.changed).toBe(false);
    expect(later.log).toBe(first);
    expect(later.log[a.id].scoredAtMs).toBe(now);
  });
  it('CSV export has one row per entry with the comparison columns', () => {
    const csv = shadowLogCsv(freezeShadowScores({}, rows([a, b], now), now).log).trim().split('\n');
    expect(csv[0]).toContain('v12Total,tierOptionB,tierOptionA,thresholdsB,thresholdsA,v11Total,v11Tier,deltaVsV11');
    expect(csv).toHaveLength(3);
  });
});
