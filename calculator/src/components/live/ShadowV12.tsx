/**
 * RB v1.2 SHADOW presentation (Step 7). Display only: nothing here offers a ticket, an order or an action. The active
 * production decision is always the RB v1.1 one shown elsewhere in the queue.
 */
import type { QueueRow } from '../../engine/automation/liveQueue';
import type { AutoAlertRecordV12 } from '../../engine/automation/v12/audit';
import type { V12Decision } from '../../engine/automation/v12/decideAlertV12';
import type { ConditionDiagnostic } from '../../engine/automation/v12/parityDiagnostics';
import { V12_SHADOW_GRADES, type Grades } from '../../engine/automation/v12/v12Thresholds';

type Tone = 'ts' | 'sip' | 'rb' | 'shadow' | 'warn' | 'review' | 'muted';
const TONES: Record<Tone, string> = {
  ts: 'border-[#5b8cff]/60 text-[#9db8ff]',
  sip: 'border-ink-500 text-ink-300',
  rb: 'border-long/50 text-long',
  shadow: 'border-[#b48cff]/60 text-[#cdb3ff]',
  warn: 'border-warn/60 text-warn',
  review: 'border-short/60 text-short',
  muted: 'border-ink-600 text-ink-400',
};

export const Badge = ({ tone, children, title }: { tone: Tone; children: string; title?: string }) => (
  <span title={title} className={`inline-block rounded border px-1 py-px text-[9px] font-bold uppercase leading-tight tracking-wider ${TONES[tone]}`}>{children}</span>
);

const TIER_SHORT: Record<string, string> = { ELITE: 'ELITE', HIGH_PRIORITY: 'HIGH', WATCHLIST: 'WATCH', LOW_PRIORITY: 'LOW', SKIP: 'SKIP' };
const TIER_LONG: Record<string, string> = { ELITE: 'Elite', HIGH_PRIORITY: 'High priority', WATCHLIST: 'Watchlist', LOW_PRIORITY: 'Low priority', SKIP: 'Skip' };
const tierShort = (t: string | null | undefined) => (t ? TIER_SHORT[t] ?? t : '—');
const tierLong = (t: string | null | undefined) => (t ? TIER_LONG[t] ?? t : '—');
const grades = (g: { elite: number; high: number; watchlist: number; low: number }) => `${g.elite} / ${g.high} / ${g.watchlist} / ${g.low}`;

const parityWarnings = (d: V12Decision) => d.warnings.filter((w) => w.startsWith('PARITY_WARNING') || w.startsWith('SIP_VETO_WAIVED') || w === 'DELIVERY_DELAYED');

/** Header strip: which version decides, and that v1.2 is shadow only. */
export function VersionLegend({ logCount, onExport }: { logCount: number; onExport: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 text-xs">
      <span>
        <span className="mr-1 text-ink-400">Active decision</span>
        <span className="rounded bg-long/15 px-1.5 py-0.5 font-bold text-long">RB v1.1</span>
      </span>
      <span>
        <span className="mr-1 text-ink-400">Shadow</span>
        <span className="rounded border border-dashed border-[#b48cff]/70 px-1.5 py-0.5 font-bold text-[#cdb3ff]">RB v1.2 SHADOW</span>
      </span>
      <span className="text-ink-400">Tickets, actions and trade decisions come from RB v1.1 only. RB v1.2 is a comparison column and is never used for execution.</span>
      <button type="button" onClick={onExport} disabled={!logCount} className="ml-auto rounded border border-ink-600 px-2 py-0.5 text-[11px] text-ink-300 hover:bg-ink-700 disabled:opacity-40">
        Export v1.2 shadow log ({logCount})
      </button>
    </div>
  );
}

