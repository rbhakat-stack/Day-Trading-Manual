/**
 * UI consolidation — the "Trade Decision & Order" panel shows exactly the values the existing queue already renders.
 * Every assertion compares the new panel with the UNCHANGED existing rendering of the same field in the same snapshot
 * (the four detail panels, the table helpers and the strategy presenter). Historical fixtures: 2026-11-04 production
 * records + Alpaca SIP round lots (src/safety/__tests__/fixtures, see their _provenance); synthetic cases are labelled.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { QueueRow } from '../../../engine/automation/liveQueue';
import type { ManualPosition } from '../../../engine/ranker/opportunityTypes';
import { QueueDetails } from '../QueueParts';
import { decisionBadge, executionBadge, presentationFor, queueLayout, TIER_SHORT } from '../queueView';
import { fixtureSteps, loadFixture, RK, runApp, type Pass } from '../../../safety/__tests__/harness';
import { at, LONG, steps, withV12 } from '../../../safety/__tests__/synthetic';
import { recordWith } from '../../../engine/automation/__tests__/fixtures';

const layout = queueLayout(presentationFor('RB v1.1'), { v12MaxScore: 91 });
const ACTIVE = layout.find((c) => c.role === 'ACTIVE')!;
const actions = { submit: vi.fn(), skip: vi.fn(), watch: vi.fn(), openInCalculator: vi.fn(), classify: vi.fn(), reprocess: vi.fn(), keep: vi.fn(), replace: vi.fn() };
const render = (r: QueueRow, now: number) => renderToStaticMarkup(createElement(QueueDetails, { r, now, actions, layout, maxScore: 91, optionAGrades: RK.grades }));

/* ── tiny balanced-tag reader for server-rendered markup (no DOM dependency) ── */
const decode = (t: string) => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'");
function elementAt(html: string, start: number): string {
  const re = /<(\/?)([a-zA-Z0-9]+)([^>]*?)(\/?)>/g;
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[4] === '/') continue; // self-closing
    if (m[1] === '/') { depth--; if (depth === 0) return html.slice(start, re.lastIndex); } else depth++;
  }
  throw new Error('unbalanced');
}
const text = (frag: string) => decode(frag.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').replace(/ \/ /g, ' / ').trim();
const panelOf = (html: string) => { const i = html.indexOf('data-decision-panel='); return elementAt(html, html.lastIndexOf('<', i)); };
/** Value text of a field inside the new panel, without its label and LIVE / FROZEN marker. */
function panelValue(panel: string, label: string): { value: string; mark: string | null } {
  const i = panel.indexOf(`data-field="${label}"`);
  if (i < 0) throw new Error(`panel field missing: ${label}`);
  const el = elementAt(panel, panel.lastIndexOf('<', i));
  const mark = /data-mark="(LIVE|FROZEN)"/.exec(el)?.[1] ?? null;
  const t = text(el.replace(/<span[^>]*data-mark="[^"]*"[^>]*>[\s\S]*?<\/span>/, ''));
  return { value: t.startsWith(label) ? t.slice(label.length).trim() : t, mark };
}
/** Value text of an existing detail-panel row (<dt>label</dt><dd>value</dd>). */
function oldRow(html: string, label: string): string {
  const k = `<dt class="text-ink-300">${label.replace(/&/g, '&amp;')}</dt>`;
  const base = html.indexOf('data-full-details'); // only the unchanged existing detail panels
  if (base < 0) throw new Error('existing detail panels missing');
  const i = html.indexOf(k, base);
  if (i < 0) throw new Error(`existing row missing: ${label}`);
  return text(elementAt(html, i + k.length));
}

const ORDER = ['Entry', 'Stop', 'Target', 'Quantity'] as const;
const SAME_AS_DETAIL_PANEL = ['Data status', 'Chase status', 'Portfolio status', 'Current execution state', 'Dollar risk (planned)', 'ATR (signal)', 'Chase distance', 'Allowed chase distance', 'Signal candle', 'RB v1.1 hard fails', 'Portfolio slots', 'Portfolio heat'];

/** Full parity check of one row: returns the list of mismatches (empty = identical). */
function parity(r: QueueRow, now: number): string[] {
  const html = render(r, now);
  const panel = panelOf(html);
  const bad: string[] = [];
  const eq = (field: string, got: string, want: string) => { if (got !== want) bad.push(`${r.record.id} ${field}: panel "${got}" ≠ existing "${want}"`); };
  for (const k of ORDER) eq(k, panelValue(panel, k).value, oldRow(html, k));
  for (const k of SAME_AS_DETAIL_PANEL) eq(k, panelValue(panel, k).value, oldRow(html, k));
  const at = r.record.alert.timeSource === 'RECEIVED' ? 'Alert time (server)' : 'Alert time (payload)';
  eq(at, panelValue(panel, at).value, oldRow(html, at));
  // Final execution state: same text as the existing row ("STATE" or "STATE — reason").
  const fin = panelValue(panel, 'Final execution state (Final Actionability)').value;
  eq('Final execution state (Final Actionability)', fin, oldRow(html, 'Final execution state (Final Actionability)').replace(' — ', ' '));
  // Decision: the table's Decision badge; Score / Tier: the ACTIVE strategy presenter (what the table shows).
  eq('Decision', panelValue(panel, 'Decision').value, decisionBadge(r).label);
  eq('Current execution state (table)', panelValue(panel, 'Current execution state').value, executionBadge(r).label);
  const cell = ACTIVE.cell(r);
  const score = panelValue(panel, 'Score');
  eq('Score', score.value.split(' / ')[0], String(cell.score ?? '—'));
  eq('Score marker', score.mark ?? '', cell.frozen ? 'FROZEN' : 'LIVE');
  eq('Tier', panelValue(panel, 'Tier').value, cell.tiers[0] ? TIER_SHORT[cell.tiers[0]] : '—');
  // Execution Type: passed through from the same plan object as Entry / Stop / Target / Quantity — never inferred.
  const ot = r.candidate?.orderType ?? r.live?.plan?.orderType ?? '—';
  eq('Execution Type', panelValue(panel, 'Execution Type').value, ot);
  eq('Order marker', panelValue(panel, 'Entry').mark ?? panel.match(/Order Details[\s\S]*?data-mark="(LIVE|FROZEN)"/)?.[1] ?? '', r.candidate ? 'FROZEN' : 'LIVE');
  return bad;
}
const run = (name: string, every = 1) => { const fx = loadFixture(name); return { fx, ps: runApp(fx.records, fixtureSteps(fx).filter((_s, i) => i % every === 0), { observe: true }) }; };
const allMismatches = (ps: Pass[]) => ps.flatMap((p) => p.rows.filter((r) => r.decision.decision !== 'SCORING').flatMap((r) => parity(r, p.now)));

describe('UI · panel = existing rendering, every row of the 2026-11-04 historical fixtures', { timeout: 120_000 }, () => {
  // Sampled replay steps keep this file light enough not to starve the parallel suites; the exhaustive every-row,
  // every-pass comparison of the whole day (83 alerts) is the release's separate whole-day parity run.
  for (const [name, every] of [['vrsk-1035', 6], ['bsx-1220-peers', 3], ['bsx-1300', 1], ['unh-1400', 1], ['nclh-1145', 4]] as const) {
    it(`${name}: zero field differences`, () => {
      const { ps } = run(name, every);
      expect(ps.length).toBeGreaterThan(50);
      expect(allMismatches(ps)).toEqual([]);
    });
  }
  it('VRSK LONG at 10:35:12 reads 86 · HIGH · TRADE READY · ACTIVE · READY · BUY STOP 201.26 / 200.30 / 203.18 × 99', () => {
    const { ps } = run('vrsk-1035');
    const p = ps.find((x) => x.row('VRSK-L-103509-494e49')?.lifecycle.finalActionability === 'READY')!;
    const panel = panelOf(render(p.row('VRSK-L-103509-494e49')!, p.now));
    const v = (k: string) => panelValue(panel, k).value;
    expect([v('Score'), v('Tier'), v('Decision'), v('Current execution state'), v('Final execution state (Final Actionability)')]).toEqual(['86 / 100', 'HIGH', 'TRADE READY', 'ACTIVE', 'READY']);
    expect([v('Entry'), v('Stop'), v('Target'), v('Quantity'), v('Execution Type')]).toEqual(['201.26', '200.30', '203.18', '99', 'BUY STOP']);
    expect(panel).toContain('RB v1.1</span> (ACTIVE) — Trade Decision &amp; Order');
  });
});

describe('UI · LONG / SHORT order instruction is passed through unchanged (historical records)', { timeout: 120_000 }, () => {
  it('every LONG plan shows BUY STOP and every SHORT plan shows SELL STOP — exactly the plan\'s own orderType', () => {
    const seen = new Set<string>();
    for (const name of ['vrsk-1035', 'bsx-1300', 'unh-1400', 'nclh-1145']) {
      for (const p of run(name, 4).ps) for (const r of p.rows) {
        const ot = r.candidate?.orderType ?? r.live?.plan?.orderType;
        if (!ot) continue;
        const shown = panelValue(panelOf(render(r, p.now)), 'Execution Type').value;
        expect(shown).toBe(ot);
        seen.add(`${r.record.alert.direction}:${shown}`);
      }
    }
    expect(seen).toContain('LONG:BUY STOP');
    expect(seen).toContain('SHORT:SELL STOP'); // VEEV SHORT in the bsx-1300 fixture
    expect([...seen].filter((x) => x === 'LONG:SELL STOP' || x === 'SHORT:BUY STOP')).toEqual([]);
  });
});

describe('UI · all important states render the existing values (synthetic where 11/04 has no example — labelled)', () => {
  const SHORT = () => withV12(recordWith({ symbol: 'BBB', direction: 'SHORT', alertIso: '2026-10-30T10:15:04-04:00', price: 100.05, values: { open: 101, high: 101, low: 100, close: 100, atr: 1, ema9: 100.3, ema20: 100.9, rsi: 33, rvol: 4, vwap: 100.7, close15m: 100, ema20_15m: 101 } }));
  const cases: [string, () => { row: QueueRow; now: number }][] = [
    ['ELITE actionable (synthetic LONG)', () => { const [p] = runApp([LONG()], steps('AAA', [[1, 100.95]])); return { row: p.rows[0], now: p.now }; }],
    ['SHORT SELL STOP actionable (synthetic)', () => { const [p] = runApp([SHORT()], steps('BBB', [[1, 100.05]])); return { row: p.rows[0], now: p.now }; }],
    ['CHASED (synthetic)', () => { const ps = runApp([LONG()], steps('AAA', [[1, 100.95], [2, 101.4]])); return { row: ps[1].rows[0], now: ps[1].now }; }],
    ['recorded chase then pullback (synthetic)', () => { const ps = runApp([LONG()], steps('AAA', [[1, 100.95], [2, 101.4], [3, 100.95]])); return { row: ps[2].rows[0], now: ps[2].now }; }],
    ['SETUP FAILED (synthetic)', () => { const ps = runApp([LONG()], steps('AAA', [[1, 100.95], [2, 99.95], [3, 100.95]])); return { row: ps[2].rows[0], now: ps[2].now }; }],
    ['DATA REVIEW (synthetic)', () => { const [p] = runApp([LONG({ issues: [{ kind: 'REVIEW', code: 'ALERT_NOT_REPRODUCED', message: 'RVOL' }] })], steps('AAA', [[1, 100.95]])); return { row: p.rows[0], now: p.now }; }],
    ['missing observation continuity (synthetic)', () => { const [p] = runApp([LONG()], steps('AAA', [[3, 100.95]]), { observe: true }); return { row: p.rows[0], now: p.now }; }],
    ['EXPIRED — STALE (synthetic)', () => { const ps = runApp([LONG()], steps('AAA', [[1, 100.95], [10.5, 100.95]])); return { row: ps[1].rows[0], now: ps[1].now }; }],
    ['after the 15:30 entry window (synthetic alert 15:35)', () => { const rec = LONG({ alertIso: '2026-10-30T15:35:04-04:00' }); const [p] = runApp([rec], [{ now: Date.parse('2026-10-30T15:36:04-04:00'), quotes: { AAA: { price: 100.95, tradeIso: new Date(Date.parse('2026-10-30T15:36:02-04:00')).toISOString(), fetchedIso: new Date(Date.parse('2026-10-30T15:36:03.5-04:00')).toISOString(), receivedMs: Date.parse('2026-10-30T15:36:03.5-04:00') } } }]); return { row: p.rows[0], now: p.now }; }],
    ['portfolio unverified (synthetic)', () => { const [p] = runApp([LONG()], steps('AAA', [[1, 100.95]]), { portfolioGate: 'Broker data unavailable' }); return { row: p.rows[0], now: p.now }; }],
    ['portfolio full — 4 open positions (synthetic)', () => { const pos = (t: string): ManualPosition => ({ id: t, ticker: t, direction: 'LONG', sector: 'S-' + t, industry: 'I-' + t, theme: '', positionValue: 15000, plannedRisk: 50, entry: 10, stop: 9, target: 12, status: 'OPEN' }) as ManualPosition; const [p] = runApp([LONG()], steps('AAA', [[1, 100.95]]), { positions: ['W', 'X', 'Y', 'Z'].map(pos) }); return { row: p.rows[0], now: p.now }; }],
    ['submitted (synthetic)', () => { const ps = runApp([LONG()], steps('AAA', [[1, 100.95], [2, 100.95]]), { before: (now, cs) => (now >= at(2) ? cs.map((c) => ({ ...c, status: 'PENDING' as const })) : cs) }); return { row: ps[1].rows[0], now: ps[1].now }; }],
    ['filled (synthetic)', () => { const ps = runApp([LONG()], steps('AAA', [[1, 100.95], [2, 101.3]]), { before: (now, cs) => (now >= at(2) ? cs.map((c) => ({ ...c, status: 'FILLED' as const })) : cs) }); return { row: ps[1].rows[0], now: ps[1].now }; }],
    ['closed — target hit (synthetic)', () => { const ps = runApp([LONG()], steps('AAA', [[1, 100.95], [2, 103.1]]), { before: (now, cs) => (now >= at(2) ? cs.map((c) => ({ ...c, status: 'TARGET_HIT' as const })) : cs) }); return { row: ps[1].rows[0], now: ps[1].now }; }],
  ];
  for (const [name, make] of cases) {
    it(`${name}: zero field differences`, () => {
      const { row, now } = make();
      expect(parity(row, now)).toEqual([]);
    });
  }
  it('historical WATCHLIST near HIGH (BSX 13:00:15, 82) and SKIP (UNH 14:00:09, 74) keep their existing decisions', () => {
    const b = run('bsx-1300').ps[2].row('BSX-L-130015-7a1518')!;
    const u = run('unh-1400').ps[2].row('UNH-L-140009-ddff0d')!;
    expect(panelValue(panelOf(render(b, 0)), 'Decision').value).toBe(decisionBadge(b).label);
    expect(panelValue(panelOf(render(u, 0)), 'Decision').value).toBe('SKIP');
  });
});

describe('UI · live scores stay live; markers follow the real source', () => {
  it('UNH 14:00:09: the panel score moves 74 ↔ 75 exactly with the engine (LIVE marker), the frozen snapshot stays 74', () => {
    const { ps } = run('unh-1400');
    const shown = new Set<string>();
    for (const p of ps) {
      const r = p.row('UNH-L-140009-ddff0d');
      if (!r?.ranked?.total) continue;
      const s = panelValue(panelOf(render(r, p.now)), 'Score');
      expect(s.value.split(' / ')[0]).toBe(String(r.ranked.total));
      expect(s.mark).toBe('LIVE');
      shown.add(s.value);
    }
    expect([...shown].sort()).toEqual(['74 / 100', '75 / 100']);
    expect(ps[ps.length - 1].state.frozen['UNH-L-140009-ddff0d'].v11.total).toBe(74);
  });
  it('a submitted trade shows its alert-time score as FROZEN (the presenter\'s existing rule), with the live value beside it', () => {
    const ps = runApp([LONG()], steps('AAA', [[1, 100.95], [2, 100.95]]), { before: (now, cs) => (now >= at(2) ? cs.map((c) => ({ ...c, status: 'PENDING' as const })) : cs) });
    const r = ps[1].rows[0];
    const s = panelValue(panelOf(render(r, ps[1].now)), 'Score');
    expect(s.mark).toBe(ACTIVE.cell(r).frozen ? 'FROZEN' : 'LIVE');
  });
  it('the panel offers no new action (no broker link, no order button) and keeps the existing controls', () => {
    const [p] = runApp([LONG()], steps('AAA', [[1, 100.95]]));
    const html = render(p.rows[0], p.now);
    expect(html).not.toMatch(/ENTER ORDER|alpaca\.markets|href=/i);
    expect(panelOf(html)).not.toMatch(/<button/);
    expect(html).toContain('Mark order submitted');
    expect(html).toContain('Open in manual Calculator');
    expect(html).toContain('data-legend="live-frozen"');
  });
  it('v1.2 SHADOW stays a separate comparison strip, never inside the ACTIVE panel', () => {
    const [p] = runApp([LONG()], steps('AAA', [[1, 100.95]]));
    const html = render(p.rows[0], p.now);
    expect(panelOf(html)).not.toContain('RB v1.2');
    expect(html).toMatch(/data-comparison="shadow"[\s\S]*RB v1.2[\s\S]*comparison only/);
  });
});
