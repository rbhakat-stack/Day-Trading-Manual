/**
 * Policy A × verified TrendSpider configuration (fail closed) and preservation of production / Phase C behaviour.
 * Real 2026-11-06 production records (FTNT 10:30, CARR 11:05 RVOL-only; CTVA / Q 12:30 RVOL passed; Q 14:40 RVOL + candle).
 * Variants are SYNTHETIC and labelled.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import FX from './rvol-v1-observation-2026-11-06.json';
import FXQ from './phase-c-q-2026-11-06.json';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../alertDecision';
import { buildQueue, type QueueInput, type QueueOutput, type QueueRow } from '../liveQueue';
import { prepareRvolPolicy } from '../rvolPolicy';
import { checkConfiguration, entryProblems, EXPECTED_CONDITIONS, VERIFIED_TS_CONFIGURATIONS, type VerifiedTsConfiguration } from '../tsConfigRegistry';
import { mismatchSummary, scoreView } from '../referenceScore';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../../settings';
import { KNOWN_CLASSIFICATIONS } from '../../ranker/correlationRules';
import type { ManualPosition } from '../../ranker/opportunityTypes';

const ALL = [...(FX.records as unknown as AutoAlertRecord[]), ...(FXQ.records as unknown as AutoAlertRecord[])];
const rec = (p: string) => structuredClone(ALL.find((r) => r.id.startsWith(p))!) as AutoAlertRecord;
const classify = (s: string) => KNOWN_CLASSIFICATIONS[s] ?? { sector: `Sector-${s}`, industry: `Industry-${s}`, theme: '' };
const AUDIT = { auditedAtMs: Date.parse('2026-11-05T05:00:00Z'), validUntilMs: Date.parse('2026-11-20T05:00:00Z'), vwapBasis: 'SESSION' as const, evidence: 'SYNTHETIC', auditedBy: 'TEST', settings: { allConditionsAnd: true, signalTimeframe5m: true, confirmation15mCompletedCandle: true, triggerOnCandleClose: true, extendedHoursOff: true, webhookToRbEndpoint: true } };
const S: VerifiedTsConfiguration = { ...AUDIT, id: 'RBTS-S-001@TEST', ruleSet: 'RBTS-S-001', direction: 'SHORT', alertName: 'RB v1 SHORT Setup', symbols: ['FTNT', 'CARR', 'CTVA'], conditionsAsSaved: EXPECTED_CONDITIONS.SHORT };
const L: VerifiedTsConfiguration = { ...AUDIT, id: 'RBTS-L-001@TEST', ruleSet: 'RBTS-L-001', direction: 'LONG', alertName: 'RB v1 LONG Setup', symbols: ['Q'], conditionsAsSaved: EXPECTED_CONDITIONS.LONG };
const REG = [S, L];

function input(records: AutoAlertRecord[], o: { a?: boolean; registry?: readonly VerifiedTsConfiguration[] | 'PRODUCTION'; now?: number; positions?: ManualPosition[]; candidates?: QueueInput['candidates'] } = {}): QueueInput {
  const now = o.now ?? Math.max(...records.map((r) => Date.parse(r.processedIso ?? r.receivedIso))) + 4_000;
  const quotes: Record<string, LiveQuote> = {};
  for (const r of records) if (r.initialQuote) quotes[r.alert.symbol] = { ...r.initialQuote, tradeIso: new Date(now - 1500).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 };
  const rvolPolicy = !o.a ? null : o.registry === 'PRODUCTION' ? { a: true } : { a: true, registry: o.registry ?? REG };
  return { records, candidates: o.candidates ?? [], positions: o.positions ?? [], quotes, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify, parity: {}, strategyVersion: 'RB v1.1', frozen: {}, terminal: {}, rvolPolicy };
}
const row = (o: QueueOutput, id: string) => o.rows.find((r) => r.record.id === id)!;
const auth = (r: QueueRow) => JSON.stringify([r.decision, r.ranked, r.candidate, r.live, r.lifecycle, r.blocked ?? null, r.shadow]);
const accepted = (r: AutoAlertRecord, registry: readonly VerifiedTsConfiguration[] = REG) => prepareRvolPolicy([r], { a: true, registry }, {})!.accepted.size === 1;
/** SYNTHETIC twin: the same alert as if RB's SIP RVOL condition had reproduced (only the condition flag / review issue differ). */
function rvolPassedTwin(r: AutoAlertRecord): AutoAlertRecord {
  const t = structuredClone(r);
  t.snapshot!.alertConditions = t.snapshot!.alertConditions.map((c) => (c.label === 'RVOL20 > 1.5' ? { ...c, pass: true } : c));
  t.snapshot!.issues = t.snapshot!.issues.filter((i) => i.code !== 'ALERT_NOT_REPRODUCED');
  return t;
}

