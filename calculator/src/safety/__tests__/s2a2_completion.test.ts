/**
 * S2a safety completion — (1) observation continuity, (2) Calculator authorization bypass, (3) time integrity.
 * Written BEFORE the correction and run against f917669 first (where they fail), then against the correction.
 *
 * Continuity is measured in SERVER time: the alert record's own first observation (initialQuote.fetchedIso, stamped by
 * the server at processing) and every client price poll (quote.fetchedIso, stamped by the server at its Alpaca fetch).
 * Limits derive from the existing configuration (pollMs / quotePollMs + maxDataAgeSec), see S1_SAFETY_SPEC.md §9.
 */
import { describe, expect, it } from 'vitest';
import type { LiveQuote } from '../../engine/automation/alertDecision';
import { rankCandidates } from '../../engine/ranker/candidateRanker';
import type { Candidate } from '../../engine/ranker/opportunityTypes';
import * as gate from '../../components/portfolioGate';
import { et, fixtureSteps, loadFixture, queueAuthorizes, rankerAuthorizes, RK, runApp, STRATEGY, type State, type Step } from './harness';
import { at, LONG } from './synthetic';

const FX = loadFixture('vrsk-1035');
const ID = FX.records[0].id;
const all = fixtureSteps(FX);
const idx = (t: string) => FX.stepsMs.findIndex((ms) => et(ms) === t);
const neverAuthorized = (ps: ReturnType<typeof runApp>, id = ID) => ps.filter((p) => queueAuthorizes(p.row(id)) || rankerAuthorizes(p.ranked(id))).map((p) => et(p.now));
const OBS = { observe: true } as Record<string, unknown>; // the App's continuity tracking (harness option)

describe('S2a.2 · 1 · observation continuity (VRSK LONG 10:35:09, real SIP fixture)', { timeout: 60_000 }, () => { // long 0.5 s replays
  it('positive: observed continuously from the alert, the untriggered BUY STOP is authorized at 10:35:12 (no false refusal)', () => {
    const ps = runApp(FX.records, all, OBS);
    expect(ps.some((p) => et(p.now) === '10:35:12' && queueAuthorizes(p.row(ID)) && rankerAuthorizes(p.ranked(ID)))).toBe(true);
  });
  it('positive: the same with the real 3 s price polling', () => {
    const poll = all.filter((_s, i) => i % 6 === 0);
    expect(runApp(FX.records, poll, OBS).some((p) => queueAuthorizes(p.row(ID)))).toBe(true);
  });
  it('A · READY seen, browser closed through the chase, reopened 10:36:45 (pullback) → never authorized', () => {
    const pre = runApp(FX.records, all.slice(0, idx('10:35:12') + 2), OBS);
    const start = JSON.parse(JSON.stringify(pre[pre.length - 1].state)) as State;
    expect(neverAuthorized(runApp(FX.records, all.slice(idx('10:36:45')), { ...OBS, start }))).toEqual([]);
  });
  it('B · network outage 10:35:13 → 10:36:45: once older than the existing 5 s data-age tolerance, never authorized again (incl. after restore)', () => {
    const frozen = all[idx('10:35:12')].quotes;
    const outage = all.map((s, i) => (i > idx('10:35:12') && i < idx('10:36:45') ? { now: s.now, quotes: frozen } : s));
    expect(neverAuthorized(runApp(FX.records, outage, OBS).slice(idx('10:35:18')))).toEqual([]);
  });
  it('C · tab suspended (no passes at all) 10:35:13 → 10:36:45, same memory → never authorized afterwards', () => {
    const susp = all.filter((_s, i) => i <= idx('10:35:12') || i >= idx('10:36:45'));
    const ps = runApp(FX.records, susp, OBS);
    expect(neverAuthorized(ps.slice(ps.findIndex((p) => et(p.now) === '10:36:45')))).toEqual([]);
  });
  it('D/E · second tab / alert first opened at 10:36:45 (+96 s) → never authorized', () => {
    expect(neverAuthorized(runApp(FX.records, all.slice(idx('10:36:45')), OBS))).toEqual([]);
  });
  it('refresh mid-alert (in-memory observation lost) → not authorized again for this alert, although nothing failed', () => {
    const rec = LONG();
    const before = runApp([rec], observedSteps(100.95, 0.05, 2), OBS);
    expect(queueAuthorizes(before[before.length - 1].row(rec.id))).toBe(true);
    const start = JSON.parse(JSON.stringify(before[before.length - 1].state)) as State;
    expect(neverAuthorized(runApp([rec], observedSteps(100.95, 2.05, 5), { ...OBS, start }), rec.id)).toEqual([]);
  });
  it('refresh within the first observation allowance (10:35:12, 3.6 s after the server observation) is genuinely continuous', () => {
    const pre = runApp(FX.records, all.slice(0, idx('10:35:12') + 1), OBS);
    const start = JSON.parse(JSON.stringify(pre[pre.length - 1].state)) as State;
    const after = runApp(FX.records, all.slice(idx('10:35:12') + 2), { ...OBS, start });
    expect(neverAuthorized(after).every((t) => t < '10:35:14')).toBe(true); // only before the chase; never after it
  });
  it('the withheld state is the existing DATA REVIEW / NO TICKET, with a reason that does not claim a chase', () => {
    const ps = runApp(FX.records, all.slice(idx('10:36:45')), OBS);
    const r = ps.find((p) => p.row(ID)?.decision.ticket)!.row(ID)!;
    expect(r.decision.ticket).not.toBeNull();
    expect(r.lifecycle).toMatchObject({ executionState: 'DATA REVIEW', finalActionability: 'NO TICKET' });
    expect(r.lifecycle.reason).toMatch(/not observed continuously/i);
    expect(r.lifecycle.reason).not.toMatch(/^CHASED|was beyond the|SETUP FAILED —/); // never claims an unobserved chase or failure
    expect(r.lifecycle.reason).toMatch(/not evidence that the setup failed or was chased/);
  });
});