/** Compact table cell: raw score + Option B tier, plus at most the WARNING / DATA REVIEW flags. */
export function ShadowCell({ r }: { r: QueueRow }) {
  const d = r.shadow;
  if (!d) return <span className="text-ink-500">—</span>;
  if (!d.qualified) {
    const rs = (r.record as AutoAlertRecordV12).v12?.qualification.ruleSet.status;
    return (
      <div className="font-sans text-ink-400">
        <div className="text-[11px] font-semibold">NOT QUALIFIED</div>
        <div className="text-[10px]">{rs === 'MISSING' ? 'no rule set' : rs === 'UNKNOWN' ? 'unknown rule set' : rs?.toLowerCase() ?? 'no v1.2 audit'}</div>
      </div>
    );
  }
  const s = d.score;
  const warn = parityWarnings(d).length > 0;
  return (
    <div className="font-sans">
      <div className="text-[12px] font-semibold text-[#cdb3ff]">
        {s?.total != null ? <><span className="num font-bold">{s.total}</span> · {tierShort(s.tierOptionB)}</> : d.dataReview.length ? <span className="text-ink-400">not scored</span> : d.decision}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-1">
        {d.dataReview.length > 0 && <Badge tone="review">DATA REVIEW</Badge>}
        {warn && <Badge tone="warn" title={parityWarnings(d).join(', ')}>WARNING</Badge>}
        {s?.total != null && d.dataReview.length === 0 && !warn && <span className="text-[10px] text-ink-400">{d.decision === 'SKIP' ? 'skip' : d.section === 'ACTION_NOW' || d.section === 'HIGH_PRIORITY' ? 'trade tier (shadow)' : d.decision.toLowerCase()}</span>}
      </div>
    </div>
  );
}

const sipRvolText = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? 'unavailable — non-blocking' : `${v.toFixed(2)} — diagnostic only`);
const CLASS_TONE: Record<string, string> = { AGREE: 'text-ink-300', KNIFE_EDGE: 'text-warn', DISAGREE: 'text-warn', DIAGNOSTIC_ONLY: 'text-ink-400', UNAVAILABLE: 'text-ink-400' };
const fmtDiag = (c: ConditionDiagnostic) => (c.sipValue === null ? `${c.label}: SIP value unavailable` : `${c.label}: SIP ${+c.sipValue.toFixed(4)}${c.threshold !== null ? ` vs ${+c.threshold.toFixed(4)}` : ''}`);
const WARNING_TEXT: Record<string, string> = {
  DELIVERY_DELAYED: 'Webhook delivered 61–120 s after the candle close (mapped, delayed).',
  'SIP_VETO_WAIVED:INVALID_CANDLE_DIRECTION': 'SIP candle direction disagrees — TrendSpider-owned, waived (diagnostic).',
  'SIP_VETO_WAIVED:HTF_CONFIRMATION_FAILED': 'SIP 15m confirmation disagrees — TrendSpider-owned, waived (diagnostic).',
};