describe('fail closed: the production registry is EMPTY', () => {
  it('release gate: VERIFIED_TS_CONFIGURATIONS is empty in this release candidate', () => {
    expect(VERIFIED_TS_CONFIGURATIONS).toEqual([]);
  });
  it('Policy A ON with the production registry → authoritative output identical to OFF on every fixture alert', () => {
    const recs = ALL.map((r) => structuredClone(r));
    for (const r of recs) {
      const off = row(buildQueue(input([r])), r.id);
      const on = row(buildQueue(input([r], { a: true, registry: 'PRODUCTION' })), r.id);
      expect(auth(on)).toBe(auth(off));
      expect(on.rvolPolicy).toBeUndefined();
    }
  });
  it('App never supplies a registry (source guard): production always uses the code-reviewed registry', () => {
    const app = readFileSync(join(__dirname, '..', '..', '..', 'App.tsx'), 'utf8');
    expect(app).toMatch(/rvolPolicy: rvolPolicyA \? \{ a: true \} : null/);
    expect(app).not.toMatch(/registry/);
  });
});

describe('configuration identity (a label is never proof)', () => {
  it('validated RVOL-only FTNT with an audited configuration → accepted; configuration recorded', () => {
    const r = rec('FTNT-S-1030');
    expect(checkConfiguration(r, REG)).toMatchObject({ pass: true, configId: 'RBTS-S-001@TEST' });
    expect(accepted(r)).toBe(true);
  });
  it('missing rule_set (e.g. HIG / KKR / SWKS / HCA notes) → not accepted', () => {
    const r = rec('FTNT-S-1030'); delete (r.payload as Record<string, unknown>).rule_set;
    expect(checkConfiguration(r, REG).pass).toBe(false);
    expect(accepted(r)).toBe(false);
  });
  it('contradictory LONG label on a SHORT alert → not accepted', () => {
    const r = rec('FTNT-S-1030'); (r.payload as Record<string, unknown>).rule_set = 'RBTS-L-001';
    expect(accepted(r)).toBe(false);
  });
  it('a manually typed config id in the note is ignored; an unknown rule_set is not accepted', () => {
    const r = rec('FTNT-S-1030'); Object.assign(r.payload as Record<string, unknown>, { rule_set: 'RBTS-S-999', config_id: 'RBTS-S-001@TEST' });
    expect(accepted(r)).toBe(false);
  });
  it('symbol not covered by the audited configuration → not accepted', () => {
    expect(accepted(rec('FTNT-S-1030'), [{ ...S, symbols: ['CARR'] }])).toBe(false);
  });
  it('alert name differs from the audited alert → not accepted', () => {
    const r = rec('FTNT-S-1030'); r.alert.alertName = 'RB v1 SHORT Setup (copy)';
    expect(accepted(r)).toBe(false);
  });
  it('alert before the audit, or after the validity window (possible edit after audit) → not accepted', () => {
    const r = rec('FTNT-S-1030');
    expect(accepted(r, [{ ...S, auditedAtMs: r.alert.alertTimeMs + 1, validUntilMs: r.alert.alertTimeMs + 86_400_000 }])).toBe(false);
    expect(accepted(r, [{ ...S, auditedAtMs: r.alert.alertTimeMs - 86_400_000, validUntilMs: r.alert.alertTimeMs - 1 }])).toBe(false);
  });
  it('malformed / unverified registry entries are ignored entirely', () => {
    const bad: VerifiedTsConfiguration[] = [
      { ...S, conditionsAsSaved: EXPECTED_CONDITIONS.SHORT.map((c) => c.replace('> 1.5', '> 1.0')) },
      { ...S, conditionsAsSaved: EXPECTED_CONDITIONS.SHORT.slice(0, 5) },
      { ...S, vwapBasis: 'OTHER' },
      { ...S, settings: { ...S.settings, extendedHoursOff: false } },
      { ...S, settings: { ...S.settings, triggerOnCandleClose: false } },
      { ...S, symbols: ['*'] },
      { ...S, validUntilMs: S.auditedAtMs + 31 * 86_400_000 },
      { ...S, evidence: ' ' },
    ];
    for (const e of bad) { expect(entryProblems(e).length).toBeGreaterThan(0); expect(accepted(rec('FTNT-S-1030'), [e])).toBe(false); }
    expect(entryProblems(S)).toEqual([]);
  });
});