/** Continuous 3 s observations of one synthetic symbol; `skewMs` = client clock error (client = real + skew). */
function observedSteps(price: number, fromMin: number, toMin: number, skewMs = 0): Step[] {
  const out: Step[] = [];
  for (let real = at(fromMin); real <= at(toMin); real += 3000) {
    const q: LiveQuote = { price, tradeIso: new Date(real - 1500).toISOString(), fetchedIso: new Date(real - 300).toISOString(), receivedMs: real - 100 + skewMs };
    out.push({ now: real + skewMs, quotes: { AAA: q } });
  }
  return out;
}

describe('S2a.2 · 3 · time integrity (synthetic, continuous observation)', () => {
  const rec = LONG();
  it('positive: correct clock, 5 minutes into the alert → authorized', () => {
    const ps = runApp([rec], observedSteps(100.95, 0.05, 5), OBS);
    expect(queueAuthorizes(ps[ps.length - 1].row(rec.id))).toBe(true);
  });
  it('client clock 3 minutes SLOW: at real +12 min the alert is expired → never authorized after real +10 min', () => {
    const ps = runApp([rec], observedSteps(100.95, 0.05, 12, -180_000), OBS);
    expect(ps.filter((p) => p.now + 180_000 >= at(10)).filter((p) => queueAuthorizes(p.row(rec.id)) || rankerAuthorizes(p.ranked(rec.id))).length).toBe(0);
  });
  it('client clock 3 minutes FAST: fail closed (server-time evidence disagrees), never authorized', () => {
    const ps = runApp([rec], observedSteps(100.95, 0.05, 5, 180_000), OBS);
    expect(ps.filter((p) => queueAuthorizes(p.row(rec.id))).length).toBe(0);
  });
});

describe('S2a.2 · 2 · alert-derived Calculator → Ranker (authorization bypass)', () => {
  const handoff = (gate as Record<string, unknown>).calculatorHandoff as undefined | ((o: { recordId: string } | null, cs: Candidate[]) => { kind: string; id?: string });
  const rec = LONG();
  const [p] = runApp([rec], observedSteps(100.95, 0.05, 0.2), OBS).slice(-1);
  const auto = p.state.candidates.find((c) => c.id === rec.id)!;
  it('an alert-derived calculation is never sent as a new manual candidate: it opens the alert\'s own (Queue-gated) candidate', () => {
    expect(typeof handoff).toBe('function');
    expect(handoff!({ recordId: rec.id }, [{ ...auto, status: 'SKIPPED' }])).toEqual({ kind: 'SELECT_ALERT_CANDIDATE', id: rec.id });
  });
  it('… and with no alert candidate it is refused (no manual candidate created)', () => {
    expect(typeof handoff).toBe('function');
    expect(handoff!({ recordId: rec.id }, []).kind).toBe('REFUSE_ALERT_DERIVED');
  });
  it('a truly independent manual calculation still creates a manual candidate', () => {
    expect(typeof handoff).toBe('function');
    expect(handoff!(null, []).kind).toBe('MANUAL');
  });
  it('a manual candidate\'s TRADE NOW is labelled as not RB-authorized (clearly distinguished)', () => {
    const manual: Candidate = { ...auto, id: 'manual-x', source: 'MANUAL' };
    const view = gate.gateRankingByAuthorization(rankCandidates([manual], [], RK, '2026-10-30', STRATEGY), {}, p.now, 5000);
    expect(view.ranked[0].displayStatus).toMatch(/^TRADE NOW.*MANUAL — NOT RB-AUTHORIZED$/);
  });
});
