/**
 * PHASE 2 EXPANSION — candidate selection for the TrendSpider vs SIP RVOL study (local research tool, NOT part of the app).
 *
 *   npx vite-node tools/rvolCandidateFinder.ts
 *
 * Picks ~28 completed 5m candles concentrated in the RVOL threshold region, using SIP parity RVOL as a SELECTION PROXY
 * (TrendSpider values are unknown until captured; the study bands rows by the captured TrendSpider RVOL, never by
 * this proxy). Deterministic: same data → same picks. Writes:
 *   tools/rvol-parity/expansion-selection.csv   selection log incl. the SIP proxy (do not show while capturing)
 *   tools/rvol-parity/expansion-capture.csv     BLIND capture sheet for TrendSpider (no SIP numbers)
 *   tools/rvol-parity/master-sample.csv         pilot rows + new rows (TrendSpider columns blank until captured)
 *
 * Same safety as rvolParityStudy.ts: guarded read-only historical SIP bars, credentials in memory only.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertHistoricalBarsRequest } from '../netlify/lib/historicalSip';
import { regularSessionBars } from '../src/engine/automation/alertSnapshot';
import { etParts, etToEpoch } from '../src/engine/automation/etTime';
import { historicalParityRvol } from '../src/engine/automation/historicalParity';
import type { Bar } from '../src/engine/automation/indicators';
import { previousTradingDates } from '../src/engine/automation/marketCalendar';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'tools/rvol-parity');
const DAYS = ['2026-10-28', '2026-10-29', '2026-10-30'];
// RB ranker universe + pilot tickers + low-ADV large caps (liquidity tier is computed from SIP ADV, not assumed).
const TICKERS = ['NVDA', 'AMD', 'AVGO', 'AAPL', 'MSFT', 'AMZN', 'IBM', 'NEE', 'AEP', 'HCA', 'DLTR', 'TRMB', 'IQV', 'Q', 'GM', 'F', 'VRSK', 'MSCI', 'FDS', 'ROP', 'TDY'];
// Proxy bands on SIP parity RVOL with target counts. SIP vs TS RVOL differed by up to ±30–50% in the pilot, so the
// bands are spread a little wider than the TrendSpider target region (1.2–2.5).
const BANDS: { lo: number; hi: number; want: number }[] = [
  { lo: 1.05, hi: 1.35, want: 5 }, { lo: 1.35, hi: 1.5, want: 4 }, { lo: 1.5, hi: 1.7, want: 5 }, { lo: 1.7, hi: 2.0, want: 4 }, { lo: 2.0, hi: 2.7, want: 4 },
  { lo: 0.5, hi: 1.05, want: 3 }, { lo: 2.7, hi: 6, want: 3 },
];
const MAX_PER_TICKER = 3;
const TIERS = ['HIGH', 'MEDIUM', 'LOW'];
const FIVE = 5 * 60_000;

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

const tier = (adv: number) => (adv >= 5e6 ? 'HIGH' : adv >= 1e6 ? 'MEDIUM' : 'LOW');
const segment = (hhmm: string) => (hhmm < '11:30' ? 'MORNING' : hhmm < '14:00' ? 'MIDDAY' : 'AFTERNOON');
/** Small deterministic PRNG (mulberry32) so the selection is reproducible. */
function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

interface Cand { date: string; ticker: string; candle: string; tier: string; adv: number; segment: string; sipRvol: number; band: number }