describe('Policy A applies to RVOL-only discrepancies only', () => {
  it('RVOL agreement (CTVA / Q 12:30 reproduced RVOL) → not applicable; output identical to OFF', () => {
    for (const p of ['CTVA', 'Q-L-1230']) {
      const r = rec(p);
      expect(auth(row(buildQueue(input([r], { a: true })), r.id))).toBe(auth(row(buildQueue(input([r])), r.id)));
    }
  });
  it('Q LONG 14:40:06 (RVOL + invalid candle): Policy A ON keeps DATA REVIEW, the hard rule, no ticket, same plan; Phase C reference + 2 mismatches unchanged', () => {
    const r = rec('Q-L-144006');
    const off = row(buildQueue(input([r])), r.id);
    const on = row(buildQueue(input([r], { a: true })), r.id);
    expect(accepted(r)).toBe(false); // the audited registry covers Q LONG, yet the candle condition failed
    expect(auth(on)).toBe(auth(off));
    expect(on.decision.decision).toBe('DATA REVIEW REQUIRED');
    expect(on.decision.ticket).toBeNull();
    expect(on.ranked!.total).toBeNull();
    expect(on.ranked!.hardFails.map((f) => f.code)).toContain('INVALID_CANDLE_DIRECTION');
    expect([on.candidate!.entry, on.candidate!.stop, on.candidate!.target, on.candidate!.shares]).toEqual([116.78, 116.32, 117.7, 171]);
    expect(scoreView(on).kind).toBe('REFERENCE'); // 58 in the full Nov 6 context (replay), 56 when evaluated alone
    expect(scoreView(on)).toEqual(scoreView(off));
    expect(mismatchSummary(on).label).toBe('2 MISMATCHES');
  });
  it('SYNTHETIC: RVOL-only FTNT with an invalid candle / failed VWAP / incomplete 15m / missing 5m candle / missing data → not accepted', () => {
    const variants: [string, (r: AutoAlertRecord) => void][] = [
      ['candle', (r) => { r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (c.label.startsWith('Close') ? { ...c, pass: false } : c)); }],
      ['vwap', (r) => { r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (c.label.startsWith('5m Close') ? { ...c, pass: false } : c)); }],
      ['15m incomplete', (r) => { r.snapshot!.issues = [...r.snapshot!.issues, { kind: 'INCOMPLETE', code: 'CONFIRM_15M_INCOMPLETE', message: 'synthetic' }]; }],
      ['5m candle missing', (r) => { r.snapshot!.issues = [...r.snapshot!.issues, { kind: 'INCOMPLETE', code: 'SIGNAL_CANDLE_MISSING', message: 'synthetic' }]; }],
      ['no values', (r) => { r.snapshot!.values = null; }],
      ['data error', (r) => { r.status = 'DATA_ERROR'; }],
      ['no completeness proof', (r) => { r.enrichmentAudit = []; }],
    ];
    for (const [name, m] of variants) { const r = rec('FTNT-S-1030'); m(r); expect([name, accepted(r)]).toEqual([name, false]); }
  });
});

