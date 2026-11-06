/**
 * UI tooltips, display-only reference tier and the PLACE BUY/SELL STOP hint — presentation only.
 * Real 2026-11-06 production record Q LONG 14:40:06 (hard-rule failure → Phase C reference); other rows SYNTHETIC.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import FXQ from '../../../engine/automation/__tests__/phase-c-q-2026-11-06.json';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../../../engine/automation/alertDecision';
import { buildQueue, type QueueRow } from '../../../engine/automation/liveQueue';
import { mismatchSummary, referenceTier, scoreView, type ScoreView } from '../../../engine/automation/referenceScore';
import { classifyScore } from '../../../engine/ranker/candidateRanker';
import { cloneRankerDefaults } from '../../../engine/ranker/rankerSettings';
import { KNOWN_CLASSIFICATIONS } from '../../../engine/ranker/correlationRules';
import { RB_V1_DEFAULTS } from '../../../engine/settings';
import type { ReferenceEntry } from '../../../lib/referenceScoreHook';
import { decisionHelp, EXECUTION_HELP, FINAL_HELP, placeOrderHint, scoreHelp, tierBands, tierHelp } from '../fieldHelp';
import { InfoTip } from '../InfoTip';
import { RefTier } from '../QueueParts';

const RK = cloneRankerDefaults();
const G = RK.grades;
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const entry = (view: ScoreView, captured: ReferenceEntry['captured'] = null): ReferenceEntry => ({ view, captured, mismatch: { count: 0, label: null, headline: null, checks: [] } });
const REF = (total: number): ScoreView => ({ kind: 'REFERENCE', total, setup: 0, fit: 0, components: [], hardFails: ['INVALID_CANDLE_DIRECTION'] });

describe('verified production score → tier mapping (classifyScore, default Ranker grades)', () => {
  it('grades are 90 / 85 / 80 / 75 and the bands read exactly so', () => {
    expect(G).toEqual({ elite: 90, high: 85, watchlist: 80, low: 75 });
    expect(tierBands(G)).toBe('ELITE ≥ 90 · HIGH 85–89.9 · WATCHLIST 80–84.9 · LOW 75–79.9 · SKIP < 75');
  });
  it('0 / 54 / 74.9 / 75 / 79.9 / 80 / 84.9 / 85 / 89.9 / 90 / 100', () => {
    const want: [number, string][] = [[0, 'SKIP'], [54, 'SKIP'], [74.9, 'SKIP'], [75, 'LOW_PRIORITY'], [79.9, 'LOW_PRIORITY'], [80, 'WATCHLIST'], [84.9, 'WATCHLIST'], [85, 'HIGH_PRIORITY'], [89.9, 'HIGH_PRIORITY'], [90, 'ELITE'], [100, 'ELITE']];
    for (const [s, t] of want) expect([s, referenceTier(s, G)]).toEqual([s, t]);
  });
  it('the display-only reference tier is exactly the production classifier for every 0.1 step 0–100', () => {
    for (let i = 0; i <= 1000; i++) { const s = i / 10; expect(referenceTier(s, G)).toBe(classifyScore(s, RK)); }
  });
  it('follows edited Ranker grades (no hard-coded thresholds)', () => {
    const g = { elite: 92, high: 87, watchlist: 81, low: 70 };
    expect(referenceTier(86.9, g)).toBe('WATCHLIST');
    expect(tierBands(g)).toBe('ELITE ≥ 92 · HIGH 87–91.9 · WATCHLIST 81–86.9 · LOW 70–80.9 · SKIP < 70');
  });
});

describe('Tier display fallback (presentation only)', () => {
  const render = (e: ReferenceEntry | null | undefined) => renderToStaticMarkup(createElement(RefTier, { e, grades: G }));
  it('reference scores 0 / 54 / 79.9 / 80 / 84.9 / 85 / 90 (hard-rule failure) → grey tier labelled Reference only', () => {
    const want: [number, string][] = [[0, 'SKIP'], [54, 'SKIP'], [79.9, 'LOW'], [80, 'WATCHLIST'], [84.9, 'WATCHLIST'], [85, 'HIGH'], [90, 'ELITE']];
    for (const [s, label] of want) {
      const h = render(entry(REF(s)));
      expect(text(h)).toBe(`${label} Reference only`);
      expect(h).toMatch(/REFERENCE ONLY — NOT ELIGIBLE FOR EXECUTION/);
      expect(h).toContain('bg-ink-700'); // the existing muted pill — never a quality colour for a reference tier
    }
  });
  it('the tier follows the captured (displayed) reference value, not a later re-evaluation', () => {
    expect(text(render(entry(REF(86), { total: 79.9, setup: 50, fit: 29.9, atMs: 0, reconstructed: false })))).toBe('LOW Reference only');
  });
  it('missing / unreliable score → N/A (never SKIP); no entry → existing “—”', () => {
    const h = render(entry({ kind: 'UNAVAILABLE', reasons: ['Missing input: RVOL(20)'] }));
    expect(text(h)).toBe('N/A');
    expect(h).toContain('Missing input: RVOL(20)');
    expect(text(render(undefined))).toBe('—');
    expect(text(render(entry({ kind: 'PENDING', reasons: [] })))).toBe('—');
  });
});

describe('real record: Q LONG 14:40:06 (INVALID_CANDLE_DIRECTION) — the reference tier cannot make it actionable', () => {
  const r = structuredClone((FXQ.records as unknown as AutoAlertRecord[])[0]);
  const now = Date.parse(r.processedIso!) + 4_000;
  const quotes: Record<string, LiveQuote> = { [r.alert.symbol]: { ...r.initialQuote!, tradeIso: new Date(now - 1500).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 } };
  const q = { records: [r], candidates: [], positions: [], quotes, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: RK, classify: (s: string) => KNOWN_CLASSIFICATIONS[s] ?? { sector: `S-${s}`, industry: `I-${s}`, theme: '' }, parity: {}, strategyVersion: 'RB v1.1', frozen: {}, terminal: {} };
  it('authoritative tier stays null; displayed tier is a grey Reference-only tier; decision / ticket / final state unchanged; no PLACE hint', () => {
    const row = buildQueue(q).rows[0];
    const before = JSON.stringify(row);
    const v = scoreView(row);
    expect(v.kind).toBe('REFERENCE');
    expect(row.ranked!.tier).toBeNull();
    const h = renderToStaticMarkup(createElement(RefTier, { e: { view: v, captured: null, mismatch: mismatchSummary(row) }, grades: G }));
    expect(text(h)).toBe(`${v.kind === 'REFERENCE' ? { SKIP: 'SKIP', LOW_PRIORITY: 'LOW', WATCHLIST: 'WATCHLIST', HIGH_PRIORITY: 'HIGH', ELITE: 'ELITE' }[referenceTier(v.total, G)] : ''} Reference only`);
    expect(row.decision.decision).toBe('DATA REVIEW REQUIRED');
    expect(row.decision.ticket).toBeNull();
    expect(row.lifecycle.finalActionability).toBe('NO TICKET');
    expect(placeOrderHint(row)).toBeNull();
    expect(JSON.stringify(row)).toBe(before); // rendering never mutates the row
  });
});

describe('PLACE BUY / SELL STOP hint (case A only)', () => {
  const ticket = (action: 'BUY' | 'SELL') => ({ action, orderType: 'STOP' as const, quantity: 99, price: 201.26, stopLoss: 200.3, takeProfit: 203.18 });
  const mk = (o: { action?: 'BUY' | 'SELL'; ticket?: boolean; lc?: Record<string, unknown>; status?: string } = {}) => ({
    decision: { decision: 'HIGH PRIORITY — TRADE CONSIDERATION', detail: 'Score 86 · rank #1', ticket: o.ticket === false ? null : ticket(o.action ?? 'BUY') },
    lifecycle: { executionState: 'ACTIVE', finalActionability: 'READY', reason: '', terminal: false, entryWindowClosed: false, portfolioUnverified: false, setupFailed: null, ...o.lc },
    candidate: { status: o.status ?? 'NEW' },
  }) as unknown as QueueRow;
  it('READY + ACTIVE + ticket → PLACE BUY STOP (LONG) / PLACE SELL STOP (SHORT); manual-execution wording', () => {
    expect(placeOrderHint(mk())!.label).toBe('PLACE BUY STOP');
    expect(placeOrderHint(mk({ action: 'SELL' }))!.label).toBe('PLACE SELL STOP');
    expect(placeOrderHint(mk())!.detail).toMatch(/manually at your broker — RB never submits orders/);
  });
  it('never shown when the existing state withholds or ends the ticket', () => {
    const cases: Parameters<typeof mk>[0][] = [
      { ticket: false },
      { lc: { finalActionability: 'NO TICKET' } },
      { lc: { executionState: 'NOT CROSSED' } },
      { lc: { heldBy: 'X' } },
      { lc: { chaseLatched: true } },
      { lc: { triggerMissed: true, finalActionability: 'NO TRADE' } },
      { lc: { setupFailed: { observedAtMs: 1, price: 1, stop: 1 } } },
      { lc: { entryWindowClosed: true } },
      { lc: { portfolioUnverified: true } },
      { lc: { observationWithheld: 'clock' } },
      { status: 'PENDING' },
      { status: 'FILLED' },
    ];
    for (const c of cases) expect([JSON.stringify(c), placeOrderHint(mk(c))]).toEqual([JSON.stringify(c), null]);
  });
});

describe('tooltip content and accessibility', () => {
  it('texts state the verified rules; minimum actionable score 85; no Policy B threshold', () => {
    const all = [scoreHelp(G), tierHelp(G), decisionHelp(G), EXECUTION_HELP, FINAL_HELP].join('\n');
    expect(scoreHelp(G)).toContain('Minimum actionable score: 85');
    expect(scoreHelp(G)).toContain('cannot authorize a trade');
    expect(tierHelp(G)).toContain('not authorization to place an order');
    expect(EXECUTION_HELP).toMatch(/BUY STOP \(LONG\) or SELL STOP \(SHORT\)/);
    expect(EXECUTION_HELP).toContain('Placing a stop order is different from the stop order being triggered');
    expect(EXECUTION_HELP).toContain('0.25 ATR');
    expect(EXECUTION_HELP).toContain('10-minute alert window');
    expect(EXECUTION_HELP).toContain('15:30 ET');
    expect(FINAL_HELP).toContain('never submits orders');
    expect(all).not.toMatch(/Policy B|exception/i);
    const mins = [...all.matchAll(/(?:actionable score|score ≥)\s*:?\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(mins.length).toBeGreaterThan(1);
    expect(mins.every((m) => m === 85 || m === 90)).toBe(true); // 85 = minimum actionable; 90 = ELITE band — never 80
  });
  it('icon: a real button with an accessible name, collapsed by default, no visible text (field text unchanged)', () => {
    const h = renderToStaticMarkup(createElement(InfoTip, { label: 'Score', text: 'x' }));
    expect(h).toMatch(/<button[^>]*type="button"/);
    expect(h).toContain('aria-label="About Score"');
    expect(h).toContain('aria-expanded="false"');
    expect(text(h)).toBe('');
    expect(h).not.toContain('role="tooltip"'); // closed until hover / focus / tap
  });
});

describe('isolation', () => {
  it('fieldHelp and InfoTip are imported only by the queue display; referenceTier only via the display', () => {
    const root = join(__dirname, '..', '..', '..', '..');
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') walk(p); } else if (/\.(ts|tsx|mts)$/.test(n)) files.push(p); } };
    walk(join(root, 'src')); walk(join(root, 'netlify'));
    const users = (re: RegExp) => files.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f).split(sep).join('/')).sort();
    expect(users(/from '\.\/fieldHelp'|from '[^']*\/fieldHelp'/)).toEqual(['src/components/live/QueueParts.tsx']);
    expect(users(/from '\.\/InfoTip'|from '[^']*\/InfoTip'/)).toEqual(['src/components/live/QueueParts.tsx']);
    expect(users(/referenceTier/)).toEqual(['src/components/live/QueueParts.tsx', 'src/engine/automation/referenceScore.ts']);
  });
});
