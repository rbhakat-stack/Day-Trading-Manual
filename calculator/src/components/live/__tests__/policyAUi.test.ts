/**
 * Policy A × the deployed UI (tooltips, reference tiers, PLACE hints, Phase C diagnostics). Real 2026-11-06 records:
 * FTNT 10:30 (RVOL-only), Q 14:40 (RVOL + invalid candle), CTVA (RVOL reproduced). Audited registries are SYNTHETIC.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import FX from '../../../engine/automation/__tests__/rvol-v1-observation-2026-11-06.json';
import FXQ from '../../../engine/automation/__tests__/phase-c-q-2026-11-06.json';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../../../engine/automation/alertDecision';
import { buildQueue, type QueueRow } from '../../../engine/automation/liveQueue';
import { mismatchSummary, scoreView } from '../../../engine/automation/referenceScore';
import { EXPECTED_CONDITIONS, type VerifiedTsConfiguration } from '../../../engine/automation/tsConfigRegistry';
import { v12MaxScore } from '../../../engine/automation/v12/v12Thresholds';
import { cloneRankerDefaults } from '../../../engine/ranker/rankerSettings';
import { KNOWN_CLASSIFICATIONS } from '../../../engine/ranker/correlationRules';
import { RB_V1_DEFAULTS } from '../../../engine/settings';
import type { ReferenceEntry } from '../../../lib/referenceScoreHook';
import { LiveQueuePage, type LiveActions } from '../LiveQueuePage';
import { QueueDetails } from '../QueueParts';
import { placeOrderHint } from '../fieldHelp';
import { presentationFor, queueLayout } from '../queueView';

const RK = cloneRankerDefaults();
const ALL = [...(FX.records as unknown as AutoAlertRecord[]), ...(FXQ.records as unknown as AutoAlertRecord[])];
const rec = (p: string) => structuredClone(ALL.find((r) => r.id.startsWith(p))!) as AutoAlertRecord;
const AUDIT = { auditedAtMs: Date.parse('2026-11-05T05:00:00Z'), validUntilMs: Date.parse('2026-11-20T05:00:00Z'), vwapBasis: 'SESSION' as const, evidence: 'SYNTHETIC', auditedBy: 'TEST', settings: { allConditionsAnd: true, signalTimeframe5m: true, confirmation15mCompletedCandle: true, triggerOnCandleClose: true, extendedHoursOff: true, webhookToRbEndpoint: true } };
const REG: VerifiedTsConfiguration[] = [
  { ...AUDIT, id: 'RBTS-S-001@TEST', ruleSet: 'RBTS-S-001', direction: 'SHORT', alertName: 'RB v1 SHORT Setup', symbols: ['FTNT', 'CTVA'], conditionsAsSaved: EXPECTED_CONDITIONS.SHORT },
  { ...AUDIT, id: 'RBTS-L-001@TEST', ruleSet: 'RBTS-L-001', direction: 'LONG', alertName: 'RB v1 LONG Setup', symbols: ['Q'], conditionsAsSaved: EXPECTED_CONDITIONS.LONG },
];
function rows(records: AutoAlertRecord[], policy: null | { a: true; registry?: VerifiedTsConfiguration[] }): QueueRow[] {
  return records.flatMap((r0) => {
    const r = structuredClone(r0);
    const now = Date.parse(r.processedIso!) + 4_000;
    const quotes: Record<string, LiveQuote> = { [r.alert.symbol]: { ...r.initialQuote!, tradeIso: new Date(now - 1500).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 } };
    return buildQueue({ records: [r], candidates: [], positions: [], quotes, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: RK, classify: (s) => KNOWN_CLASSIFICATIONS[s] ?? { sector: `S-${s}`, industry: `I-${s}`, theme: '' }, parity: {}, strategyVersion: 'RB v1.1', frozen: {}, terminal: {}, rvolPolicy: policy }).rows;
  });
}
const refs = (rs: QueueRow[]) => new Map<string, ReferenceEntry>(rs.map((r) => [r.record.id, { view: scoreView(r), captured: null, mismatch: mismatchSummary(r) }]));
const noop = () => {};
const actions: LiveActions = { submit: noop, skip: noop, watch: noop, openInCalculator: noop, classify: noop, reprocess: noop, keep: noop, replace: noop };
const NOW = Date.parse('2026-11-06T19:41:00Z');
const page = (rs: QueueRow[]) => renderToStaticMarkup(createElement(LiveQueuePage, { rows: rs, suggestions: [], now: NOW, enabled: true, feed: { lastOkMs: NOW, error: null }, quoteError: null, parityStatus: 'NOT VALIDATED', versionLabel: 'RB v1.1', actions, onOpenSettings: noop, shadow: { maxScore: v12MaxScore(RK), optionAGrades: RK.grades, logCount: 0, onExportLog: noop }, referenceScores: refs(rs) }));
const layout = queueLayout(presentationFor('RB v1.1'), { v12MaxScore: v12MaxScore(RK) });
const details = (r: QueueRow) => renderToStaticMarkup(createElement(QueueDetails, { r, now: NOW, actions, layout, maxScore: v12MaxScore(RK), optionAGrades: RK.grades, reference: refs([r]).get(r.record.id) }));
const WARN = 'aria-label="RVOL source difference"';
const RECS = [rec('FTNT-S-1030'), rec('CTVA'), rec('Q-L-144006')];

describe('Policy A OFF / ON with the production (empty) registry: rendered Live Queue identical', () => {
  it('Phase C ON (production): OFF = ON-empty, byte for byte; no ⚠ anywhere', () => {
    const off = page(rows(RECS, null));
    const onEmpty = page(rows(RECS, { a: true }));
    expect(onEmpty).toBe(off);
    expect(off).not.toContain(WARN);
  });
});

describe('Policy A ON with a SYNTHETIC audited registry', () => {
  const rs = rows(RECS, { a: true, registry: REG });
  const ftnt = rs.find((r) => r.record.id.startsWith('FTNT'))!;
  const q = rs.find((r) => r.record.id.startsWith('Q-L-144006'))!;
  it('FTNT RVOL-only: ⚠ in Decision and Data Status (table); authoritative score and five-tier tier; RVOL SOURCE DIFFERENCE still listed', () => {
    expect(ftnt.rvolPolicy).toBeTruthy();
    const h = page(rs);
    expect(h.split(WARN).length - 1).toBe(2); // Decision + Data cells of the one accepted row
    expect(scoreView(ftnt).kind).toBe('SCORED');
    expect(ftnt.ranked!.tier).toBe('SKIP'); // 67 → SKIP (< 75), unchanged classifier
    expect(mismatchSummary(ftnt).label).toBe('1 MISMATCH (SOURCE DIFFERENCE)');
    expect(h.match(/aria-label="About (Score|Tier|Decision|Execution|Final State)"/g)!.length).toBe(5); // header tooltips intact
  });
  it('no PLACE hint: FTNT is below 85 (SKIP); Q is still blocked by the invalid candle', () => {
    expect(placeOrderHint(ftnt)).toBeNull();
    expect(placeOrderHint(q)).toBeNull();
    expect(page(rs)).not.toMatch(/PLACE (BUY|SELL) STOP/);
  });
  it('Q 14:40: not accepted (candle failed) — reference score + reference tier + 2 MISMATCHES, no ⚠', () => {
    expect(q.rvolPolicy).toBeUndefined();
    expect(q.decision.decision).toBe('DATA REVIEW REQUIRED');
    expect(scoreView(q).kind).toBe('REFERENCE');
    expect(mismatchSummary(q).label).toBe('2 MISMATCHES');
    const d = details(q);
    expect(d).toContain('Reference only');
    expect(d).not.toContain(WARN);
  });
  it('expanded FTNT: ⚠ shown, Field-help line above the panel, the decision panel still contains no button', () => {
    const d = details(ftnt);
    expect(d).toContain(WARN);
    expect(d).toContain('data-field-help="primary"');
    const i = d.indexOf('data-decision-panel=');
    const panelStart = d.lastIndexOf('<', i);
    expect(d.indexOf('data-field-help="primary"')).toBeLessThan(panelStart);
    // the panel element: from its start to the comparison strip / next sibling block
    const panel = d.slice(panelStart, d.indexOf('data-comparison=', panelStart) > 0 ? d.indexOf('data-comparison=', panelStart) : undefined);
    expect(panel).not.toMatch(/<button/);
    expect(d).toContain('Audited TrendSpider configuration');
  });
});