describe('an accepted alert is decided exactly like an RVOL-reproduced twin (no bonus, no bypass)', () => {
  const sec = classify('FTNT');
  const pos = (i: number, o: Partial<ManualPosition> = {}): ManualPosition => ({ id: `P${i}`, ticker: `ZZ${i}`, direction: 'LONG', sector: `Other-${i}`, industry: `Other-${i}`, theme: '', positionValue: 5_000, plannedRisk: 50, entry: 10, stop: 9, target: 12, status: 'OPEN', ...o });
  const cases: [string, Partial<Parameters<typeof input>[1]>][] = [
    ['normal', {}],
    ['portfolio full', { positions: [0, 1, 2, 3].map((i) => pos(i)) }],
    ['correlation restriction', { positions: [0, 1].map((i) => pos(i, { sector: sec.sector, industry: sec.industry, direction: 'SHORT' })) }],
    ['risk limit exceeded', { positions: [pos(0, { plannedRisk: 50_000, positionValue: 400_000 })] }],
  ];
  for (const [name, o] of cases) {
    it(`${name}: decision, score, components, plan and lifecycle identical to the twin`, () => {
      const r = rec('FTNT-S-1030');
      expect(accepted(r)).toBe(true);
      const on = row(buildQueue(input([r], { ...o, a: true })), r.id);
      const twin = row(buildQueue(input([rvolPassedTwin(r)], o)), r.id);
      expect(on.rvolPolicy).toBeTruthy();
      expect(JSON.stringify([on.decision, on.ranked, on.candidate, on.live, on.lifecycle])).toBe(JSON.stringify([twin.decision, twin.ranked, twin.candidate, twin.live, twin.lifecycle]));
      expect(on.ranked!.components.find((k) => k.key === 'rvol')!.points).toBe(0); // RB SIP RVOL band — nothing awarded
    });
  }
  it('after 15:30 / after 16:00 / expired → same as the twin (NOT ELIGIBLE / no ticket)', () => {
    for (const [hh, nowOff] of [['15:35:10', 4_000], ['16:00:20', 4_000], ['10:30:25', 11 * 60_000]] as const) {
      const r = rec('FTNT-S-1030');
      const t = Date.parse(`2026-11-06T${hh}-05:00`);
      Object.assign(r, { receivedMs: t, receivedIso: new Date(t).toISOString(), processedIso: new Date(t + 1000).toISOString() });
      Object.assign(r.alert, { alertTimeMs: t, alertTimeIso: new Date(t).toISOString() });
      const on = row(buildQueue(input([r], { a: true, now: t + nowOff })), r.id);
      const twin = row(buildQueue(input([rvolPassedTwin(r)], { now: t + nowOff })), r.id);
      expect(on.decision).toEqual(twin.decision);
      expect(on.decision.ticket).toBeNull();
    }
  });
  it('Phase C with Policy A: accepted alert is authoritatively SCORED; the RVOL SOURCE DIFFERENCE diagnostic stays visible', () => {
    const r = rec('FTNT-S-1030');
    const on = row(buildQueue(input([r], { a: true })), r.id);
    expect(scoreView(on).kind).toBe('SCORED');
    expect(mismatchSummary(on).label).toBe('1 MISMATCH (SOURCE DIFFERENCE)');
  });
  it('deterministic: a re-evaluation (browser refresh) gives the identical output', () => {
    const recs = [rec('FTNT-S-1030'), rec('CARR'), rec('Q-L-144006')];
    expect(JSON.stringify(buildQueue(input(recs, { a: true })))).toBe(JSON.stringify(buildQueue(input(structuredClone(recs), { a: true }))));
  });
});

describe('isolation', () => {
  it('tsConfigRegistry is imported only by the Policy A module (and tests)', () => {
    const root = join(__dirname, '..', '..', '..', '..');
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') walk(p); } else if (/\.(ts|tsx|mts)$/.test(n)) files.push(p); } };
    walk(join(root, 'src')); walk(join(root, 'netlify'));
    const users = files.filter((f) => /from '[^']*tsConfigRegistry'/.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f).split(sep).join('/'));
    expect(users).toEqual(['src/engine/automation/rvolPolicy.ts']);
  });
});
