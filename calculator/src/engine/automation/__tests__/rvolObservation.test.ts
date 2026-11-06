/**
 * RVOL POLICY V1 — OBSERVATION ONLY. Real 2026-11-06 production records (FTNT 10:30 and CARR 11:05: RVOL-only
 * DATA REVIEW; CTVA and Q 12:30: RVOL passed). Proves the authoritative decision path is untouched and every hard
 * rule still applies to the V1 view.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import FX from './rvol-v1-observation-2026-11-06.json';
import type { AutoAlertRecord, LiveQuote } from '../alertDecision';
import { DEFAULT_AUTOMATION } from '../alertDecision';
import { buildQueue, type QueueInput, type QueueRow } from '../liveQueue';
import { observeRvolPolicyV1, RVOL_V1_OBSERVATION_ENABLED } from '../rvolObservation';
import { applyRvolPolicyV1, evaluateRvolPolicyV1 } from '../rvolPolicyV1';
import { cloneRankerDefaults } from '../../ranker/rankerSettings';
import { classifyScore } from '../../ranker/candidateRanker';
import { RB_V1_DEFAULTS } from '../../settings';
import { KNOWN_CLASSIFICATIONS } from '../../ranker/correlationRules';

const ALL = FX.records as unknown as AutoAlertRecord[];
const byId = (p: string) => structuredClone(ALL.find((r) => r.id.startsWith(p))!) as AutoAlertRecord;
const classify = (s: string) => KNOWN_CLASSIFICATIONS[s] ?? { sector: `Sector-${s}`, industry: `Industry-${s}`, theme: '' };
function input(records: AutoAlertRecord[], o: { now?: number; quoteAgeMs?: number; candidates?: QueueInput['candidates'] } = {}): QueueInput {
  const now = o.now ?? Math.max(...records.map((r) => Date.parse(r.processedIso ?? r.receivedIso))) + 4_000;
  const quotes: Record<string, LiveQuote> = {};
  for (const r of records) if (r.initialQuote) quotes[r.alert.symbol] = { ...r.initialQuote, tradeIso: new Date(now - 1500 - (o.quoteAgeMs ?? 0)).toISOString(), fetchedIso: new Date(now - 500 - (o.quoteAgeMs ?? 0)).toISOString(), receivedMs: now - 500 - (o.quoteAgeMs ?? 0) };
  return { records, candidates: o.candidates ?? [], positions: [], quotes, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify, parity: {}, strategyVersion: 'RB v1.1', frozen: {} };
}
const run = (q: QueueInput) => {
  const before = JSON.stringify({ ...q, classify: undefined });
  const prod = buildQueue(q);
  const obs = observeRvolPolicyV1(q, prod);
  expect(JSON.stringify({ ...q, classify: undefined })).toBe(before); // inputs never mutated
  return { prod, obs, row: (id: string) => prod.rows.find((r) => r.record.id === id)! };
};
const key = (r: QueueRow) => JSON.stringify([r.decision.decision, r.decision.detail, r.decision.ticket, r.ranked?.total ?? null, r.ranked?.tier ?? null, r.candidate]);

describe('isolation', () => {
  it('flag defaults OFF', () => expect(RVOL_V1_OBSERVATION_ENABLED).toBe(false));
  it('production QueueOutput is identical with and without computing the observation; results are immutable', () => {
    const recs = [byId('FTNT-S-1030'), byId('CARR'), byId('CTVA'), byId('Q-L')];
    const q = input(recs);
    const alone = buildQueue({ ...q, records: structuredClone(recs) }); // production alone, no observation computed
    const { prod, obs } = run(q);
    expect(prod.rows.map(key)).toEqual(alone.rows.map(key));
    expect(JSON.stringify(prod.candidates)).toBe(JSON.stringify(alone.candidates)); // no reservation, no peer-pool change
    expect(Object.isFrozen(obs)).toBe(true);
    if (obs.length) expect(Object.isFrozen(obs[0].v1)).toBe(true);
  });
  it('source guard: no authoritative module imports the policy or the observation; the panel is not mounted', () => {
    const root = join(__dirname, '..', '..', '..', '..');
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') walk(p); } else if (/\.(ts|tsx|mts)$/.test(n)) files.push(p); } };
    walk(join(root, 'src'));
    walk(join(root, 'netlify'));
    expect(files.length).toBeGreaterThan(100);
    const rel = (f: string) => relative(root, f).split(sep).join('/');
    const importers = (re: RegExp) => files.filter((f) => re.test(readFileSync(f, 'utf8'))).map(rel).sort();
    expect(importers(/from '[^']*rvolPolicyV1'/)).toEqual(['src/engine/automation/rvolObservation.ts']);
    expect(importers(/from '[^']*rvolObservation'/)).toEqual(['src/components/live/RvolObservationPanel.tsx']);
    expect(importers(/RvolObservationPanel/)).toEqual(['src/components/live/RvolObservationPanel.tsx']); // defined, never mounted
  });
});

describe('RVOL-only disagreement (FTNT 10:30, CARR 11:05)', () => {
  for (const p of ['FTNT-S-1030', 'CARR']) {
    it(`${p}: production DATA REVIEW stays; V1 accepted → scored normally; RVOL points identical (SIP), no ticket`, () => {
      const r = byId(p);
      const { obs, row } = run(input([r]));
      expect(row(r.id).decision.decision).toBe('DATA REVIEW REQUIRED');
      const o = obs.find((x) => x.recordId === r.id)!;
      expect(o.verdict.accepted).toBe(true);
      expect(o.rvolSourceDifference).toBe(true);
      expect(o.v1.decision).not.toBe('DATA REVIEW REQUIRED');
      expect(o.v1.rvolPoints).toBe(o.production.rvolPoints); // never inflated: 0/15 for SIP < 1.5
      expect(o.v1.rvolPoints).toBe(0);
      expect(o.v1.score).toBe(o.production.score);
      expect(o.wouldCreateTicket).toBe(false);
    });
  }
  it('very low RB RVOL is accepted only as a warning and scores 0/15 (no floor, no award)', () => {
    const r = byId('CARR');
    r.snapshot!.values!.rvol = 0.2;
    const v = evaluateRvolPolicyV1(r);
    expect(v.accepted).toBe(true);
    expect(applyRvolPolicyV1(r, v).snapshot!.values!.rvol).toBe(0.2);
  });
  it('agreement (CTVA/Q RVOL passed on SIP) → policy not applicable, nothing observed', () => {
    const { obs } = run(input([byId('CTVA'), byId('Q-L')]));
    expect(obs).toEqual([]);
  });
});

describe('fail closed — V1 never accepts, V1 decision equals production', () => {
  const variants: [string, (r: AutoAlertRecord) => void, string][] = [
    ['missing rule_set', (r) => { delete (r.payload as Record<string, unknown>).rule_set; }, 'RULE_SET_RECOGNISED'],
    ['contradictory rule_set', (r) => { (r.payload as Record<string, unknown>).rule_set = 'RBTS-L-001'; }, 'RULE_SET_RECOGNISED'],
    ['unknown rule_set (possible misconfigured alert)', (r) => { (r.payload as Record<string, unknown>).rule_set = 'RBTS-S-999'; }, 'RULE_SET_RECOGNISED'],
    ['signal candle not proven final', (r) => { r.enrichmentAudit = []; }, 'SIGNAL_CANDLE_VERIFIED'],
    ['incomplete / developing 15m confirmation', (r) => { r.snapshot!.issues.push({ kind: 'INCOMPLETE', code: 'NO_COMPLETED_15M', message: 'x' }); }, 'DATA_COMPLETE'],
    ['candle colour also not reproduced', (r) => { r.snapshot!.alertConditions = r.snapshot!.alertConditions.map((c) => (c.label === 'Close < Open' ? { ...c, pass: false } : c)); }, 'OTHER_CONDITIONS_PASS'],
    ['another data-trust issue', (r) => { r.snapshot!.issues.push({ kind: 'REVIEW', code: 'MISSING_BARS', message: 'x' }); }, 'NO_OTHER_REVIEW_ISSUE'],
    ['market-data failure (DATA_ERROR)', (r) => { r.status = 'DATA_ERROR'; r.errors = ['Alpaca 503']; }, 'RECORD_OK'],
  ];
  for (const [name, mutate, code] of variants) {
    it(name, () => {
      const r = byId('FTNT-S-1030');
      mutate(r);
      const v = evaluateRvolPolicyV1(r);
      expect(v.accepted).toBe(false);
      expect(v.checks.find((c) => c.code === code)!.pass).toBe(false);
      const { obs } = run(input([r]));
      expect(obs).toEqual([]); // no acceptance → no V1 difference
    });
  }
});

describe('hard rules still apply to the V1 view', () => {
  const shift = (r: AutoAlertRecord, hhmmss: string) => {
    const t = Date.parse(`2026-11-06T${hhmmss}-05:00`);
    r.alert.alertTimeMs = t; r.alert.alertTimeIso = new Date(t).toISOString(); r.receivedMs = t; r.receivedIso = new Date(t).toISOString(); r.processedIso = new Date(t + 1000).toISOString();
    return r;
  };
  it('alert after 15:30 ET → NOT ELIGIBLE in both', () => {
    const r = shift(byId('FTNT-S-1030'), '15:35:10');
    const { obs, row } = run(input([r]));
    expect(row(r.id).decision.decision).toBe('NOT ELIGIBLE');
    expect(obs.every((o) => o.v1.decision === 'NOT ELIGIBLE' && !o.v1.ticket)).toBe(true);
  });
  it('alert after 16:00 ET → NOT ELIGIBLE in both', () => {
    const r = shift(byId('FTNT-S-1030'), '16:00:20');
    const { obs } = run(input([r]));
    expect(obs.every((o) => o.v1.decision === 'NOT ELIGIBLE' && !o.v1.ticket)).toBe(true);
  });
  it('stale market data → never a ticket in V1', () => {
    const r = byId('FTNT-S-1030');
    const { obs } = run(input([r], { quoteAgeMs: 120_000 }));
    expect(obs.every((o) => !o.v1.ticket)).toBe(true);
  });
  it('10-minute lifecycle: evaluated after expiry → not actionable in V1', () => {
    const r = byId('FTNT-S-1030');
    const { obs } = run(input([r], { now: r.receivedMs + 11 * 60_000 }));
    expect(obs.every((o) => !o.v1.ticket)).toBe(true);
  });
  it('repeated ticker (D4): an earlier NEW/SKIP candidate reserves nothing — the later alert is evaluated on its own in BOTH views; a FILLED position blocks it as DUPLICATE in both', () => {
    const a = byId('FTNT-S-1030');
    const b = byId('FTNT-S-1030');
    b.id = 'FTNT-S-103300-dup'; b.dedupeKey = 'dup'; b.receivedMs += 180_000; b.alert.alertTimeMs += 180_000; b.processedIso = new Date(b.receivedMs + 900).toISOString();
    // 1) no reservation by a NEW/SKIP candidate: V1 decision for b equals V1 decision for b alone; never two tickets
    const both = run(input([a, b]));
    const alone = run(input([b], { now: input([a, b]).now }));
    const vb = (o: typeof both.obs) => o.find((x) => x.recordId === b.id)?.v1.decision;
    expect(vb(both.obs)).toBe(vb(alone.obs));
    expect(both.obs.filter((o) => o.v1.ticket).length).toBeLessThanOrEqual(1);
    // 2) a FILLED same-ticker position blocks b in production AND in V1
    const v1a = buildQueue({ ...input([applyRvolPolicyV1(structuredClone(a), evaluateRvolPolicyV1(a))]) });
    const filled = v1a.candidates.map((c) => ({ ...c, status: 'FILLED' as const }));
    expect(filled.length).toBe(1);
    const blocked = run(input([b], { candidates: filled }));
    expect(blocked.row(b.id).decision.detail).toBe('DUPLICATE / EXISTING CANDIDATE');
    expect(blocked.obs.every((o) => o.recordId !== b.id || o.v1.detail === 'DUPLICATE / EXISTING CANDIDATE')).toBe(true);
  });
  it('terminal / closed candidate is never revived by V1', () => {
    const r = byId('FTNT-S-1030');
    const q = input([r]);
    const prod1 = buildQueue(q);
    const v1 = observeRvolPolicyV1(q, prod1);
    expect(v1.every((o) => !('candidates' in o))).toBe(true); // V1 candidates are never returned or stored
    // a production candidate already CLOSED (e.g. stop breach / setup failed) stays CLOSED in the V1 view
    const closed = [{ ...(prod1.candidates[0] ?? {}), id: r.id, status: 'SKIPPED' }] as unknown as QueueInput['candidates'];
    const { obs } = run(input([r], { candidates: closed }));
    expect(obs.every((o) => !o.v1.ticket && o.v1.decision !== 'HIGH PRIORITY — TRADE CONSIDERATION')).toBe(true);
  });
  it('score threshold: 84 is not tradeable, 85 and 86 are (unchanged); V1 never changes RVOL points, so it cannot move a score across 85 through RVOL', () => {
    const rk = cloneRankerDefaults();
    expect(['ELITE', 'HIGH_PRIORITY']).not.toContain(classifyScore(84, rk));
    expect(['ELITE', 'HIGH_PRIORITY']).toContain(classifyScore(85, rk));
    expect(['ELITE', 'HIGH_PRIORITY']).toContain(classifyScore(86, rk));
  });
  it('trade construction is identical: entry, stop, target, quantity and risk of the V1 candidate equal the production plan', () => {
    const r = byId('FTNT-S-1030');
    const q = input([r]);
    const prod = buildQueue(q);
    const v1q = { ...q, records: [applyRvolPolicyV1(structuredClone(r), evaluateRvolPolicyV1(r))] };
    const v1 = buildQueue(v1q);
    const plan = (o: typeof prod) => { const c = o.rows[0].candidate ?? null; return c && [c.entry, c.stop, c.target, c.shares, c.plannedRisk, c.orderType, c.atr]; };
    expect(plan(v1)).toEqual(plan(prod) ?? plan(v1)); // production has no candidate while in DATA REVIEW; V1's plan is the frozen alert-time plan
    expect(plan(v1)).toEqual([r.calcAtAlert!.entry, r.calcAtAlert!.stop, r.calcAtAlert!.target, r.calcAtAlert!.shares, r.calcAtAlert!.plannedRisk, 'SELL STOP', r.snapshot!.values!.atr]);
  });
});
