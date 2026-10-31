/**
 * Fixed candidate scenarios for the RB v1.1 ranker byte-for-byte regression (Phase 3B step 6).
 * `v11-ranker-golden.json` holds rankCandidates() output for these scenarios produced by the ranker BEFORE the v1.2
 * changes (commit dd74339); the test requires the current ranker to reproduce it exactly for v1.1 candidates.
 * Not a test file itself (no `.test.ts`), so it can also be imported by the one-off golden generator.
 */
import { DEFAULT_STRATEGY_RULES, type StrategyRules } from '../candidateRanker';
import type { Candidate, ManualPosition } from '../opportunityTypes';
import { cloneRankerDefaults, type RankerSettings } from '../rankerSettings';
import { sampleDay } from '../rankerSamples';
import { RB_V1_DEFAULTS } from '../../settings';
import { candidateFromRecord } from '../../automation/autoCandidate';
import type { AlertTimeValues } from '../../automation/alertSnapshot';
import { recordWith } from '../../automation/__tests__/fixtures';

export const TODAY = '2026-10-30';
export interface Scenario { name: string; candidates: Candidate[]; positions: ManualPosition[]; s: RankerSettings; w: StrategyRules }

const CLS: Record<string, { sector: string; industry: string; theme: string }> = {
  AAA: { sector: 'Tech', industry: 'Semis', theme: 'AI' }, BBB: { sector: 'Autos', industry: 'Autos', theme: '' }, CCC: { sector: 'Health', industry: 'Pharma', theme: '' },
  DDD: { sector: 'Tech', industry: 'Semis', theme: 'AI' }, EEE: { sector: 'Energy', industry: 'Oil', theme: '' }, FFF: { sector: 'Utilities', industry: 'Power', theme: '' },
};

function auto(o: { symbol: string; direction?: 'LONG' | 'SHORT'; time?: string; values?: Partial<AlertTimeValues>; price?: number; ageMin?: number; noClass?: boolean }): Candidate {
  const alertIso = `${TODAY}T${o.time ?? '10:15'}:04-04:00`;
  const rec = recordWith({ symbol: o.symbol, direction: o.direction ?? 'LONG', alertIso, values: o.values ?? {}, price: o.price });
  const now = Date.parse(alertIso) + (o.ageMin ?? 1) * 60_000;
  const c = candidateFromRecord(rec, o.price ?? rec.initialQuote!.price, now, RB_V1_DEFAULTS, o.noClass ? null : CLS[o.symbol] ?? null);
  if (!c) throw new Error(`no candidate for ${o.symbol}`);
  return c;
}

const SHORT_OK: Partial<AlertTimeValues> = { open: 101, high: 101, low: 100, close: 100, ema9: 100.1, ema20: 100.7, vwap: 100.6, rsi: 35, close15m: 100, ema20_15m: 101, rvol: 2.2 };

export function scenarios(): Scenario[] {
  const s = cloneRankerDefaults();
  const w = DEFAULT_STRATEGY_RULES;
  const one = (name: string, c: Candidate): Scenario => ({ name, candidates: [c], positions: [], s, w });
  const out: Scenario[] = [];
  const sample = sampleDay(TODAY, '2026-10-29', s);
  out.push({ name: 'ranker sample day (manual candidates + positions)', candidates: sample.candidates, positions: sample.positions, s, w });
  for (const rvol of [Number.NaN, 0.8, 1.49, 1.5, 1.6, 2.0, 2.2, 2.5, 3.0, 3.5, 5.0]) out.push(one(`LONG rvol ${rvol}`, auto({ symbol: 'AAA', values: { rvol }, price: 100.95 })));
  out.push(one('LONG SIP candle red (INVALID_CANDLE_DIRECTION)', auto({ symbol: 'AAA', values: { open: 101.2, close: 100.6, high: 101.3, low: 100.4 }, price: 100.9 })));
  out.push(one('LONG SIP 15m below EMA20 (HTF_CONFIRMATION_FAILED)', auto({ symbol: 'AAA', values: { close15m: 99, ema20_15m: 100 }, price: 100.95 })));
  out.push(one('LONG candle + 15m both fail', auto({ symbol: 'AAA', values: { open: 101.2, close: 100.6, high: 101.3, low: 100.4, close15m: 99, ema20_15m: 100 }, price: 100.9 })));
  out.push(one('LONG weak RSI / VWAP / EMA', auto({ symbol: 'AAA', values: { rsi: 52, vwap: 101.4, ema9: 100.0, ema20: 100.2 }, price: 100.95 })));
  out.push(one('LONG trigger crossed (late entry)', auto({ symbol: 'AAA', price: 101.1 })));
  out.push(one('LONG chased', auto({ symbol: 'AAA', price: 102.5 })));
  out.push(one('LONG stale (12 min)', auto({ symbol: 'AAA', price: 100.95, ageMin: 12 })));
  out.push(one('LONG after entry window (15:40)', auto({ symbol: 'AAA', time: '15:40', price: 100.95 })));
  out.push(one('LONG missing classification', auto({ symbol: 'AAA', price: 100.95, noClass: true })));
  out.push(one('SHORT ok', auto({ symbol: 'EEE', direction: 'SHORT', values: SHORT_OK, price: 100.05 })));
  out.push(one('SHORT SIP candle green', auto({ symbol: 'EEE', direction: 'SHORT', values: { ...SHORT_OK, open: 100, close: 100.6, high: 101, low: 99.9 }, price: 100.5 })));
  out.push({
    name: 'mixed pool (allocation, correlation, ties)', positions: [], s, w,
    candidates: [
      auto({ symbol: 'AAA', price: 100.95, values: { rvol: 4 } }),
      auto({ symbol: 'DDD', price: 100.95, values: { rvol: 2.2 } }),
      auto({ symbol: 'BBB', price: 100.95, values: { rvol: 1.6 } }),
      auto({ symbol: 'CCC', price: 100.95, values: { rvol: 3.0, open: 101.2, close: 100.6, high: 101.3, low: 100.4 } }),
      auto({ symbol: 'EEE', direction: 'SHORT', values: SHORT_OK, price: 100.05 }),
      auto({ symbol: 'FFF', price: 100.95, values: { rvol: 1.5, close15m: 99, ema20_15m: 100 } }),
    ],
  });
  return out;
}
