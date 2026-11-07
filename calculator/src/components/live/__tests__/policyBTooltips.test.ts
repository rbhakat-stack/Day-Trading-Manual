/** Score / Tier / Decision help follow the effective RVOL policy state; with both policies OFF the texts are unchanged. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { cloneRankerDefaults } from '../../../engine/ranker/rankerSettings';
import { v12MaxScore } from '../../../engine/automation/v12/v12Thresholds';
import { decisionHelp, EXECUTION_HELP, FINAL_HELP, scoreHelp, tierHelp } from '../fieldHelp';
import { LiveQueuePage, type LiveActions } from '../LiveQueuePage';

const G = cloneRankerDefaults().grades;
const S2 = { a: true, b: false };
const S3 = { a: true, b: true };

describe('both policies OFF: the existing help, unchanged', () => {
  it('undefined / null / {a:false,b:false} give byte-identical texts with no policy mention', () => {
    for (const f of [scoreHelp, tierHelp, decisionHelp]) {
      const base = f(G);
      expect(f(G, null)).toBe(base);
      expect(f(G, { a: false, b: false })).toBe(base);
      expect(f(G, { a: false, b: true })).toBe(base); // B without A is OFF
      expect(base).not.toMatch(/Policy|RVOL POLICY|exception/i);
    }
    expect(scoreHelp(G)).toContain('Minimum actionable score: 85. Tier bands');
  });
});

describe('STATE 2 — Policy A only', () => {
  it('explains Policy A and that the minimum stays 85 for every alert; never mentions 80 as a minimum', () => {
    for (const t of [scoreHelp(G, S2), decisionHelp(G, S2)]) {
      expect(t).toMatch(/RVOL POLICY A ON/);
      expect(t).toMatch(/minimum actionable score stays 85 for every alert/);
      expect(t).toMatch(/never places trades automatically/);
      expect(t).not.toMatch(/minimum (score )?of 80|exception/i);
    }
    expect(tierHelp(G, S2)).toBe(tierHelp(G)); // tier meaning unchanged
  });
});

describe('STATE 3 — Policy A + B', () => {
  it('Score: standard 85, approved RVOL exceptions 80; B only after A accepts an audited RVOL-only mismatch; WATCHLIST tier; no auto-trading', () => {
    const t = scoreHelp(G, S3);
    expect(t).toContain('Minimum actionable score: 85 (approved Policy A + B RVOL exceptions: 80)');
    expect(t).toMatch(/Policy B applies only after Policy A accepts an audited RVOL-only mismatch/);
    expect(t).toMatch(/every other alert still needs 85/);
    expect(t).toMatch(/80–84\.9 stays WATCHLIST tier/);
    expect(t).toMatch(/Tier never overrides eligibility or safety requirements/);
    expect(t).toMatch(/never places trades automatically/);
  });
  it('Tier: an 80–84.9 exception can be actionable but stays WATCHLIST', () => {
    expect(tierHelp(G, S3)).toMatch(/approved RVOL exception scoring 80–84\.9 can be actionable but its tier stays WATCHLIST/);
  });
  it('Decision: explains the "RVOL exception (minimum 80)" detail and that all other checks still apply', () => {
    const t = decisionHelp(G, S3);
    expect(t).toMatch(/RVOL exception \(minimum 80\)/);
    expect(t).toMatch(/All other checks — timing, chase, risk, portfolio — still apply/);
  });
  it('Execution and Final State help are policy-independent (unchanged)', () => {
    expect(EXECUTION_HELP).not.toMatch(/Policy/);
    expect(FINAL_HELP).not.toMatch(/Policy/);
  });
});

describe('wiring', () => {
  it('rendered Live Queue: rvolPolicyState absent ≡ null (identical markup)', () => {
    const noop = () => {};
    const actions: LiveActions = { submit: noop, skip: noop, watch: noop, openInCalculator: noop, classify: noop, reprocess: noop, keep: noop, replace: noop };
    const RK = cloneRankerDefaults();
    const props = { rows: [], suggestions: [], now: 0, enabled: true, feed: { lastOkMs: 0, error: null }, quoteError: null, parityStatus: 'NOT VALIDATED' as const, versionLabel: 'RB v1.1', actions, onOpenSettings: noop, shadow: { maxScore: v12MaxScore(RK), optionAGrades: RK.grades, logCount: 0, onExportLog: noop } };
    expect(renderToStaticMarkup(createElement(LiveQueuePage, { ...props, rvolPolicyState: null }))).toBe(renderToStaticMarkup(createElement(LiveQueuePage, props)));
  });
  it('the App passes the EFFECTIVE state (B without A → null) and QueueParts threads it to the header icons and the Field-help line', () => {
    const src = (p: string) => readFileSync(join(__dirname, '..', '..', '..', p), 'utf8');
    expect(src('App.tsx')).toMatch(/rvolPolicyState=\{rvolPolicyEff\.a \? \{ a: rvolPolicyEff\.a, b: rvolPolicyEff\.b \} : null\}/);
    const qp = src('components/live/QueueParts.tsx');
    expect(qp).toMatch(/fieldHelp\(h, c\.scoreLabel, optionAGrades, rvolPolicyState\)/);
    expect(qp).toMatch(/<FieldHelpStrip grades=\{optionAGrades\} st=\{rvolPolicyState\} \/>/);
  });
});
