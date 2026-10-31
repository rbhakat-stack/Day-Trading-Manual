/**
 * LOCAL PREVIEW ONLY (Step 7) — renders the real Live Alert Queue page with SYNTHETIC records and TEST/HYPOTHETICAL
 * rule sets so the RB v1.2 SHADOW presentation can be checked in a browser. Served by `vite` dev at
 * /tools/preview/v12-shadow.html; not imported by the app and not part of the production build. The production
 * registry (audited RBTS-L-001 / RBTS-S-001) is not used here — the TEST entries below exist only in this page.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { LiveQueuePage, type LiveActions } from '../components/live/LiveQueuePage';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../engine/automation/alertDecision';
import type { AlertTimeValues } from '../engine/automation/alertSnapshot';
import { etToEpoch } from '../engine/automation/etTime';
import { buildQueue } from '../engine/automation/liveQueue';
import { recordWith } from '../engine/automation/__tests__/fixtures';
import { receiptAudit, withReconstruction, type AutoAlertRecordV12 } from '../engine/automation/v12/audit';
import type { RuleSetEntry } from '../engine/automation/v12/ruleSets';
import { freezeShadowScores } from '../engine/automation/v12/shadowLog';
import { v12MaxScore } from '../engine/automation/v12/v12Thresholds';
import { cloneRankerDefaults } from '../engine/ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../engine/settings';

const TEST_REG: RuleSetEntry[] = [
  { id: 'RBTS-L-TEST', direction: 'LONG', rulesVersion: 'RB v1.2', audited: 'TEST', checklistRef: 'TEST/HYPOTHETICAL — local preview only', active: true, rules: ['TEST'] },
  { id: 'RBTS-S-TEST', direction: 'SHORT', rulesVersion: 'RB v1.2', audited: 'TEST', checklistRef: 'TEST/HYPOTHETICAL — local preview only', active: true, rules: ['TEST'] },
];
const D = '2026-10-30';
const FIVE = 300_000;
const NOW = etToEpoch(D, '10:18:00');

function rec(o: { symbol: string; direction?: 'LONG' | 'SHORT'; values?: Partial<AlertTimeValues>; ruleSet?: string | null; lagSec?: number; v12?: boolean; noRvol?: boolean }): AutoAlertRecordV12 {
  const direction = o.direction ?? 'LONG';
  const end = etToEpoch(D, '10:15');
  const rm = end + (o.lagSec ?? 12) * 1000;
  const r: AutoAlertRecord = recordWith({ symbol: o.symbol, direction, alertIso: new Date(rm).toISOString(), receivedMs: rm, values: { rvol: 1.6, ...o.values }, price: direction === 'LONG' ? 100.95 : 100.05 });
  r.alert.timeSource = 'RECEIVED';
  r.snapshot!.signal = { startIso: new Date(end - FIVE).toISOString(), endIso: new Date(end).toISOString(), label: '10:10–10:15' };
  if (o.v12 === false) return r;
  let rvolOptional = null;
  if (o.noRvol) {
    rvolOptional = { ...r.snapshot!, values: { ...r.snapshot!.values!, rvol: Number.NaN } };
    r.snapshot = { ...r.snapshot!, values: null, issues: [{ kind: 'INCOMPLETE', code: 'RVOL20_UNAVAILABLE', message: 'RVOL20 could not be calculated from the available bars.' }] };
  }
  const body = o.ruleSet === null ? {} : { rule_set: o.ruleSet ?? (direction === 'LONG' ? 'RBTS-L-TEST' : 'RBTS-S-TEST') };
  const a = receiptAudit({ body, symbol: o.symbol, direction, receivedMs: rm, v11Key: r.dedupeKey, registry: TEST_REG });
  return { ...r, v12: withReconstruction(a, r, [], direction, DEFAULT_AUTOMATION.parity, rvolOptional) };
}

const SHORT_OK: Partial<AlertTimeValues> = { open: 101, high: 101, low: 100, close: 100, ema9: 100.1, ema20: 100.7, vwap: 100.6, rsi: 35, close15m: 100, ema20_15m: 101, rvol: 2.2 };
const records: AutoAlertRecordV12[] = [
  rec({ symbol: 'NVDA', values: { rsi: 78 } }), // qualified · B HIGH · A WATCHLIST
  rec({ symbol: 'AMD', values: { rsi: 52 } }), // qualified · B WATCHLIST · A LOW · RSI parity warning
  rec({ symbol: 'AAPL', values: { open: 101.2, close: 100.6, high: 101.3, low: 100.4 } }), // SIP candle red → waived veto (v1.1 hard-fails)
  rec({ symbol: 'NEE', direction: 'SHORT', values: SHORT_OK }), // qualified SHORT
  rec({ symbol: 'GM', noRvol: true }), // SIP RVOL unavailable → v1.2 continues from the RVOL-optional rebuild
  rec({ symbol: 'IBM', ruleSet: null }), // production today: no rule_set → NOT QUALIFIED
  rec({ symbol: 'MSFT', ruleSet: 'RBTS-L-001' }), // not in this page's TEST registry → UNKNOWN (shows the unknown-rule-set presentation)
  rec({ symbol: 'VRSK', lagSec: 150 }), // > 120 s after close → mapping AMBIGUOUS → DATA REVIEW
  rec({ symbol: 'F', v12: false }), // pre-v1.2 record
];
const SECTORS: Record<string, string> = { NVDA: 'Semis', AMD: 'Semis2', AAPL: 'Hardware', NEE: 'Utilities', GM: 'Autos', IBM: 'IT', MSFT: 'Software', VRSK: 'Data', F: 'Autos2' };
const quotes: Record<string, LiveQuote> = Object.fromEntries(records.map((r) => [r.alert.symbol, { price: r.initialQuote!.price, tradeIso: new Date(NOW - 1000).toISOString(), fetchedIso: new Date(NOW - 500).toISOString(), receivedMs: NOW - 500 }]));
const rk = cloneRankerDefaults();
const q = buildQueue({ records, candidates: [], positions: [], quotes, now: NOW, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk, classify: (s) => (SECTORS[s] ? { sector: SECTORS[s], industry: SECTORS[s], theme: '' } : null), parity: {}, strategyVersion: 'RB v1.1' });
const log = freezeShadowScores({}, q.rows, NOW).log;
const noop = () => {};
const actions: LiveActions = { submit: noop, skip: noop, watch: noop, openInCalculator: noop, classify: noop, reprocess: noop, keep: noop, replace: noop };

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className="mx-auto max-w-[1600px] space-y-3 p-4 text-ink-100">
      <p className="rounded border-2 border-dashed border-warn px-3 py-2 text-sm font-bold text-warn">
        LOCAL PREVIEW — synthetic records with TEST/HYPOTHETICAL rule sets (RBTS-L-TEST / RBTS-S-TEST). Not production data; the production registry holds only the audited RBTS-L-001 / RBTS-S-001.
      </p>
      <LiveQueuePage
        rows={q.rows}
        suggestions={q.suggestions}
        now={NOW}
        enabled
        feed={{ lastOkMs: NOW - 2000, error: null }}
        quoteError={null}
        parityStatus="NOT VALIDATED"
        versionLabel="RB v1.1 · FROZEN (local preview)"
        actions={actions}
        onOpenSettings={noop}
        shadow={{ maxScore: v12MaxScore(rk), optionAGrades: rk.grades, logCount: Object.keys(log).length, onExportLog: noop }}
      />
    </div>
  </StrictMode>,
);
