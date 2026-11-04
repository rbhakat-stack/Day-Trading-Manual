/**
 * SYNTHETIC fixtures (clearly not market observations): deterministic records built with the existing test helper.
 * LONG: entry 101.02, stop 100.00, ATR 1 → chase limit 101.27. Used only where no historical record exercises a rule.
 */
import { DEFAULT_AUTOMATION, type AutoAlertRecord } from '../../engine/automation/alertDecision';
import { recordWith } from '../../engine/automation/__tests__/fixtures';
import { receiptAudit, withReconstruction, type AutoAlertRecordV12 } from '../../engine/automation/v12/audit';
import type { RuleSetEntry } from '../../engine/automation/v12/ruleSets';
import { synthQuote, type Step } from './harness';

export const ALERT = '2026-10-30T10:15:04-04:00';
export const T0 = Date.parse(ALERT);
export const at = (min: number) => T0 + min * 60_000;

const REG: RuleSetEntry[] = [
  { id: 'RBTS-L-TEST', direction: 'LONG', rulesVersion: 'RB v1.2', audited: 'TEST', checklistRef: 'TEST', active: true, rules: ['TEST'] },
  { id: 'RBTS-S-TEST', direction: 'SHORT', rulesVersion: 'RB v1.2', audited: 'TEST', checklistRef: 'TEST', active: true, rules: ['TEST'] },
];

export function withV12(r: AutoAlertRecord): AutoAlertRecordV12 {
  const end = Date.parse('2026-10-30T10:15:00-04:00');
  if (r.snapshot) r.snapshot.signal = { startIso: new Date(end - 300_000).toISOString(), endIso: new Date(end).toISOString(), label: '10:10–10:15' };
  const a = receiptAudit({ body: { rule_set: r.alert.direction === 'LONG' ? 'RBTS-L-TEST' : 'RBTS-S-TEST' }, symbol: r.alert.symbol, direction: r.alert.direction, receivedMs: r.receivedMs, v11Key: r.dedupeKey, registry: REG });
  return { ...r, v12: withReconstruction(a, r, [], r.alert.direction, DEFAULT_AUTOMATION.parity, null) };
}

export const LONG = (o: Partial<Parameters<typeof recordWith>[0]> = {}) => withV12(recordWith({ symbol: 'AAA', direction: 'LONG', alertIso: ALERT, price: 100.95, values: {}, ...o }));

/** Steps at `minutes` after the alert with a fresh synthetic quote for symbol `sym` (null = no quote at all). */
export const steps = (sym: string, pts: [number, number | null, { ageMs?: number; tradeAgeMs?: number }?][]): Step[] =>
  pts.map(([m, p, q]) => ({ now: at(m), quotes: p === null ? {} : { [sym]: synthQuote(p, at(m), q?.ageMs, q?.tradeAgeMs) } }));
