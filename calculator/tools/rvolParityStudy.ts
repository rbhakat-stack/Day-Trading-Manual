/**
 * PHASE 2 — CROSS-TICKER RVOL / VOLUME PARITY STUDY (local research tool, NOT part of the app).
 *
 *   npx vite-node tools/rvolParityStudy.ts [sample.csv] [outDir]
 *   (defaults: tools/rvol-parity/pilot-sample.csv → tools/rvol-parity/)
 *
 * For every sample candle it reads historical Alpaca SIP 5-minute bars and computes the SIP side with the SAME code
 * the Historical SIP diagnostic uses (regularSessionBars + historicalParityRvol): native volume, the Volume SMA20 at
 * the candle (what TrendSpider's Volume indicator displays), the prior-20 SMA and the TrendSpider-parity RVOL. If the
 * TrendSpider columns are filled in, it compares them and writes summary statistics.
 *
 * Safety:
 *   • Read-only market data: every request passes assertHistoricalBarsRequest (GET /v2/stocks/{sym}/bars, feed=sip,
 *     1Min/5Min, explicit end ≥ 16 min old). No latest/quote/snapshot/trade endpoints, no trading API.
 *   • Credentials are read from the local .env into memory only; they are never printed or written.
 *   • Nothing here is imported by the app, the Netlify functions or the live pipeline (tools/ is outside both
 *     tsconfig includes). It writes only the CSV / Markdown files in outDir.
 *   • TrendSpider numbers are never invented: a blank TrendSpider cell stays blank and is excluded from statistics.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertHistoricalBarsRequest } from '../netlify/lib/historicalSip';
import { regularSessionBars } from '../src/engine/automation/alertSnapshot';
import { etParts, etToEpoch } from '../src/engine/automation/etTime';
import { historicalParityRvol, RVOL_PARITY_LENGTH } from '../src/engine/automation/historicalParity';
import type { Bar } from '../src/engine/automation/indicators';
import { previousTradingDates } from '../src/engine/automation/marketCalendar';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = resolve(process.argv[2] ?? join(ROOT, 'tools/rvol-parity/pilot-sample.csv'));
const OUT = resolve(process.argv[3] ?? dirname(SAMPLE));
const FIVE = 5 * 60_000;
const LOOKBACK_DAYS = 20; // enough history for the 20-bar baseline and a 20-day liquidity estimate
const RVOL_GATE = 1.5;

/* ── inputs ── */
/** ts_sma20_prev_source: OBSERVED (previous candle's SMA read from TrendSpider) or DERIVED (ts_volume / ts_rvol). */
interface SampleRow { date: string; ticker: string; candle_et: string; direction: string; alert_linked: string; context: string; ts_volume?: number; ts_sma20?: number; ts_sma20_prev?: number; ts_sma20_prev_source: string; ts_rvol?: number }

function readSample(path: string): SampleRow[] {
  const [head, ...lines] = readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const cols = head.split(',').map((c) => c.trim());
  const num = (s: string | undefined) => (s && s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : undefined);
  return lines.map((l) => {
    const c = Object.fromEntries(l.split(',').map((x, i) => [cols[i], x.trim()]));
    const context = c.context ?? '';
    const direction = (c.direction ?? '').toUpperCase();
    // alert_linked: YES (genuine RB alert) · TEST (local/manual test alert) · NO · UNKNOWN (no alert history for that
    // date). Sheets without the column: inferred.
    const alert_linked = (c.alert_linked ?? '').toUpperCase() || (/test alert/i.test(context) ? 'TEST' : direction ? 'YES' : 'NO');
    return { date: c.date, ticker: c.ticker.toUpperCase(), candle_et: c.candle_et, direction, alert_linked, context, ts_volume: num(c.ts_volume), ts_sma20: num(c.ts_sma20), ts_sma20_prev: num(c.ts_sma20_prev), ts_sma20_prev_source: (c.ts_sma20_prev_source ?? '').toUpperCase(), ts_rvol: num(c.ts_rvol) };
  });
}

function readEnv(): { keyId: string; secret: string } {
  const env: Record<string, string> = {};
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
  }
  if (!env.ALPACA_API_KEY || !env.ALPACA_SECRET_KEY) throw new Error('ALPACA_API_KEY / ALPACA_SECRET_KEY missing in .env');
  return { keyId: env.ALPACA_API_KEY, secret: env.ALPACA_SECRET_KEY };
}

