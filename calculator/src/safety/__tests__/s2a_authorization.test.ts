/**
 * S2a — irreversible terminal chase (Correction A) and one authoritative execution authorization (Correction B).
 * Expected values come from the fixtures' market facts and the stated contract, not from the functions under test.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION } from '../../engine/automation/alertDecision';
import { authorizationRefusal, executionAuthorizations, type ExecutionAuthorization } from '../../engine/automation/lifecycle/executionState';
import { chaseKey } from '../../engine/automation/lifecycle/terminalEvents';
import { ACTIVE_LOGIC_VERSION } from '../../engine/automation/v12/dispatch';
import { rankCandidates } from '../../engine/ranker/candidateRanker';
import type { Candidate, ManualPosition } from '../../engine/ranker/opportunityTypes';
import { gateRankingByAuthorization } from '../../components/portfolioGate';
import { et, fixtureSteps, loadFixture, queueAuthorizes, rankerAuthorizes, RK, runApp, STRATEGY, type State } from './harness';
import { ALERT, at, LONG, steps } from './synthetic';

const MAX_AGE = DEFAULT_AUTOMATION.maxDataAgeSec * 1000;

describe('S2a · 1–2, 4 · VRSK LONG 10:35:09 (historical fixture)', () => {
  const FX = loadFixture('vrsk-1035');
  const ID = FX.records[0].id;
  const LIMIT = 201.26 + 0.25 * (FX.records[0].snapshot!.values!.atr as number);
  const ps = runApp(FX.records, fixtureSteps(FX));
  const first = ps.findIndex((_p, i) => (FX.quotes.VRSK[i]?.[0] ?? 0) > LIMIT);
  it('1 · the chase is recorded once from the first reliable observation (201.465 round lot, 10:35:13.338), with provenance', () => {
    const ev = ps[first].state.terminal[chaseKey(ID)];
    expect(ev).toMatchObject({ kind: 'CHASED', recordId: ID, price: 201.465, entry: 201.26, distanceAtr: 0.26, thresholdAtr: 0.25, quoteTradeIso: expect.stringContaining('15:35:13.338') });
    expect(ps[ps.length - 1].state.terminal[chaseKey(ID)]).toEqual(ev); // write-once
  });
  it('1 · after the chase, the 10:36:45.5–10:36:47.5 pullback (201.2334) is CHASED · NO TRADE with the ticket withheld', () => {
    // Every instant after the chase at which the latest round lot is back below the 201.26 trigger (the pullback).
    const pull = ps.filter((_p, i) => i > first && (FX.quotes.VRSK[i]?.[0] ?? Infinity) < 201.26);
    expect(pull.map((x) => et(x.now))).toEqual(['10:36:45', '10:36:46', '10:36:46', '10:36:47', '10:36:47']);
    for (const p of pull) {
      const r = p.row(ID)!;
      expect(r.decision.ticket).not.toBeNull(); // the RB v1.1 decision itself is unchanged …
      expect(r.lifecycle).toMatchObject({ executionState: 'CHASED', finalActionability: 'NO TRADE', terminal: true });
      expect(queueAuthorizes(r)).toBe(false); // … but it is never offered as an order
    }
  });
  it('1, 4 · no Queue authorization and no Ranker TRADE NOW at any instant after the chase', () => {
    for (const p of ps.slice(first)) {
      expect(queueAuthorizes(p.row(ID))).toBe(false);
      expect(rankerAuthorizes(p.ranked(ID))).toBe(false);
    }
  });
  it('2 · the chase stays terminal across a reload (persisted map → fresh session at the pullback)', () => {
    const k = ps.findIndex((p) => et(p.now) === '10:36:40');
    const start = JSON.parse(JSON.stringify(ps[k].state)) as State;
    const after = runApp(FX.records, fixtureSteps(FX, k + 1), { start });
    for (const p of after) {
      expect(queueAuthorizes(p.row(ID))).toBe(false);
      expect(rankerAuthorizes(p.ranked(ID))).toBe(false);
    }
  });
});

describe('S2a · 3, 5 · SETUP FAILED stays terminal; first terminal event wins; evidence kept (synthetic)', () => {
  it('SETUP FAILED then a chase: SETUP FAILED shown, the chase is also recorded as evidence, no authorization anywhere', () => {
    const rec = LONG();
    const p = runApp([rec], steps('AAA', [[1, 100.95], [2, 99.95], [3, 101.4], [4, 100.95]]));
    expect(p[3].state.terminal[rec.id]).toMatchObject({ kind: 'SETUP_FAILED' });
    expect(p[3].state.terminal[chaseKey(rec.id)]).toMatchObject({ kind: 'CHASED' });
    expect(p[3].row(rec.id)!.lifecycle.executionState).toBe('SETUP FAILED');
    for (const x of p.slice(2)) { expect(queueAuthorizes(x.row(rec.id))).toBe(false); expect(rankerAuthorizes(x.ranked(rec.id))).toBe(false); }
  });
  it('a chase then SETUP FAILED: both recorded (SETUP FAILED evidence is not suppressed); CHASED shown as the first reason', () => {
    const rec = LONG();
    const p = runApp([rec], steps('AAA', [[1, 100.95], [2, 101.4], [3, 99.95], [4, 100.95]]));
    expect(p[3].state.terminal[chaseKey(rec.id)]).toMatchObject({ kind: 'CHASED', observedAtMs: at(2) });
    expect(p[3].state.terminal[rec.id]).toMatchObject({ kind: 'SETUP_FAILED', observedAtMs: at(3) });
    expect(p[3].row(rec.id)!.lifecycle).toMatchObject({ executionState: 'CHASED', finalActionability: 'NO TRADE' });
    expect(p[3].row(rec.id)!.lifecycle.setupFailed).not.toBeNull();
    for (const x of p.slice(1)) { expect(queueAuthorizes(x.row(rec.id))).toBe(false); expect(rankerAuthorizes(x.ranked(rec.id))).toBe(false); }
  });
  it('5 · the Ranker withholds TRADE NOW after the latched SETUP FAILED and recovery (status says why)', () => {
    const rec = LONG();
    const p = runApp([rec], steps('AAA', [[1, 100.95], [2, 99.95], [3, 100.95]]));
    const r = p[2].ranked(rec.id)! as ReturnType<typeof p[2]['ranked']> & { qualityRecommendation?: string };
    expect(r.recommendation).toBeNull();
    expect(r.displayStatus).toBe('NOT AUTHORIZED — NOT AUTHORIZED BY THE LIVE QUEUE');
    expect(r.qualityRecommendation).toMatch(/^TRADE NOW/); // the quality ranking is preserved for diagnosis
  });
});

describe('S2a · 6–7 · Ranker refuses on DATA REVIEW, stale and missing quotes (synthetic)', () => {
  const cases: [string, Parameters<typeof steps>[1], Partial<Parameters<typeof LONG>[0]>][] = [
    ['DATA REVIEW', [[1, 100.95]], { issues: [{ kind: 'REVIEW', code: 'ALERT_NOT_REPRODUCED', message: 'RVOL' }] }],
    ['stale quote (6 s)', [[1, 100.95], [2, 100.95, { ageMs: 6000 }]], {}],
    ['stale last trade (90 s)', [[1, 100.95], [2, 100.95, { tradeAgeMs: 90_000 }]], {}],
    ['no quote at all', [[1, null]], {}],
  ];
  for (const [name, pts, o] of cases) {
    it(`${name}: Queue refuses → Ranker shows no TRADE NOW (scores unchanged)`, () => {
      const rec = LONG(o);
      const p = runApp([rec], steps('AAA', pts));
      const last = p[p.length - 1];
      expect(queueAuthorizes(last.row(rec.id))).toBe(false);
      expect(rankerAuthorizes(last.ranked(rec.id))).toBe(false);
      expect(last.ranked(rec.id)!.total).toBe(last.rawRanked(rec.id)!.total);
    });
  }
});

describe('S2a · 8 · BSX LONG 12:20:06 — Queue 81 / Ranker 85 (historical fixture)', () => {
  const FX = loadFixture('bsx-1220-peers');
  const ID = 'BSX-L-122006-77deee';
  const ps = runApp(FX.records, fixtureSteps(FX));
  const p = ps.find((x) => et(x.now) === '12:26:49')!;
  // Revised for the approved D3 policy (was: "the discrepancy is preserved for diagnosis (81 vs 85)"): the discrepancy
  // no longer exists — both surfaces read the frozen capital efficiency. The authoritative refusal still wins.
  it('both surfaces now agree (81 vs 81, frozen capital efficiency) and the authoritative refusal wins: no TRADE NOW', () => {
    expect([p.row(ID)!.ranked!.total, p.ranked(ID)!.total]).toEqual([81, 81]);
    expect(p.rawRanked(ID)!.recommendation ?? '').not.toMatch(/^TRADE NOW/);
    expect(rankerAuthorizes(p.ranked(ID))).toBe(false);
    expect(queueAuthorizes(p.row(ID))).toBe(false);
  });
  it('whole fixture: no instant where the Ranker shows TRADE NOW while the Queue refuses', () => {
    for (const x of ps) for (const r of x.rows) if (rankerAuthorizes(x.ranked(r.record.id))) expect(queueAuthorizes(r)).toBe(true);
  });
});

describe('S2a · 9, 11 · broker / position precedence and duplicate exposure (synthetic)', () => {
  it('a submitted order stays SUBMITTED (even with a chase recorded) and is never a new entry on either surface', () => {
    const rec = LONG();
    const p = runApp([rec], steps('AAA', [[1, 100.95], [2, 101.4], [3, 100.95]]), { before: (now, cs) => (now >= at(3) ? cs.map((c) => ({ ...c, status: 'PENDING' as const })) : cs) });
    expect(p[2].state.terminal[chaseKey(rec.id)]).toBeDefined();
    expect(p[2].row(rec.id)!.lifecycle.executionState).toBe('SUBMITTED');
    expect(rankerAuthorizes(p[2].ranked(rec.id))).toBe(false);
  });
  it('a filled order stays IN POSITION', () => {
    const rec = LONG();
    const p = runApp([rec], steps('AAA', [[1, 100.95], [2, 101.6]]), { before: (now, cs) => (now >= at(2) ? cs.map((c) => ({ ...c, status: 'FILLED' as const })) : cs) });
    expect(p[1].row(rec.id)!.lifecycle.executionState).toBe('IN POSITION');
    expect(p[1].state.terminal[chaseKey(rec.id)]).toBeUndefined(); // no chase is recorded for a submitted / filled order
  });
  it('an open position in the ticker: no authorization on either surface (no duplicate exposure)', () => {
    const rec = LONG();
    const pos = { id: 'pos', ticker: 'AAA', direction: 'LONG', sector: 'Sector-AAA', industry: 'Industry-AAA', theme: '', positionValue: 10000, plannedRisk: 50, entry: 100, stop: 99, target: 102, status: 'OPEN' } as ManualPosition;
    const [p] = runApp([rec], steps('AAA', [[1, 100.95]]), { positions: [pos] });
    expect(queueAuthorizes(p.row(rec.id))).toBe(false);
    expect(rankerAuthorizes(p.ranked(rec.id))).toBe(false);
  });
  it('a new same-ticker alert while an earlier entry is PENDING: no authorization (duplicate)', () => {
    const a = LONG(); const b = LONG({ alertIso: '2026-10-30T10:18:04-04:00' });
    const p = runApp([a, b], steps('AAA', [[1, 100.95], [4.5, 100.95]]), { before: (now, cs) => (now > Date.parse(ALERT) + 120_000 ? cs.map((c) => (c.id === a.id ? { ...c, status: 'PENDING' as const } : c)) : cs) });
    expect(queueAuthorizes(p[1].row(b.id))).toBe(false);
    expect(rankerAuthorizes(p[1].ranked(b.id))).toBe(false);
  });
});

describe('S2a · 10, 12–14 · authorization contract', () => {
  const rec = LONG();
  const [p] = runApp([rec], steps('AAA', [[1, 100.95]]));
  const auth = executionAuthorizations(p.rows, p.now);
  const cand = p.state.candidates.find((c) => c.id === rec.id)!;
  it('a valid, current evaluation authorizes exactly that alert and plan (both surfaces agree)', () => {
    expect(Object.keys(auth)).toEqual([rec.id]);
    expect(auth[rec.id]).toMatchObject({ recordId: rec.id, logicVersion: 'RB v1.1', evaluatedAtMs: p.now, plan: { direction: 'LONG', entry: cand.entry, stop: cand.stop, target: cand.target, shares: cand.shares } });
    expect(authorizationRefusal(cand, auth, p.now, MAX_AGE)).toBeNull();
    expect(queueAuthorizes(p.row(rec.id))).toBe(true);
    expect(rankerAuthorizes(p.ranked(rec.id))).toBe(true);
  });
  it('12 · fails closed: no Queue evaluation (Queue off / not yet run after a reload) → refused', () => {
    expect(authorizationRefusal(cand, null, p.now, MAX_AGE)).toMatch(/LIVE QUEUE NOT EVALUATED/);
    const view = gateRankingByAuthorization(rankCandidates(p.state.candidates, [], RK, '2026-10-30', STRATEGY), null, p.now, MAX_AGE);
    expect(rankerAuthorizes(view.ranked.find((r) => r.candidate.id === rec.id))).toBe(false);
  });
  it('12 · fails closed: an evaluation older than the 5 s freshness limit (or from the future) is expired', () => {
    expect(authorizationRefusal(cand, auth, p.now + MAX_AGE + 1, MAX_AGE)).toBe('EXECUTION AUTHORIZATION EXPIRED');
    expect(authorizationRefusal(cand, auth, p.now - 1, MAX_AGE)).toBe('EXECUTION AUTHORIZATION EXPIRED');
    expect(authorizationRefusal(cand, auth, p.now + MAX_AGE, MAX_AGE)).toBeNull();
  });
  it('13 · identity: another alert\'s authorization, or an edited plan, never authorizes this candidate', () => {
    const other: Record<string, ExecutionAuthorization> = { 'OTHER-ID': { ...auth[rec.id], recordId: 'OTHER-ID' } };
    expect(authorizationRefusal(cand, other, p.now, MAX_AGE)).toBe('NOT AUTHORIZED BY THE LIVE QUEUE');
    const forged: Record<string, ExecutionAuthorization> = { [rec.id]: { ...auth[rec.id], recordId: 'OTHER-ID' } };
    expect(authorizationRefusal(cand, forged, p.now, MAX_AGE)).toBe('NOT AUTHORIZED BY THE LIVE QUEUE');
    for (const k of ['entry', 'stop', 'target', 'shares'] as const) {
      expect(authorizationRefusal({ ...cand, [k]: (cand[k] as number) + 1 }, auth, p.now, MAX_AGE)).toBe('AUTHORIZATION DOES NOT MATCH THIS CANDIDATE');
    }
    expect(authorizationRefusal({ ...cand, direction: 'SHORT' }, auth, p.now, MAX_AGE)).toBe('AUTHORIZATION DOES NOT MATCH THIS CANDIDATE');
  });
  it('10 · a status change cannot manufacture authorization: PENDING/FILLED/SKIPPED candidates are never new entries', () => {
    for (const status of ['PENDING', 'FILLED', 'SKIPPED', 'EXPIRED'] as const) expect(authorizationRefusal({ ...cand, status }, auth, p.now, MAX_AGE)).toBe('NOT A NEW ENTRY');
  });
  it('10 · manual candidates keep the Ranker\'s hard rules (a chased manual candidate is never TRADE NOW) and are not gated by the Queue', () => {
    const manual: Candidate = { ...cand, id: 'manual-1', source: 'MANUAL' };
    const ok = gateRankingByAuthorization(rankCandidates([manual], [], RK, '2026-10-30', STRATEGY), {}, p.now, MAX_AGE);
    expect(ok.ranked[0].recommendation).toMatch(/^TRADE NOW/);
    const chased: Candidate = { ...manual, calcAction: 'SKIP_CHASED', calcReady: false, chaseDistanceAtr: 0.4 };
    const no = gateRankingByAuthorization(rankCandidates([chased], [], RK, '2026-10-30', STRATEGY), {}, p.now, MAX_AGE);
    expect(no.ranked[0].recommendation?.startsWith('TRADE NOW') ?? false).toBe(false);
  });
  it('14 · deterministic: the same Queue evaluation gives the same authorization (tab switches recompute identically)', () => {
    expect(executionAuthorizations(p.rows, p.now)).toEqual(auth);
    const [again] = runApp([rec], steps('AAA', [[1, 100.95]]));
    expect(executionAuthorizations(again.rows, again.now)).toEqual(auth);
  });
  it('14 · after a reload the persisted state carries no authorization; it returns only with a fresh Queue evaluation', () => {
    expect(JSON.stringify(p.state)).not.toMatch(/evaluatedAtMs/);
    const [fresh] = runApp([rec], steps('AAA', [[1.5, 100.95]]), { start: JSON.parse(JSON.stringify(p.state)) as State });
    expect(rankerAuthorizes(fresh.ranked(rec.id))).toBe(true);
  });
});

describe('S2a · 15–16 · unchanged behaviour', () => {
  it('15 · v1.1 ACTIVE, v1.2 SHADOW (dispatch and shadow row unchanged)', () => {
    expect(ACTIVE_LOGIC_VERSION).toBe('RB v1.1');
    const rec = LONG();
    const [p] = runApp([rec], steps('AAA', [[1, 100.95]]));
    expect(p.row(rec.id)!.shadow).not.toBeNull();
  });
  it('16 · the gate never changes scores, tiers, components, ranks or allocation — only TRADE NOW display of unauthorized automated candidates', () => {
    const FX = loadFixture('bsx-1220-peers');
    for (const x of runApp(FX.records, fixtureSteps(FX, 380, 420))) {
      for (const r of x.rows) {
        const g = x.ranked(r.record.id), raw = x.rawRanked(r.record.id);
        if (!raw) continue;
        expect({ t: g!.total, tier: g!.tier, c: g!.components, rank: g!.rank, a: g!.allocation }).toEqual({ t: raw.total, tier: raw.tier, c: raw.components, rank: raw.rank, a: raw.allocation });
        if (g!.recommendation !== raw.recommendation) expect(raw.recommendation).toMatch(/^TRADE NOW/);
      }
    }
  });
});
