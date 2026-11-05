/**
 * Live vs. alert-time comparison UI (presentation only). Proves that:
 *   • the CURRENT (LIVE) row is unchanged (covered value-by-value by decisionPanel.test.ts);
 *   • every AT ALERT (FROZEN) value is read from a genuinely recorded alert-time source — the write-once snapshot of the
 *     SAME alert written at alert time, or the server's immutable calcAtAlert — and is NOT CAPTURED otherwise;
 *   • the Change Since Alert strip, Time Since Alert and Market Data Age are pure displays of existing values;
 *   • nothing here can authorize: the current Final execution state stays the only authority.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { QueueRow } from '../../../engine/automation/liveQueue';
import { DEFAULT_AUTOMATION, quoteAges } from '../../../engine/automation/alertDecision';
import { mmss } from '../../../engine/automation/etTime';
import { buildAlertTimeSnapshot, type AlertSnapshotMap, type AlertTimeSnapshot } from '../../../engine/automation/lifecycle/alertTimeSnapshot';
import { QueueDetails } from '../QueueParts';
import { ALERT_CAPTURE_TOLERANCE_MS, alertTimeAssessment, changeSinceAlert, marketDataAge, presentationFor, queueLayout, TIER_SHORT, timeSinceAlert, type StrategyCell } from '../queueView';
import { fixtureSteps, loadFixture, RK, runApp, type Pass } from '../../../safety/__tests__/harness';
import { LONG, steps } from '../../../safety/__tests__/synthetic';

const layout = queueLayout(presentationFor('RB v1.1'), { v12MaxScore: 91 });
const ACTIVE = layout.find((c) => c.role === 'ACTIVE')!;
const actions = { submit: vi.fn(), skip: vi.fn(), watch: vi.fn(), openInCalculator: vi.fn(), classify: vi.fn(), reprocess: vi.fn(), keep: vi.fn(), replace: vi.fn() };
const render = (r: QueueRow, now: number, snapshot: AlertTimeSnapshot | null) =>
  renderToStaticMarkup(createElement(QueueDetails, { r, now, actions, layout, maxScore: 91, optionAGrades: RK.grades, snapshot }));

/* ── balanced-tag reader (same approach as decisionPanel.test.ts) ── */
const decode = (t: string) => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'");
function elementAt(html: string, start: number): string {
  const re = /<(\/?)([a-zA-Z0-9]+)([^>]*?)(\/?)>/g;
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[4] === '/') continue;
    if (m[1] === '/') { depth--; if (depth === 0) return html.slice(start, re.lastIndex); } else depth++;
  }
  throw new Error('unbalanced');
}
const text = (frag: string) => decode(frag.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').replace(/ \/ /g, ' / ').trim();
const panelOf = (html: string) => { const i = html.indexOf('data-decision-panel='); return elementAt(html, html.lastIndexOf('<', i)); };
function field(panel: string, label: string): { value: string; title: string | null; captured: string | null } {
  const i = panel.indexOf(`data-field="${label}"`);
  if (i < 0) throw new Error(`field missing: ${label}`);
  const el = elementAt(panel, panel.lastIndexOf('<', i));
  const open = el.slice(0, el.indexOf('>'));
  const t = text(el.replace(/<span[^>]*data-mark="[^"]*"[^>]*>[\s\S]*?<\/span>/, ''));
  return { value: (t.startsWith(label) ? t.slice(label.length) : t).replace(/^\s*:\s*/, '').trim(), title: /title="([^"]*)"/.exec(open)?.[1] ?? null, captured: /data-captured="([^"]*)"/.exec(open)?.[1] ?? null };
}
const NEVER_CAPTURED = ['Alert Execution state', 'Alert Data Status', 'Alert Chase Status', 'Alert Portfolio status'] as const;
const genuine = (r: QueueRow, s: AlertTimeSnapshot | undefined) => !!s && s.recordId === r.record.id && s.frozenAtMs - r.record.receivedMs <= ALERT_CAPTURE_TOLERANCE_MS;

/** Every AT ALERT value of one rendered row against its recorded source. Returns mismatches (empty = correct). */
function frozenRowCheck(r: QueueRow, now: number, map: AlertSnapshotMap): string[] {
  const bad: string[] = [];
  const s = map[r.record.id];
  const panel = panelOf(render(r, now, s ?? null));
  const eq = (k: string, got: string, want: string) => { if (got !== want) bad.push(`${r.record.id} @${now} ${k}: shown "${got}" recorded "${want}"`); };
  if (genuine(r, s)) {
    eq('Alert Score', field(panel, 'Alert Score').value, s!.v11.total === null ? 'NOT SCORED' : `${s!.v11.total} / 100`);
    eq('Alert Tier', field(panel, 'Alert Tier').value, s!.v11.tier ? TIER_SHORT[s!.v11.tier as keyof typeof TIER_SHORT] : 'NOT SCORED');
    eq('Alert Decision', field(panel, 'Alert Decision').value, s!.v11.decision);
  } else {
    for (const k of ['Alert Score', 'Alert Tier', 'Alert Decision']) eq(k, field(panel, k).value, 'NOT CAPTURED');
  }
  eq('Alert Action', field(panel, 'Alert Action').value, r.record.calcAtAlert ? r.record.calcAtAlert.headline : 'NOT CAPTURED');
  for (const k of NEVER_CAPTURED) eq(k, field(panel, k).value, 'NOT CAPTURED');
  const ms = now - r.record.alert.alertTimeMs;
  eq('Time Since Alert', field(panel, 'Time Since Alert').value, ms < 0 ? 'UNAVAILABLE / 10:00' : ms >= 600_000 ? '10:00+ / 10:00' : `${mmss(ms)} / 10:00`);
  const ag = quoteAges(r.quote, now);
  eq('Market Data Age', field(panel, 'Market Data Age').value, !ag || ag.dataAgeSec < -DEFAULT_AUTOMATION.maxDataAgeSec ? 'UNAVAILABLE' : ag.dataAgeSec < 0 ? '0.0 s' : `${ag.dataAgeSec.toFixed(1)} s`);
  // the original row never carries another alert's ID or the shadow version
  if (s && s.recordId !== r.record.id) bad.push(`${r.record.id}: foreign snapshot`);
  if (panel.includes('RB v1.2')) bad.push(`${r.record.id}: shadow version inside the ACTIVE panel`);
  return bad;
}

const run = (name: string, every = 1) => { const fx = loadFixture(name); return runApp(fx.records, fixtureSteps(fx).filter((_s, i) => i % every === 0), { observe: true }); };

describe('Comparison · AT ALERT (FROZEN) row on the 2026-11-04 historical fixtures', { timeout: 120_000 }, () => {
  for (const [name, every] of [['vrsk-1035', 6], ['bsx-1220-peers', 3], ['bsx-1300', 2], ['unh-1400', 2], ['nclh-1145', 4]] as const) {
    it(`${name}: every original value equals its recorded source, else NOT CAPTURED; snapshots never change`, () => {
      const ps = run(name, every);
      const firstSeen = new Map<string, string>();
      const bad: string[] = [];
      let genuineRows = 0;
      for (const p of ps) {
        for (const [id, s] of Object.entries(p.state.frozen)) {
          const j = JSON.stringify(s);
          if (!firstSeen.has(id)) firstSeen.set(id, j); else if (firstSeen.get(id) !== j) bad.push(`${id}: snapshot rewritten`);
        }
        for (const r of p.rows) {
          if (r.decision.decision === 'SCORING') continue;
          if (genuine(r, p.state.frozen[r.record.id])) genuineRows++;
          bad.push(...frozenRowCheck(r, p.now, p.state.frozen));
        }
      }
      expect(bad).toEqual([]);
      expect(genuineRows).toBeGreaterThan(0);
    });
  }
});

describe('Comparison · genuine, missing, late and foreign snapshots', () => {
  const [p] = runApp([LONG()], steps('AAA', [[1, 100.95]]));
  const r = p.row(p.rows[0].record.id)!;
  const real = p.state.frozen[r.record.id];

  it('a snapshot written at alert time is shown with its provenance (alert ID, write time)', () => {
    expect(genuine(r, real)).toBe(true);
    const f = field(panelOf(render(r, p.now, real)), 'Alert Score');
    expect(f.value).toBe(`${real.v11.total} / 100`);
    expect(f.captured).toBe('YES');
    expect(f.title).toContain(r.record.id);
    expect(f.title).toContain('Write-once alert snapshot (RB v1.1)');
  });
  it('no snapshot → Alert Score / Tier / Decision are NOT CAPTURED (never the current value)', () => {
    const panel = panelOf(render(r, p.now, null));
    for (const k of ['Alert Score', 'Alert Tier', 'Alert Decision']) expect([k, field(panel, k).value, field(panel, k).captured]).toEqual([k, 'NOT CAPTURED', 'NO']);
    expect(field(panel, 'Score').value).not.toBe('NOT CAPTURED'); // the current row is unaffected
  });
  it('a snapshot first written after the capture window (app opened later) is NOT CAPTURED and says why', () => {
    const late = buildAlertTimeSnapshot(r, r.record.receivedMs + 10 * 60_000, 91);
    const f = field(panelOf(render(r, p.now, late)), 'Alert Decision');
    expect(f.value).toBe('NOT CAPTURED');
    expect(f.title).toContain('not open at alert time');
  });
  it('a snapshot of another alert ID is never used', () => {
    const foreign = { ...real, recordId: 'OTHER-ALERT' };
    expect(field(panelOf(render(r, p.now, foreign)), 'Alert Score').value).toBe('NOT CAPTURED');
  });
  it('Alert Action is the server alert-time Calculator headline when recorded, NOT CAPTURED when not', () => {
    expect(field(panelOf(render(r, p.now, real)), 'Alert Action').value).toBe('NOT CAPTURED'); // synthetic record: calcAtAlert null
    const withCalc = { ...r, record: { ...r.record, calcAtAlert: { action: 'BUY_STOP' as const, headline: 'BUY STOP', entry: 101.02, stop: 100, target: 103.06, shares: 24, plannedRisk: 24.48 } } };
    const f = field(panelOf(render(withCalc, p.now, real)), 'Alert Action');
    expect(f.value).toBe('BUY STOP');
    expect(f.title).toContain('BUY_STOP');
  });
  it('execution state, data, chase and portfolio status are never captured at alert time → NOT CAPTURED with the reason', () => {
    const panel = panelOf(render(r, p.now, real));
    for (const k of NEVER_CAPTURED) { const f = field(panel, k); expect(f.value).toBe('NOT CAPTURED'); expect(f.title).toMatch(/^NOT CAPTURED — /); }
  });
  it('v1.1 ACTIVE reads the v1.1 snapshot values, never the v1.2 shadow values', () => {
    const mixed: AlertTimeSnapshot = { ...real, v11: { ...real.v11, total: 77, tier: 'WATCHLIST', decision: 'WATCHLIST' }, v12: { total: 88, max: 91, tierOptionA: 'ELITE', tierOptionB: 'ELITE', decision: 'TRADE NOW — ELITE' } };
    const panel = panelOf(render(r, p.now, mixed));
    expect([field(panel, 'Alert Score').value, field(panel, 'Alert Tier').value, field(panel, 'Alert Decision').value]).toEqual(['77 / 100', 'WATCHLIST', 'WATCHLIST']);
    expect(panel).not.toContain('RB v1.2');
  });
});

describe('Comparison · Change Since Alert (display only)', () => {
  const cell = (score: number | null, tier: StrategyCell['tiers'][number], frozen = false): StrategyCell => ({ score, tiers: [tier], decision: null, frozen });
  const a = (total: number | null, tier: 'ELITE' | 'HIGH_PRIORITY' | 'WATCHLIST' | null, decision = 'TRADE NOW — ELITE') => {
    const r = { record: { id: 'X', receivedMs: 0, alert: { alertTimeMs: 0 }, calcAtAlert: null, snapshot: null }, candidate: null } as unknown as QueueRow;
    const s = { recordId: 'X', frozenAtMs: 1000, complete: true, missing: [], v11: { total, tier, decision, detail: '', components: null }, v12: null } as unknown as AlertTimeSnapshot;
    return alertTimeAssessment(r, s, 'RB v1.1');
  };
  it('score difference = current − alert, signed; tier transition; decision transition', () => {
    expect(changeSinceAlert(a(90, 'ELITE'), cell(86, 'HIGH_PRIORITY'), 'HIGH PRIORITY — TRADE CONSIDERATION')).toEqual({ score: '86 − 90 = −4', tier: 'ELITE → HIGH', decision: 'TRADE NOW — ELITE → HIGH PRIORITY — TRADE CONSIDERATION', scoreDelta: -4 });
    expect(changeSinceAlert(a(74, 'WATCHLIST', 'WATCHLIST'), cell(75, 'WATCHLIST'), 'WATCHLIST')).toEqual({ score: '75 − 74 = +1', tier: 'Unchanged', decision: 'Unchanged', scoreDelta: 1 });
    expect(changeSinceAlert(a(80, 'WATCHLIST', 'WATCHLIST'), cell(80, 'WATCHLIST'), 'WATCHLIST').score).toBe('80 − 80 = 0');
  });
  it('N/A when either score is missing or the current score is itself the frozen value; NOT CAPTURED without a snapshot', () => {
    expect(changeSinceAlert(a(null, null), cell(86, 'HIGH_PRIORITY'), 'X').score).toBe('N/A — not scored at alert time');
    expect(changeSinceAlert(a(90, 'ELITE'), cell(90, 'ELITE', true), 'X')).toMatchObject({ score: 'N/A — no live score now', tier: 'N/A — no live tier now' });
    expect(changeSinceAlert(a(90, 'ELITE'), cell(null, null), 'X').score).toBe('N/A — no live score now');
    const none = alertTimeAssessment({ record: { id: 'X', receivedMs: 0, alert: { alertTimeMs: 0 }, calcAtAlert: null, snapshot: null }, candidate: null } as unknown as QueueRow, null, 'RB v1.1');
    expect(changeSinceAlert(none, cell(86, 'HIGH_PRIORITY'), 'X')).toMatchObject({ score: 'N/A — alert score not captured', tier: 'NOT CAPTURED', decision: 'NOT CAPTURED' });
  });
});

describe('Comparison · Time Since Alert and Market Data Age (existing timestamps, informational)', () => {
  const [p] = runApp([LONG()], steps('AAA', [[1, 100.95]]));
  const r = p.rows[0];
  it('MM:SS / 10:00 from the alert time the lifecycle uses; future → UNAVAILABLE; past the window → 10:00+', () => {
    const t = r.record.alert.alertTimeMs;
    expect(timeSinceAlert(r, t + 134_000).text).toBe('02:14 / 10:00');
    expect(timeSinceAlert(r, t - 5_000).text).toBe('UNAVAILABLE / 10:00');
    expect(timeSinceAlert(r, t + 600_000)).toMatchObject({ text: '10:00+ / 10:00', elapsed: true });
  });
  it('Market Data Age is the existing quoteAges data age (the freshness rule input); none → UNAVAILABLE', () => {
    expect(marketDataAge(r, p.now).text).toBe(`${quoteAges(r.quote, p.now)!.dataAgeSec.toFixed(1)} s`);
    expect(marketDataAge({ ...r, quote: null }, p.now).text).toBe('UNAVAILABLE');
    // a quote that arrived after the 1 s evaluation tick (normal) → 0.0 s; beyond the existing clock tolerance → UNAVAILABLE
    expect(marketDataAge(r, r.quote!.receivedMs - 600).text).toBe('0.0 s');
    expect(marketDataAge(r, r.quote!.receivedMs - 600).detail).toContain('0.6 s after');
    expect(marketDataAge(r, r.quote!.receivedMs - (DEFAULT_AUTOMATION.maxDataAgeSec * 1000 + 1)).text).toBe('UNAVAILABLE');
  });
});

describe('Comparison · the original assessment never authorizes', () => {
  it('a recorded TRADE-NOW-class decision with a current terminal CHASED stays NO TRADE (synthetic)', () => {
    const ps = runApp([LONG()], steps('AAA', [[1, 100.95], [2, 101.4]]));
    const id = ps[0].rows[0].record.id;
    const snap = ps[1].state.frozen[id];
    const r = ps[1].row(id)!;
    const panel = panelOf(render(r, ps[1].now, snap));
    expect(r.lifecycle.finalActionability).toBe('NO TRADE');
    expect(field(panel, 'Final execution state (Final Actionability)').value.startsWith('NO TRADE')).toBe(true);
    expect(field(panel, 'Alert Decision').value).toBe(snap.v11.decision); // recorded value shown for comparison only
    expect(panel).not.toMatch(/<button/);
  });
  it('the UNH live score moves while the recorded alert score stays fixed; the strip shows the live difference', () => {
    const ps: Pass[] = run('unh-1400', 2);
    const seen = new Set<string>();
    for (const p of ps) for (const r of p.rows) {
      const s = p.state.frozen[r.record.id];
      if (r.record.alert.symbol !== 'UNH' || !genuine(r, s) || r.decision.decision === 'SCORING') continue;
      const c = ACTIVE.cell(r);
      const strip = field(panelOf(render(r, p.now, s)), 'Score change').value;
      if (!c.frozen && c.score !== null && s.v11.total !== null) {
        const d = c.score - s.v11.total;
        expect(strip).toBe(`Score: ${c.score} − ${s.v11.total} = ${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)}`);
        seen.add(String(c.score));
      }
    }
    expect(seen.size).toBeGreaterThan(1); // the live score really moved during the fixture
  });
});
