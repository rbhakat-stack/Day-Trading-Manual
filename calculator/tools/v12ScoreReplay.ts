/**
 * PHASE 3B STEP 6 — RB v1.1 vs RB v1.2 (shadow) score replay (local research tool, NOT part of the app).
 *
 *   npx vite-node tools/v12ScoreReplay.ts
 *
 * Replays the Phase 2 master sample (real Alpaca SIP 5m data, 3 days) through the live queue twice per candle —
 * the active RB v1.1 ranking and the RB v1.2 shadow ranking — and writes the score comparison.
 *
 * HYPOTHETICAL by construction: none of these candles is known to be a genuine RB alert except VRSK 2026-10-30
 * 12:25 (LONG). Each candle is treated as if a TrendSpider alert had fired at its close:
 *   • direction = the SIP signal-candle colour (Close ≥ Open → LONG, else SHORT) — labelled HYPOTHETICAL
 *   • rule set  = a TEST/HYPOTHETICAL registry entry (the production registry stays EMPTY)
 *   • receipt   = candle close + 12 s · current price = the signal close (trigger not crossed)
 *   • candles closing after 15:30 are outside the entry window in both versions and are skipped
 * Each candle is scored on its own (single-candidate queue), so portfolio interplay does not mix candles.
 * Read-only market data through assertHistoricalBarsRequest; credentials stay in memory.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertHistoricalBarsRequest } from '../netlify/lib/historicalSip';
import { DEFAULT_AUTOMATION, type AutoAlertRecord, type LiveQuote } from '../src/engine/automation/alertDecision';
import { buildAlertSnapshot } from '../src/engine/automation/alertSnapshot';
import { etToEpoch } from '../src/engine/automation/etTime';
import type { Bar } from '../src/engine/automation/indicators';
import { buildQueue } from '../src/engine/automation/liveQueue';
import { previousTradingDates } from '../src/engine/automation/marketCalendar';
import { receiptAudit, withReconstruction, type AutoAlertRecordV12 } from '../src/engine/automation/v12/audit';
import type { RuleSetEntry } from '../src/engine/automation/v12/ruleSets';
import { cloneRankerDefaults } from '../src/engine/ranker/rankerSettings';
import { RB_V1_DEFAULTS } from '../src/engine/settings';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'tools/rvol-parity');
const FIVE = 300_000;
const TEST_REG: RuleSetEntry[] = [
  { id: 'RBTS-L-HYP', direction: 'LONG', rulesVersion: 'RB v1.2', audited: 'HYPOTHETICAL', checklistRef: 'TEST/HYPOTHETICAL — not audited', active: true, rules: ['HYPOTHETICAL'] },
  { id: 'RBTS-S-HYP', direction: 'SHORT', rulesVersion: 'RB v1.2', audited: 'HYPOTHETICAL', checklistRef: 'TEST/HYPOTHETICAL — not audited', active: true, rules: ['HYPOTHETICAL'] },
];
const TIER_ORDER = ['SKIP', 'LOW_PRIORITY', 'WATCHLIST', 'HIGH_PRIORITY', 'ELITE'];

function creds() {
  const env: Record<string, string> = {};
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim().replace(/^"|"$/g, ''); }
  if (!env.ALPACA_API_KEY || !env.ALPACA_SECRET_KEY) throw new Error('ALPACA_API_KEY / ALPACA_SECRET_KEY missing in .env');
  return { keyId: env.ALPACA_API_KEY, secret: env.ALPACA_SECRET_KEY };
}
async function bars5(symbol: string, startMs: number, endMs: number, c: { keyId: string; secret: string }): Promise<Bar[]> {
  const out: Bar[] = [];
  let page: string | undefined;
  do {
    const p = new URLSearchParams({ timeframe: '5Min', start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), adjustment: 'raw', feed: 'sip', limit: '10000', sort: 'asc' });
    if (page) p.set('page_token', page);
    const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?${p}`;
    assertHistoricalBarsRequest(url, 'GET', Date.now());
    const r = await fetch(url, { method: 'GET', headers: { 'APCA-API-KEY-ID': c.keyId, 'APCA-API-SECRET-KEY': c.secret } });
    if (!r.ok) throw new Error(`${symbol}: Alpaca HTTP ${r.status}`);
    const j = (await r.json()) as { bars?: { t: string; o: number; h: number; l: number; c: number; v: number }[] | null; next_page_token?: string | null };
    for (const b of j.bars ?? []) out.push({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    page = j.next_page_token ?? undefined;
  } while (page);
  return out;
}

interface Row {
  date: string; ticker: string; candle: string; direction: string; source: 'GENUINE' | 'HYPOTHETICAL'; tsRvol: number | null; sipRvol: number | null;
  v11Total: number | null; v11Rvol: number | null; v11Tier: string | null; v11Fails: string;
  v12Total: number | null; v12Rvol: number | null; v12Tier: string | null; v12Decision: string; waived: string; parity: string; note: string;
}

async function main() {
  const c = creds();
  const sample = readFileSync(join(DIR, 'master-sample.csv'), 'utf8').trim().split(/\r?\n/);
  const cols = sample[0].split(',');
  const rows = sample.slice(1).map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
  const cache = new Map<string, Bar[]>();
  const out: Row[] = [];
  for (const s of rows) {
    const start = etToEpoch(s.date, s.candle_et);
    const end = start + FIVE;
    const closeHhmm = new Date(end).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
    if (closeHhmm > '15:30') continue;
    const key = `${s.ticker}|${s.date}`;
    if (!cache.has(key)) cache.set(key, await bars5(s.ticker, etToEpoch(previousTradingDates(s.date, 6).slice(-1)[0], '09:30'), etToEpoch(s.date, '16:00'), c));
    const all = cache.get(key)!;
    const receivedMs = end + 12_000;
    const genuine = s.alert_linked === 'YES';
    const sigBar = all.find((b) => b.t === start);
    if (!sigBar) continue;
    const direction: 'LONG' | 'SHORT' = genuine ? (s.direction as 'LONG' | 'SHORT') : sigBar.c >= sigBar.o ? 'LONG' : 'SHORT';
    const snapshot = buildAlertSnapshot(all, receivedMs, direction);
    if (!snapshot.values) { out.push({ date: s.date, ticker: s.ticker, candle: s.candle_et, direction, source: genuine ? 'GENUINE' : 'HYPOTHETICAL', tsRvol: Number(s.ts_rvol) || null, sipRvol: null, v11Total: null, v11Rvol: null, v11Tier: null, v11Fails: '', v12Total: null, v12Rvol: null, v12Tier: null, v12Decision: '', waived: '', parity: '', note: `snapshot incomplete: ${snapshot.issues.map((i) => i.code).join(' ')}` }); continue; }
    const id = `${s.ticker}-${direction[0]}-${receivedMs}`;
    const base: AutoAlertRecord = {
      id, dedupeKey: `${s.ticker}|${direction}|${Math.floor(receivedMs / 1000)}|RB`, receivedIso: new Date(receivedMs).toISOString(), receivedMs, status: 'OK',
      alert: { strategy: 'RB_V1', symbol: s.ticker, direction, alertName: `RB v1 ${direction} Setup`, alertTimeMs: receivedMs, alertTimeIso: new Date(receivedMs).toISOString(), timeSource: 'RECEIVED', lastPrice: null },
      payload: {}, snapshot, provider: { name: 'Alpaca', feed: 'sip', host: 'data.alpaca.markets' }, marketDataThroughIso: new Date(end).toISOString(),
      initialQuote: { price: snapshot.values.close, tradeIso: new Date(end).toISOString(), fetchedIso: new Date(receivedMs).toISOString() },
      calcAtAlert: null, sameTickerEarlier: [], errors: [], attempts: 1, versions: { rules: 'RB v1.1', scoring: 'RB v1.1', strategy: 'RB v1.1' }, processedIso: null,
    };
    const audit = withReconstruction(receiptAudit({ body: { rule_set: direction === 'LONG' ? 'RBTS-L-HYP' : 'RBTS-S-HYP' }, symbol: s.ticker, direction, receivedMs, v11Key: base.dedupeKey, registry: TEST_REG }), base, all, direction, DEFAULT_AUTOMATION.parity);
    const rec: AutoAlertRecordV12 = { ...base, v12: audit };
    const now = receivedMs + 30_000;
    const q: LiveQuote = { price: snapshot.values.close, tradeIso: new Date(now - 1000).toISOString(), fetchedIso: new Date(now - 500).toISOString(), receivedMs: now - 500 };
    const res = buildQueue({ records: [rec], candidates: [], positions: [], quotes: { [s.ticker]: q }, now, cfg: DEFAULT_AUTOMATION, rb: RB_V1_DEFAULTS, rk: cloneRankerDefaults(), classify: () => ({ sector: `S-${s.ticker}`, industry: `I-${s.ticker}`, theme: '' }), parity: {}, strategyVersion: 'RB v1.1' });
    const row = res.rows[0];
    const sh = row.shadow;
    out.push({
      date: s.date, ticker: s.ticker, candle: s.candle_et, direction, source: genuine ? 'GENUINE' : 'HYPOTHETICAL', tsRvol: Number(s.ts_rvol) || null, sipRvol: snapshot.values.rvol,
      v11Total: row.ranked?.total ?? null, v11Rvol: row.ranked?.components.find((k) => k.key === 'rvol')?.points ?? null, v11Tier: row.ranked?.tier ?? null, v11Fails: (row.ranked?.hardFails ?? []).map((f) => f.code).join(' '),
      v12Total: sh?.score?.total ?? null, v12Rvol: sh?.score?.rvolPoints ?? null, v12Tier: sh?.score?.tier ?? null, v12Decision: sh?.decision ?? '', waived: (sh?.score?.waivedRules ?? []).join(' '),
      parity: (sh?.warnings ?? []).filter((w) => w.startsWith('PARITY_WARNING')).map((w) => w.split(':')[1]).join(' '), note: '',
    });
  }
  const csvCols = Object.keys(out[0]) as (keyof Row)[];
  writeFileSync(join(DIR, 'v12-score-replay.csv'), [csvCols.join(',')].concat(out.map((r) => csvCols.map((k) => r[k] ?? '').join(','))).join('\n') + '\n');

  // ── summary ──
  const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); const k = p * (s.length - 1); const lo = Math.floor(k); return s.length ? s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (k - lo) : NaN; };
  const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');
  const L: string[] = ['# RB v1.1 vs RB v1.2 (shadow) score replay', '', `Generated ${new Date().toISOString()} · Phase 2 master sample, real Alpaca SIP · candles closing ≤ 15:30 · TEST/HYPOTHETICAL rule sets.`, ''];
  for (const [label, group] of [['ALL (hypothetical + genuine)', out], ['GENUINE alert-linked', out.filter((r) => r.source === 'GENUINE')], ['HYPOTHETICAL, TrendSpider RVOL > 1.5 (would-be alerts)', out.filter((r) => r.source === 'HYPOTHETICAL' && (r.tsRvol ?? 0) > 1.5)], ['HYPOTHETICAL, all', out.filter((r) => r.source === 'HYPOTHETICAL')]] as const) {
    const both = group.filter((r) => r.v11Total !== null && r.v12Total !== null);
    const d = both.map((r) => (r.v12Total as number) - (r.v11Total as number));
    const tierIdx = (t: string | null) => TIER_ORDER.indexOf(t ?? '');
    L.push(`## ${label}`, '', `Candidates: ${group.length} · scored in both: ${both.length} · v1.1 unscored → v1.2 scored: ${group.filter((r) => r.v11Total === null && r.v12Total !== null).length} · unscored in both: ${group.filter((r) => r.v11Total === null && r.v12Total === null).length}`, '');
    if (both.length) {
      L.push('| Delta (v1.2 − v1.1) | min | P10 | median | P90 | max | mean |', '|---|---|---|---|---|---|---|',
        `| points | ${f1(Math.min(...d))} | ${f1(pct(d, 0.1))} | ${f1(pct(d, 0.5))} | ${f1(pct(d, 0.9))} | ${f1(Math.max(...d))} | ${f1(d.reduce((a, b) => a + b, 0) / d.length)} |`, '',
        '| Crossing | count |', '|---|---|',
        `| v1.1 ≥ 85 → v1.2 < 85 | ${both.filter((r) => r.v11Total! >= 85 && r.v12Total! < 85).length} |`,
        `| v1.1 ≥ 90 → v1.2 < 90 | ${both.filter((r) => r.v11Total! >= 90 && r.v12Total! < 90).length} |`,
        `| v1.1 < 85 → v1.2 ≥ 85 | ${both.filter((r) => r.v11Total! < 85 && r.v12Total! >= 85).length} |`,
        `| v1.1 < 90 → v1.2 ≥ 90 | ${both.filter((r) => r.v11Total! < 90 && r.v12Total! >= 90).length} |`,
        `| tier unchanged | ${both.filter((r) => tierIdx(r.v11Tier) === tierIdx(r.v12Tier)).length} |`,
        `| tier increased | ${both.filter((r) => tierIdx(r.v12Tier) > tierIdx(r.v11Tier)).length} |`,
        `| tier decreased | ${both.filter((r) => tierIdx(r.v12Tier) < tierIdx(r.v11Tier)).length} |`, '',
        `RVOL points v1.1 (SIP bands): ${[0, 6, 9, 12, 15].map((p) => `${p}:${both.filter((r) => r.v11Rvol === p).length}`).join(' ')} · v1.2: always 6`, '');
    }
  }
  writeFileSync(join(DIR, 'v12-score-replay-summary.md'), L.join('\n') + '\n');
  console.log(`rows ${out.length}`);
}

main().catch((e) => { console.error(String((e as Error).message ?? e).replace(/[A-Za-z0-9]{20,}/g, '[redacted]')); process.exit(1); });