async function main() {
  const c = creds();
  const pilot = readFileSync(join(DIR, 'pilot-sample.csv'), 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(',').slice(0, 3).join('|'));
  const all: Cand[] = [];
  for (const ticker of TICKERS) {
    const start = etToEpoch(previousTradingDates(DAYS[0], 20).slice(-1)[0], '09:30');
    const rth = regularSessionBars(await bars5(ticker, start, etToEpoch(DAYS[DAYS.length - 1], '16:00'), c));
    for (const date of DAYS) {
      const prior = new Map<string, number>();
      for (const b of rth) { const d = etParts(b.t).date; if (d < date) prior.set(d, (prior.get(d) ?? 0) + b.v); }
      const dv = [...prior.values()].slice(-20);
      const adv = dv.reduce((a, b) => a + b, 0) / Math.max(1, dv.length);
      for (const b of rth) {
        const p = etParts(b.t);
        if (p.date !== date || p.hhmm < '09:40' || p.hhmm > '15:50') continue; // skip the opening print and the 15:55 closing ramp
        const r = historicalParityRvol(rth, b.t, b.v).value;
        if (r == null) continue;
        const band = BANDS.findIndex((x) => r >= x.lo && r < x.hi);
        if (band < 0 || pilot.includes(`${date}|${ticker}|${p.hhmm}`)) continue;
        all.push({ date, ticker, candle: p.hhmm, tier: tier(adv), adv, segment: segment(p.hhmm), sipRvol: r, band });
      }
    }
  }
  // Fill each band's quota, rotating day × segment, preferring new days, capping per ticker, and spacing candles of
  // the same ticker/day ≥ 30 min apart (adjacent candles share 19 of 20 baseline bars).
  const rand = rng(20261031);
  const picked: Cand[] = [];
  const perTicker = new Map<string, number>();
  const cells = DAYS.flatMap((d) => ['MORNING', 'MIDDAY', 'AFTERNOON'].map((s) => ({ d, s })));
  for (let bi = 0; bi < BANDS.length; bi++) {
    const pool = all.filter((x) => x.band === bi).sort(() => rand() - 0.5);
    let k = 0;
    for (let guard = 0; guard < 400 && picked.filter((x) => x.band === bi).length < BANDS[bi].want; guard++) {
      const cell = cells[(bi * 2 + k++) % cells.length];
      const ok = (x: Cand) => x.date === cell.d && x.segment === cell.s && (perTicker.get(x.ticker) ?? 0) < MAX_PER_TICKER && !picked.includes(x)
        && !picked.some((y) => y.ticker === x.ticker && y.date === x.date && Math.abs(etToEpoch(x.date, x.candle) - etToEpoch(y.date, y.candle)) < 6 * FIVE)
        && !picked.some((y) => y.ticker === x.ticker && y.segment === x.segment && y.date === x.date);
      // rotate the preferred liquidity tier so HIGH / MEDIUM / LOW are all represented; fall back to any tier
      const want = TIERS[picked.length % TIERS.length];
      const cand = pool.find((x) => ok(x) && x.tier === want) ?? (guard > 200 ? pool.find(ok) : undefined);
      if (!cand) continue;
      picked.push(cand);
      perTicker.set(cand.ticker, (perTicker.get(cand.ticker) ?? 0) + 1);
    }
  }
  picked.sort((a, b) => (a.date + a.candle + a.ticker).localeCompare(b.date + b.candle + b.ticker));

  writeFileSync(join(DIR, 'expansion-selection.csv'), ['date,ticker,candle_et,liquidity,adv_shares,segment,sip_proxy_rvol,proxy_band']
    .concat(picked.map((x) => [x.date, x.ticker, x.candle, x.tier, Math.round(x.adv), x.segment, x.sipRvol.toFixed(3), `${BANDS[x.band].lo}-${BANDS[x.band].hi}`].join(','))).join('\n') + '\n');
  writeFileSync(join(DIR, 'expansion-capture.csv'), ['# BLIND capture sheet: read every value from the COMPLETED 5m candle in TrendSpider (5m chart, Extended Hours OFF).',
    '# alert_linked: YES only if a genuine RB TrendSpider alert fired on this candle (then fill direction LONG/SHORT); NO otherwise.',
    '# ts_sma20_prev: hover the PREVIOUS candle and read its Volume SMA20 if you can (provenance OBSERVED); leave blank otherwise.',
    '# Genuine RB alert candles from 2026-10-28/29/30 that are not listed: append them as extra rows (alert_linked YES).',
    'date,ticker,candle_et,alert_linked,direction,ts_volume,ts_sma20,ts_sma20_prev,ts_rvol']
    .concat(picked.map((x) => [x.date, x.ticker, x.candle, '', '', '', '', '', ''].join(','))).join('\n') + '\n');

  // master sample: pilot rows (with alert_linked) + new rows with blank TrendSpider columns
  const masterPath = join(DIR, 'master-sample.csv');
  if (existsSync(masterPath)) throw new Error('master-sample.csv already exists — refusing to overwrite captured data.');
  const [head, ...rows] = readFileSync(join(DIR, 'pilot-sample.csv'), 'utf8').split(/\r?\n/).filter(Boolean);
  const cols = head.split(',');
  const linked = (r: Record<string, string>) => (/test alert/i.test(r.context) ? 'TEST' : r.direction ? 'YES' : 'NO');
  const out = ['date,ticker,candle_et,direction,alert_linked,context,ts_volume,ts_sma20,ts_sma20_prev,ts_sma20_prev_source,ts_rvol'];
  for (const l of rows) {
    const r = Object.fromEntries(l.split(',').map((v, i) => [cols[i], v]));
    out.push([r.date, r.ticker, r.candle_et, r.direction, linked(r), r.context, r.ts_volume, r.ts_sma20, r.ts_sma20_prev, r.ts_sma20_prev_source, r.ts_rvol].join(','));
  }
  for (const x of picked) out.push([x.date, x.ticker, x.candle, '', '', 'expansion (SIP-proxy selected)', '', '', '', '', ''].join(','));
  writeFileSync(masterPath, out.join('\n') + '\n');
  const t = (k: keyof Cand) => Object.entries(picked.reduce<Record<string, number>>((a, x) => ((a[String(x[k])] = (a[String(x[k])] ?? 0) + 1), a), {})).map(([a, b]) => `${a}:${b}`).join(' ');
  console.log(`picked ${picked.length} | by day ${t('date')} | by tier ${t('tier')} | by segment ${t('segment')} | tickers ${new Set(picked.map((x) => x.ticker)).size}`);
  console.log(`tier of each ticker: ${[...new Set(all.map((x) => `${x.ticker}=${x.tier}`))].join(' ')}`);
}

main().catch((e) => { console.error(String((e as Error).message ?? e).replace(/[A-Za-z0-9]{20,}/g, '[redacted]')); process.exit(1); });