/* ── historical SIP 5m bars (guarded, read-only) ── */
async function sipBars5(symbol: string, startMs: number, endMs: number, creds: { keyId: string; secret: string }): Promise<Bar[]> {
  const out: Bar[] = [];
  let page: string | undefined;
  do {
    const p = new URLSearchParams({ timeframe: '5Min', start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), adjustment: 'raw', feed: 'sip', limit: '10000', sort: 'asc' });
    if (page) p.set('page_token', page);
    const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?${p}`;
    assertHistoricalBarsRequest(url, 'GET', Date.now()); // throws before any network call
    const r = await fetch(url, { method: 'GET', headers: { 'APCA-API-KEY-ID': creds.keyId, 'APCA-API-SECRET-KEY': creds.secret } });
    if (!r.ok) throw new Error(`${symbol}: Alpaca HTTP ${r.status}`); // body not echoed (may quote request details)
    const j = (await r.json()) as { bars?: { t: string; o: number; h: number; l: number; c: number; v: number }[] | null; next_page_token?: string | null };
    for (const b of j.bars ?? []) out.push({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    page = j.next_page_token ?? undefined;
  } while (page);
  return out;
}

/* ── per-candle computation ── */
const tier = (adv: number) => (adv >= 5e6 ? 'HIGH' : adv >= 1e6 ? 'MEDIUM' : 'LOW');
const priceBand = (p: number) => (p < 20 ? '<$20' : p < 100 ? '$20–100' : p < 300 ? '$100–300' : '≥$300');
const session = (hhmm: string) => (hhmm < '11:30' ? 'MORNING' : hhmm < '14:00' ? 'MIDDAY' : 'AFTERNOON');
const pct = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null || b === 0 ? null : (a - b) / b);

interface ResultRow extends SampleRow {
  liquidity: string; adv: number; price: number; priceBand: string; session: string;
  sipVolume: number | null; sipSma20: number | null; sipPrior20Sma: number | null; sipParityRvol: number | null; baselineBars: number; issue: string;
  volDiffPct: number | null; smaDiffPct: number | null; priorSmaDiffPct: number | null; rvolAbsDiff: number | null; rvolDiffPct: number | null;
  tsImpliedPriorSma: number | null; tsInternalCheck: string; tsPass: boolean | null; sipPass: boolean | null; gate: string;
}

function compute(row: SampleRow, bars: Bar[]): ResultRow {
  const rth = regularSessionBars(bars);
  const t = etToEpoch(row.date, row.candle_et);
  const i = rth.findIndex((b) => b.t === t);
  const days = new Map<string, number>();
  for (const b of rth) if (b.t < etToEpoch(row.date, '09:30')) days.set(etParts(b.t).date, (days.get(etParts(b.t).date) ?? 0) + b.v);
  const dv = [...days.values()].slice(-20);
  const adv = dv.length ? dv.reduce((a, b) => a + b, 0) / dv.length : 0;
  const bar = i >= 0 ? rth[i] : null;
  const parity = bar ? historicalParityRvol(rth, t, bar.v) : null;
  const sma20 = i >= RVOL_PARITY_LENGTH - 1 ? rth.slice(i - RVOL_PARITY_LENGTH + 1, i + 1).reduce((a, b) => a + b.v, 0) / RVOL_PARITY_LENGTH : null;
  const sipRvol = parity?.value ?? null;
  const tsImpliedPriorSma = row.ts_volume != null && row.ts_rvol ? row.ts_volume / row.ts_rvol : null;
  // TrendSpider self-consistency, only when the previous candle's SMA was OBSERVED (a DERIVED one is Volume / RVOL, so
  // checking it would be circular): ts_rvol ≈ ts_volume / ts_sma20_prev
  const observedPrev = row.ts_sma20_prev_source === 'OBSERVED';
  const internal = observedPrev && row.ts_volume != null && row.ts_sma20_prev && row.ts_rvol != null ? Math.abs(row.ts_volume / row.ts_sma20_prev - row.ts_rvol) < 0.0015 ? 'CONSISTENT' : 'INCONSISTENT' : row.ts_sma20_prev_source === 'DERIVED' ? 'N/A (prior SMA derived)' : '';
  const tsPass = row.ts_rvol == null ? null : row.ts_rvol > RVOL_GATE;
  const sipPass = sipRvol == null ? null : sipRvol > RVOL_GATE;
  return {
    ...row, liquidity: tier(adv), adv, price: bar?.c ?? rth[rth.length - 1]?.c ?? 0, priceBand: priceBand(bar?.c ?? 0), session: session(row.candle_et),
    sipVolume: bar?.v ?? null, sipSma20: sma20, sipPrior20Sma: parity?.baseline ?? null, sipParityRvol: sipRvol, baselineBars: parity?.baselineBars.length ?? 0,
    issue: !bar ? 'SIP_CANDLE_MISSING' : sipRvol == null ? 'BASELINE_UNAVAILABLE' : '',
    volDiffPct: pct(bar?.v, row.ts_volume), smaDiffPct: pct(sma20, row.ts_sma20), priorSmaDiffPct: pct(parity?.baseline, row.ts_sma20_prev ?? tsImpliedPriorSma),
    rvolAbsDiff: sipRvol != null && row.ts_rvol != null ? sipRvol - row.ts_rvol : null, rvolDiffPct: pct(sipRvol, row.ts_rvol),
    tsImpliedPriorSma, tsInternalCheck: internal, tsPass, sipPass,
    gate: tsPass == null || sipPass == null ? 'PENDING_TS' : tsPass ? (sipPass ? 'PASS/PASS' : 'TS PASS / SIP FAIL') : sipPass ? 'TS FAIL / SIP PASS' : 'FAIL/FAIL',
  };
}

/* ── statistics (rows with TrendSpider values only) ── */
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const p90 = (a: number[]) => { const s = [...a].sort((x, y) => x - y); if (!s.length) return NaN; const k = 0.9 * (s.length - 1); const lo = Math.floor(k); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (k - lo); };
const f = (n: number | null | undefined, d = 2) => (n == null || !Number.isFinite(n) ? '' : n.toFixed(d));
const fp = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '' : `${(n * 100).toFixed(1)}%`);

const GATE_LABEL: Record<string, string> = { PP: 'PASS/PASS', FF: 'FAIL/FAIL', PF: 'TS PASS / SIP FAIL', FP: 'TS FAIL / SIP PASS' };
const gateKey = (r: ResultRow) => (r.tsPass ? 'P' : 'F') + (r.sipPass ? 'P' : 'F');
const tsr = (r: ResultRow) => r.ts_rvol as number;
const NEAR = (r: ResultRow) => tsr(r) >= 1.2 && tsr(r) <= 2.5;
const flag = (bad: boolean, text: string) => (bad ? `**⚑ ${text}**` : text);

function gateTable(rs: ResultRow[]): { line: string; dis: number } {
  const c: Record<string, number> = { PP: 0, FF: 0, PF: 0, FP: 0 };
  for (const r of rs) c[gateKey(r)]++;
  const dis = c.PF + c.FP;
  return { line: `${rs.length} | ${c.PP} | ${c.FF} | ${c.PF} | ${c.FP} | ${rs.length ? fp(dis / rs.length) : '—'}`, dis };
}

function summarize(rows: ResultRow[]): string {
  // RVOL statistics need a TrendSpider RVOL; volume statistics additionally need a TrendSpider volume.
  const paired = rows.filter((r) => r.ts_rvol != null && r.sipParityRvol != null);
  const vpaired = paired.filter((r) => r.ts_volume != null && r.sipVolume != null);
  const L: string[] = [];
  L.push(`Sample rows: ${rows.length} · tickers: ${new Set(rows.map((r) => r.ticker)).size} · days: ${[...new Set(rows.map((r) => r.date))].join(', ')} · SIP computed: ${rows.filter((r) => r.sipParityRvol != null).length} · with TrendSpider RVOL: ${paired.length} (${new Set(paired.map((r) => r.ticker)).size} tickers) · pending TrendSpider capture: ${rows.length - paired.length}`, '');
  if (!paired.length) return L.concat('No TrendSpider values yet — statistics pending.').join('\n');
  const vd = vpaired.map((r) => r.volDiffPct as number), rd = paired.map((r) => r.rvolDiffPct as number);
  const share = (xs: number[], bands: number[]) => bands.map((b) => { const k = xs.filter((x) => Math.abs(x) <= b).length; return `${k} (${fp(k / xs.length)})`; }).join(' / ');
  const p90rv = p90(rd.map(Math.abs));

  L.push('## Secondary metrics (full sample)', '', '| Statistic | Value |', '|---|---|',
    `| Volume diff % (SIP vs TS), mean / median (n=${vpaired.length}) | ${fp(mean(vd))} / ${fp(median(vd))} |`,
    `| Volume diff %, min / max · P90 of absolute | ${fp(Math.min(...vd))} / ${fp(Math.max(...vd))} · ${fp(p90(vd.map(Math.abs)))} |`,
    `| Volume within 10% / 20% / 30% / 50% | ${share(vd, [0.1, 0.2, 0.3, 0.5])} |`,
    `| RVOL diff %, mean / median (n=${paired.length}) | ${fp(mean(rd))} / ${fp(median(rd))} |`,
    `| RVOL diff %, min / max | ${fp(Math.min(...rd))} / ${fp(Math.max(...rd))} |`,
    `| RVOL diff %, P90 of absolute | ${flag(p90rv > 0.2, fp(p90rv) + (p90rv > 0.2 ? ' (> 20%)' : ''))} |`,
    `| RVOL within 5% / 10% / 15% / 20% / 30% | ${share(rd, [0.05, 0.1, 0.15, 0.2, 0.3])} |`,
    `| SIP RVOL above / below TrendSpider | ${rd.filter((x) => x > 0).length} / ${rd.filter((x) => x < 0).length} |`,
    `| TrendSpider internally consistent (observed prior SMA only) | ${paired.filter((r) => r.tsInternalCheck === 'CONSISTENT').length} of ${paired.filter((r) => /^(IN)?CONSISTENT$/.test(r.tsInternalCheck)).length} |`, '');

  const head = '| Group | n | PASS/PASS | FAIL/FAIL | TS PASS / SIP FAIL | TS FAIL / SIP PASS | Disagreement |';
  const sep = '|---|---|---|---|---|---|---|';
  const near = paired.filter(NEAR);
  const nearT = gateTable(near);
  const band = (lo: number, hi: number, incl = false) => paired.filter((r) => tsr(r) >= lo && (incl ? tsr(r) <= hi : tsr(r) < hi));
  L.push('## Primary metric — gate agreement (RVOL > 1.5)', '', head, sep,
    `| All candles | ${gateTable(paired).line} |`,
    `| **Near threshold (TS RVOL 1.2–2.5)** | ${nearT.line}${near.length > 0 && nearT.dis / near.length > 0.05 ? " ⚑ > 5%" : ""} |`,
    `| Below threshold (1.2 ≤ TS < 1.5) | ${gateTable(band(1.2, 1.5)).line} |`,
    `| Just above (1.5 ≤ TS < 1.8) | ${gateTable(band(1.5, 1.8)).line} |`,
    `| Moderate pass (1.8 ≤ TS ≤ 2.5) | ${gateTable(band(1.8, 2.5, true)).line} |`,
    `| Far below (TS < 1.2) | ${gateTable(paired.filter((r) => tsr(r) < 1.2)).line} |`,
    `| Far above (TS > 2.5) | ${gateTable(paired.filter((r) => tsr(r) > 2.5)).line} |`, '',
    `TrendSpider RVOL bands inside 1.2–2.5: 1.20–1.39: ${band(1.2, 1.4).length} · 1.40–1.49: ${band(1.4, 1.5).length} · 1.50–1.69: ${band(1.5, 1.7).length} · 1.70–1.99: ${band(1.7, 2).length} · 2.00–2.50: ${band(2, 2.5, true).length}`, '');

  const genuine = paired.filter((r) => r.alert_linked === 'YES');
  const gT = gateTable(genuine);
  L.push('## Genuine RB alert candles', '', head, sep,
    `| All genuine alerts | ${gT.line}${genuine.length > 0 && gT.dis / genuine.length > 0.05 ? " ⚑ > 5%" : ""} |`,
    `| LONG | ${gateTable(genuine.filter((r) => r.direction === 'LONG')).line} |`,
    `| SHORT | ${gateTable(genuine.filter((r) => r.direction === 'SHORT')).line} |`, '',
    `Median absolute RVOL diff (genuine alerts): ${fp(median(genuine.map((r) => Math.abs(r.rvolDiffPct as number))))} · test alerts excluded from this subset: ${paired.filter((r) => r.alert_linked === 'TEST').length}`, '');

  const dis = paired.filter((r) => r.tsPass !== r.sipPass);
  L.push('## Every gate disagreement', '');
  if (!dis.length) L.push('None.', '');
  else L.push('| Date | Ticker | Candle | Alert-linked | Direction | Liquidity | Segment | TS RVOL | SIP RVOL | RVOL diff | Outcome |', '|---|---|---|---|---|---|---|---|---|---|---|',
    ...dis.map((r) => `| ${r.date} | ${r.ticker} | ${r.candle_et} | ${r.alert_linked} | ${r.direction || '—'} | ${r.liquidity} | ${r.session} | ${r.ts_rvol} | ${f(r.sipParityRvol, 3)} | ${fp(r.rvolDiffPct)} | ${GATE_LABEL[gateKey(r)]} |`), '');
  const tsPasses = paired.filter((r) => r.tsPass).length, tsFails = paired.length - tsPasses;
  const pf = dis.filter((r) => r.tsPass).length, fpn = dis.length - pf;
  L.push(`Directional asymmetry: TS PASS / SIP FAIL (false rejection) = ${pf} of ${tsPasses} TrendSpider passes (${fp(pf / Math.max(1, tsPasses))}); TS FAIL / SIP PASS (false validation) = ${fpn} of ${tsFails} TrendSpider fails (${fp(fpn / Math.max(1, tsFails))}).`, '');

  const seg = (name: string, key: (r: ResultRow) => string) => {
    const groups = new Map<string, ResultRow[]>();
    for (const r of paired) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
    L.push(`## By ${name}`, '', '| Group | n | Median abs volume diff | Median abs RVOL diff | SIP above / below | Gate disagreement | Near-threshold n | Near-threshold disagreement | Note |', '|---|---|---|---|---|---|---|---|---|');
    for (const [g, rs] of [...groups].sort()) {
      const r2 = rs.map((r) => r.rvolDiffPct as number), nr = rs.filter(NEAR), d = rs.filter((r) => r.tsPass !== r.sipPass).length, nd = nr.filter((r) => r.tsPass !== r.sipPass).length;
      L.push(`| ${g} | ${rs.length} | ${fp(median(rs.filter((r) => r.volDiffPct != null).map((r) => Math.abs(r.volDiffPct as number))))} | ${fp(median(r2.map(Math.abs)))} | ${r2.filter((x) => x > 0).length} / ${r2.filter((x) => x < 0).length} | ${d}/${rs.length} (${fp(d / rs.length)}) | ${nr.length} | ${nr.length ? `${nd}/${nr.length} (${fp(nd / nr.length)})` : '—'} | ${rs.length < 10 ? 'DIRECTIONAL ONLY' : ''} |`);
    }
    L.push('');
  };
  seg('liquidity', (r) => r.liquidity);
  seg('time of day', (r) => r.session);
  seg('time of day, VRSK separated', (r) => (r.ticker === 'VRSK' ? 'VRSK (all segments)' : r.session));
  seg('trading day', (r) => r.date);
  seg('alert linkage / direction', (r) => (r.alert_linked === 'YES' ? `GENUINE ${r.direction}` : r.alert_linked === 'TEST' ? 'TEST ALERT' : r.alert_linked === 'NO' ? 'NON-ALERT' : 'UNKNOWN (no alert history)'));
  seg('ticker', (r) => r.ticker);

  const counts = [...paired.reduce((m, r) => m.set(r.ticker, (m.get(r.ticker) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  const [topT, topN] = counts[0];
  L.push('## Ticker concentration', '', `Largest ticker share: ${topT} ${topN}/${paired.length} = ${fp(topN / paired.length)}${topN / paired.length > 0.2 ? ' — **⚑ IMBALANCED (> 20%)**' : ' (≤ 20%)'}.`,
    `Disagreements by ticker: ${dis.length ? [...dis.reduce((m, r) => m.set(r.ticker, (m.get(r.ticker) ?? 0) + 1), new Map<string, number>())].map(([t, n]) => `${t}: ${n}`).join(', ') : 'none'}.`, '');

  L.push('## Phase 3 evidence flags (decision aids only — no live change)', '',
    `- Near-threshold disagreement > 5%: ${near.length ? (nearT.dis / near.length > 0.05 ? `**YES (${fp(nearT.dis / near.length)})**` : `no (${fp(nearT.dis / near.length)})`) : 'n/a'}`,
    `- Genuine-alert disagreement > 5%: ${genuine.length ? (gT.dis / genuine.length > 0.05 ? `**YES (${fp(gT.dis / genuine.length)})**` : `no (${fp(gT.dis / genuine.length)})`) : 'n/a'}`,
    `- Repeated disagreement in one direction: TS PASS / SIP FAIL ${pf}, TS FAIL / SIP PASS ${fpn}${pf > 1 || fpn > 1 ? ' — **YES**' : ''}`,
    `- P90 RVOL error > 20%: ${p90rv > 0.2 ? `**YES (${fp(p90rv)})**` : `no (${fp(p90rv)})`}`, '');
  return L.join('\n');
}

/* ── main ── */
async function main() {
  const sample = readSample(SAMPLE);
  const creds = readEnv();
  const cache = new Map<string, Bar[]>();
  const rows: ResultRow[] = [];
  for (const s of sample) {
    const key = `${s.ticker}|${s.date}`;
    if (!cache.has(key)) {
      const start = etToEpoch(previousTradingDates(s.date, LOOKBACK_DAYS).slice(-1)[0], '09:30');
      cache.set(key, await sipBars5(s.ticker, start, etToEpoch(s.date, '16:00'), creds));
    }
    rows.push(compute(s, cache.get(key)!));
  }
  mkdirSync(OUT, { recursive: true });
  const header = ['date', 'ticker', 'candle_et', 'direction', 'alert_linked', 'context', 'liquidity', 'adv_shares', 'price', 'price_band', 'session',
    'ts_volume', 'sip_volume', 'volume_diff_pct', 'ts_sma20', 'sip_sma20', 'sma20_diff_pct', 'ts_prior_sma20', 'ts_prior_sma20_source', 'sip_prior20_sma', 'prior_sma_diff_pct',
    'ts_rvol', 'sip_parity_rvol', 'rvol_abs_diff', 'rvol_diff_pct', 'ts_gt_1_5', 'sip_gt_1_5', 'gate_result', 'ts_internal_check', 'baseline_bars', 'issue'];
  const csv = [header.join(',')].concat(rows.map((r) => [r.date, r.ticker, r.candle_et, r.direction, r.alert_linked, `"${r.context}"`, r.liquidity, Math.round(r.adv), f(r.price), r.priceBand, r.session,
    r.ts_volume ?? '', r.sipVolume ?? '', fp(r.volDiffPct), r.ts_sma20 ?? '', f(r.sipSma20, 1), fp(r.smaDiffPct), f(r.ts_sma20_prev ?? r.tsImpliedPriorSma, 1), r.ts_sma20_prev_source || (r.tsImpliedPriorSma != null ? 'DERIVED' : ''), f(r.sipPrior20Sma, 1), fp(r.priorSmaDiffPct),
    r.ts_rvol ?? '', f(r.sipParityRvol, 3), f(r.rvolAbsDiff, 3), fp(r.rvolDiffPct), r.tsPass ?? '', r.sipPass ?? '', r.gate, r.tsInternalCheck, r.baselineBars, r.issue].join(',')));
  const base = SAMPLE.replace(/\.csv$/i, '').split(/[\\/]/).pop();
  writeFileSync(join(OUT, `${base}-results.csv`), csv.join('\n') + '\n');
  writeFileSync(join(OUT, `${base}-summary.md`), `# RVOL parity study — ${base}\n\nGenerated ${new Date().toISOString()} from historical Alpaca SIP 5m bars (feed=sip). Diffs are SIP relative to TrendSpider: (SIP − TS) / TS.\n\n${summarize(rows)}\n`);
  console.log(`wrote ${base}-results.csv and ${base}-summary.md (${rows.length} rows)`);
}

main().catch((e) => {
  console.error(String((e as Error).message ?? e).replace(/[A-Za-z0-9]{20,}/g, '[redacted]'));
  process.exit(1);
});