/** Full-width details block for one row. */
export function ShadowPanel({ r, maxScore, optionAGrades }: { r: QueueRow; maxScore: number; optionAGrades: Grades }) {
  const d = r.shadow;
  const a = (r.record as AutoAlertRecordV12).v12;
  if (!d || !a) {
    return (
      <Section>
        <p className="text-ink-400">No RB v1.2 audit on this record (created before v1.2 shadow mode, or the audit failed). RB v1.1 decides it as usual.</p>
      </Section>
    );
  }
  const s = d.score;
  const q = a.qualification;
  const m = a.signalMapping;
  const diags = a.conditionDiagnostics.filter((c) => c.rule !== 'RVOL');
  const off = diags.filter((c) => c.class !== 'AGREE');
  const other = d.warnings.filter((w) => !w.startsWith('PARITY_WARNING') && !w.startsWith('PARITY_NOTE') && !w.startsWith('SIP_UNAVAILABLE') && w !== 'SIP_RVOL_DIAGNOSTIC_ONLY');
  const reasons = d.reasons.filter((x) => !x.startsWith('Integrity:'));
  const thresholds = s?.thresholds ?? { shadow: V12_SHADOW_GRADES, optionA: optionAGrades };
  return (
    <Section>
      <div className="mb-2 flex flex-wrap gap-1">
        {q.status === 'QUALIFIED' ? <Badge tone="ts" title="Setup qualified by an authenticated TrendSpider webhook with an audited rule set">TS QUALIFIED</Badge> : <Badge tone="muted">NOT QUALIFIED</Badge>}
        <Badge tone="sip" title="Indicators reconstructed from Alpaca SIP 5-minute bars (diagnostic, never re-qualifies)">SIP</Badge>
        <Badge tone="rb" title="Entry, stop, target and size from the shared RB calculator">RB</Badge>
        <Badge tone="shadow" title="Comparison only — never used for execution">SHADOW</Badge>
        {parityWarnings(d).length > 0 && <Badge tone="warn">WARNING</Badge>}
        {d.dataReview.length > 0 && <Badge tone="review">DATA REVIEW</Badge>}
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <div>
          <H>Shadow decision &amp; score</H>
          <Kv k="v1.2 shadow decision" v={d.detail.startsWith(d.decision) ? d.detail : `${d.decision} — ${d.detail}`} />
          <Kv k="Raw v1.2 score" v={s?.total != null ? `${s.total} / ${maxScore}` : 'not scored'} />
          <Kv k="Tier (experimental thresholds)" v={tierLong(s?.tierOptionB)} />
          <Kv k="Option A comparison tier" v={tierLong(s?.tierOptionA)} dim />
          <Kv k="RB v1.1 score" v={s ? `${s.v11Total ?? '—'}${s.deltaVsV11 !== null ? ` (Δ ${s.deltaVsV11 >= 0 ? '+' : ''}${s.deltaVsV11})` : ''}` : '—'} dim />
          <p className="mt-1.5 text-[11px] text-[#cdb3ff]">
            {`v1.2 experimental thresholds: Elite ${thresholds.shadow.elite} · High ${thresholds.shadow.high} · Watchlist ${thresholds.shadow.watchlist} · Low ${thresholds.shadow.low}`}
          </p>
          <p className="text-[11px] text-ink-400">Option A comparison: {grades(thresholds.optionA)}</p>
          <p className="text-[11px] text-ink-500">Shadow evaluation only — not a setting, not used for tickets.</p>
        </div>
        <div>
          <H>TrendSpider qualification &amp; mapping</H>
          <Kv k="Qualification" v={q.status === 'QUALIFIED' ? 'QUALIFIED' : 'NOT QUALIFIED'} />
          <Kv k="Rule set" v={`${q.ruleSet.ruleSet ?? '—'} (${q.ruleSet.status})`} />
          <Kv k="TrendSpider RVOL Gate" v={q.status === 'QUALIFIED' ? 'PASS (>1.5)' : 'not established — alert not qualified'} />
          <Kv k="SIP RVOL" v={sipRvolText(a.reconstruction?.sipRvol)} dim />
          <Kv k="Signal mapping" v={`${m.status}${m.label ? ` · ${m.label}` : ''}${m.lagSec !== null ? ` · ${m.lagSec} s after close` : ''}`} />
          <p className="mt-1 text-[11px] text-ink-500">TrendSpider sends no indicator values; RVOL magnitude is unknown. SIP never qualifies or rejects a setup.</p>
        </div>
        <div>
          <H>Warnings &amp; integrity</H>
          <div className="text-[11px] text-ink-400">SIP parity (diagnostic, never blocking): {diags.length - off.length} of {diags.length} agree</div>
          {off.length > 0 && <ul className="mt-0.5 space-y-0.5 text-[11px]">{off.map((c) => <li key={c.rule} className={CLASS_TONE[c.class]}>{c.class.replace('_', ' ')} · {fmtDiag(c)}</li>)}</ul>}
          {other.length > 0 && <ul className="mt-1 space-y-0.5 text-[11px] text-warn">{other.map((w) => <li key={w}>{WARNING_TEXT[w] ?? w}</li>)}</ul>}
          <div className="mt-1.5 text-[11px]">
            <span className="text-ink-400">Integrity (DATA REVIEW): </span>
            {d.dataReview.length ? <span className="text-short">{d.dataReview.join(', ')}</span> : <span className="text-ink-300">none</span>}
          </div>
          {reasons.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-ink-300">{reasons.slice(0, 4).map((x, i) => <li key={i}>{x}</li>)}</ul>}
          <div className="mt-1.5 text-[11px] text-ink-400">Ticket: {d.ticket ? 'valid — same RB calculator plan (not offered: shadow only)' : 'none'}</div>
        </div>
      </div>
    </Section>
  );
}

const Section = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-lg border border-dashed border-[#b48cff]/50 bg-[#1a1530]/40 p-2.5">
    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#cdb3ff]">RB v1.2 SHADOW — comparison only, not used for execution</div>
    {children}
  </div>
);
const H = ({ children }: { children: React.ReactNode }) => <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-400">{children}</div>;
const Kv = ({ k, v, dim }: { k: string; v: string; dim?: boolean }) => (
  <div className="flex justify-between gap-3 text-[12px]">
    <span className="text-ink-400">{k}</span>
    <span className={`text-right ${dim ? 'text-ink-400' : 'text-ink-100'}`}>{v}</span>
  </div>
);
