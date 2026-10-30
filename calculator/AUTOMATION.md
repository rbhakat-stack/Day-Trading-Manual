# Automated Alert Mode — setup and operating notes

**RB v1.1 — FROZEN FOR PAPER TESTING.** Automation changes *how inputs are collected*, not the strategy.
Every formula, hard rule, score, threshold and portfolio rule comes from the existing engine (`src/engine/`).

> **No trade execution.** The app never places, modifies or cancels an order at Alpaca, TrendSpider, SignalStack or
> any broker. Alpaca is used **only** for read-only market data (enforced in code: `netlify/lib/alpaca.ts` accepts
> nothing but `GET https://data.alpaca.markets/v2/stocks/…`, and a test scans the code for trading endpoints).
> You still enter every order manually in TrendSpider.

---

## 1. How it works

```
TrendSpider alert ──webhook──▶ /.netlify/functions/trendspider-alert   (token check, validation, de-duplication)
                                   │  store RECEIVED (Netlify Blobs)
                                   │  wait 3 s for the signal candle to settle
                                   │  GET 5-minute bars (6 trading days) + last trade  ── Alpaca Market Data (read-only)
                                   │  buildAlertSnapshot(): signal candle, ATR/EMA/RSI/RVOL/VWAP, last completed 15m
                                   │  evaluateTrade() (shared calculator, reference)
                                   ▼  store OK — immutable alert-time snapshot  (or DATA_ERROR with the reason)
Browser (Live Alert Queue) ──polls──▶ /.netlify/functions/rb-alerts   +   /.netlify/functions/rb-quotes (live price)
   micro-batch (3 s) → candidate built once from the frozen snapshot (shared calculator)
   → live state re-evaluated with the current price (shared calculator: waiting / crossed / chased / stale)
   → ONE global ranking with the existing Opportunity Ranker (score → portfolio → correlation → capital)
   → final safety gate → TrendSpider ticket only if every check passes
```

Ranking, capital allocation, pending orders and positions stay in the browser because your RB v1 portfolio already
lives there. The server stores only the immutable alert snapshots.

### Final safety gate (an active ticket needs ALL of these)

1 webhook valid · 2 market data valid · 3 alert-time snapshot constructed · 4 15m confirmation valid ·
5 all RB v1 hard rules pass · 6 not stale · 7 not chased · 8 valid calculator structure · 9 Opportunity Score ≥ 85 ·
10 portfolio rules pass and capital allocated · 11 current-price data fresh · 12 no material data mismatch.
Otherwise the card shows the reason and no ticket. Data-blocked alerts never consume capital in the allocation.

### Decision states

| State | Meaning |
|---|---|
| **TRADE NOW — ELITE** | ≥ 90, every gate passes — ticket shown |
| **HIGH PRIORITY — TRADE CONSIDERATION** | 85–89, every gate passes — ticket shown |
| **WATCHLIST** | 80–84; or ≥ 85 without capital/slot/correlation room; or trigger already crossed (manual review) |
| **SKIP** | below 80 |
| **NOT ELIGIBLE** | hard-rule failure (time window, candle, 15m, stale, chased, duplicate …) |
| **DATA REVIEW REQUIRED** | data incomplete, mismatched, stale or errored — *DATA INCOMPLETE — DO NOT TRADE* / *DATA MISMATCH — MANUAL REVIEW* |
| ORDER SUBMITTED / IN POSITION / CLOSED | statuses you set (PENDING, FILLED, exits) |

Fresh breakouts are always **BUY STOP** (LONG) or **SELL STOP** (SHORT). A crossed trigger is never turned into a
Market, Limit or pullback order: ≤ 0.25 ATR → *TRIGGER CROSSED — MANUAL REVIEW* (use the manual Calculator's late-entry
recalculation if you want to act); > 0.25 ATR → *DO NOT CHASE*.

---

## 2. Netlify setup

1. **Base directory.** The app lives in `calculator/`. In Netlify → *Site configuration → Build & deploy*, set
   **Base directory = `calculator`** (then `calculator/netlify.toml` is used: build `npm run build`, publish `dist`,
   functions `netlify/functions`). If your site already builds from `calculator`, nothing changes.
2. **Environment variables** (Site configuration → Environment variables). Scope them to **Functions**. Never commit them.

| Variable | Value | Notes |
|---|---|---|
| `TRENDSPIDER_WEBHOOK_SECRET` | long random string | goes into the TrendSpider JSON note as `"token"` |
| `RB_APP_ACCESS_TOKEN` | a *different* long random string | you type it once into the app (Automation settings) |
| `ALPACA_API_KEY` | Alpaca key ID | market data only |
| `ALPACA_SECRET_KEY` | Alpaca secret | market data only |
| `ALPACA_DATA_BASE_URL` | `https://data.alpaca.markets` | optional (default). Only Alpaca **data** hosts are accepted |
| `ALPACA_DATA_FEED` | `sip` (default) or `iex` | see the data-feed note below |

   Generate secrets, e.g. PowerShell: `-join ((1..48) | % { '{0:x}' -f (Get-Random -Max 16) })`, or `openssl rand -hex 32`.
3. **Netlify Blobs** (alert storage) needs no setup on Netlify.
4. Deploy. Then in the app: **Live Alert Queue → Automation settings** → paste `RB_APP_ACCESS_TOKEN` → **Check server
   setup** (shows only true/false for each variable, never values) → switch **Automated Alert Mode ON**.
5. Local development with functions: `npx netlify dev` (plain `npm run dev` has no functions; the queue then says so).

### Data feed (important for accuracy)

* `sip` = consolidated tape (all exchanges) — closest to what TrendSpider charts. **Real-time SIP needs a paid Alpaca
  market-data subscription.** Without it Alpaca answers *403 subscription does not permit querying recent SIP data*,
  and every alert becomes **DATA ERROR — MANUAL REVIEW REQUIRED** (fail closed; nothing is guessed).
* `iex` = one exchange only (free). Prices are usually close, but **volume, RVOL and VWAP differ materially** from the
  consolidated tape. Expect data-parity mismatches; do not rely on IEX values without validation.

---

## 3. TrendSpider alert setup

Webhook URL for both RB v1 alerts: `http://localhost:8888/.netlify/functions/trendspider-alert`

**Your Note** (JSON). LONG alert:

```json
{"strategy":"RB_V1","symbol":"{{ticker}}","direction":"LONG","alert_name":"RB v1 LONG Setup","token":"<TRENDSPIDER_WEBHOOK_SECRET>"}
```

SHORT alert: the same with `"direction":"SHORT"` and `"alert_name":"RB v1 SHORT Setup"`.

* **VERIFY in TrendSpider** which placeholders its webhook note supports (ticker, price, time). The symbol must be the
  real ticker; if your note cannot insert it, create the alert per symbol with the ticker typed in.
* `alert_time` (ISO-8601 **with offset**, e.g. `2026-10-30T14:30:00-04:00`) and `last_price` are optional. Without
  `alert_time` the server's receipt time is used and labelled in *Show data validation*. A timestamp without an offset
  is rejected (ambiguous).
* The token is in the body because TrendSpider webhooks cannot set custom headers. It is compared in constant time and
  removed before anything is stored or logged.

**Test without trading data** (validated, never stored):

```bash
curl -X POST https://<your-site>.netlify.app/.netlify/functions/trendspider-alert -H "content-type: application/json" -d '{"strategy":"RB_V1","symbol":"NVDA","direction":"SHORT","alert_name":"RB v1 SHORT Setup","test":true,"token":"<secret>"}'
```

---

## 4. Data semantics (what is computed, and from which candle)

| Item | Rule |
|---|---|
| Session | Regular session only (09:30–16:00 ET, Extended Hours OFF). America/New_York with DST via `Intl`; never the browser's zone |
| Signal candle | The 5m candle that **completed most recently at the alert time** (alerts fire on the 5m close): 10:07:30 → 10:00–10:05; 10:10:02 → 10:05–10:10. If that exact bar is missing → DATA INCOMPLETE (no fallback). If the alert arrives > 120 s after that candle closed → *signal candle ambiguous* → review |
| Settle delay | The server waits until 3 s after the candle close before fetching it (late trade reports) |
| Indicators | Bars up to and including the signal candle only; ≥ 100 bars of history required (6 trading days fetched) |
| EMA9 / EMA20 | α = 2/(n+1), seeded with an SMA |
| RSI14 / ATR14 | Wilder (RMA) smoothing, SMA-seeded |
| RVOL20 | Volume ÷ SMA(Volume, 20), current bar included (TrendSpider Relative Volume, Length 20, SMA, Base 1) |
| VWAP | HLC3. **SESSION** (default, resets 09:30) or **ROLLING_14** — TrendSpider's `VWAP(14, 0, HLC3)` meaning is an open VERIFY item; both values are shown and the parity screen decides |
| 15m confirmation | Last **fully completed** regular-session 15m candle at the alert time (`lastCompleted15mCandle`, same function as the manual calculator): 10:07 → 09:45–10:00 · 10:18 → 10:00–10:15 · 14:40 → 14:15–14:30 · 15:40 → 15:15–15:30 (15:40 also hard-fails the entry window). 15m bars are aggregated from the 5m bars |
| Consistency check | The six TrendSpider alert conditions are re-checked on the automated values; if TrendSpider fired but the automated data disagrees → *DATA MISMATCH — MANUAL REVIEW* |
| Calendar | NYSE holidays/early closes for **2026–2027** (`marketCalendar.ts` — verify yearly). Other years → automated tickets disabled. **Early-close days: every automated alert goes to manual review** (the RB v1.1 window is defined for full sessions only) |

Alert-time values are frozen in the stored snapshot and in the candidate; only the current price, alert age,
trigger/chase state, ranking and capital change afterwards.

---

## 5. Defaults (Automation settings; all configurable)

| Setting | Default | Why |
|---|---|---|
| Micro-batch window | 3 s | alerts arriving together are scored together; no early "#1" |
| Max batch hold | 15 s | a slow enrichment never blocks the rest |
| Max current-price age | 5 s | no TRADE NOW from stale prices |
| Max last-trade age | 60 s | a liquid S&P 500 name trades every few seconds on SIP |
| Price-source mismatch | MAX($0.02, 0.10% × price) | about one or two typical spreads plus a few seconds of movement; well inside the 0.25 ATR chase limit, so a source difference is caught before it can flip a decision |
| Parity tolerances | prices ±$0.02 · ATR ±5% · EMA/VWAP ±0.05% · RVOL ±15% · RSI ±2 pts | |
| Parity comparisons before "validated" | 20 | |

---

## 6. Before you rely on it (integration checklist)

1. Send the test payload (section 3) and check *Netlify → Functions → Logs* for `webhook_test`.
2. Let real alerts arrive with **Automated Alert Mode ON**; for every one of the first 20–30, open
   **Data validation**, type the values from your TrendSpider chart (same signal candle and the same last completed
   15m candle) and save. Any value outside tolerance removes that alert's ticket.
3. **Verify the signal-candle semantics** on those alerts: does TrendSpider's alert time correspond to the close of the
   candle shown as *Signal candle* in *Show data validation*? If not, stop and adjust before trading.
4. Decide the VWAP mode from the parity results.
5. Only when the parity status is **VALIDATED** should you stop re-checking each value manually.

---

## 7. Known limitations

* **Sectors:** the data provider supplies none. Unknown tickers are *SCORING INCOMPLETE* until classified once
  (queue card) or imported as CSV (`Ticker,Sector,Industry,Theme`) in Automation settings.
* **Per-browser portfolio:** pending orders, positions and statuses live in this browser's storage (as before).
  Use one browser as the operating station.
* **Netlify time limit:** synchronous functions stop after ~10 s. Enrichment has an 8 s budget; a record that times out
  is retried automatically by the app (max 3 attempts), then shows *MANUAL REVIEW REQUIRED*.
* **Rate limiting** is per function instance (best effort); storage-level de-duplication is the real guard.
* **Calendar** must be extended for 2028+.
* **Notifications** are not implemented (opt-in only, if added later).

## 8. Files

| File | Role |
|---|---|
| `netlify/functions/trendspider-alert.mts` | webhook receiver |
| `netlify/functions/rb-alerts.mts` · `rb-quotes.mts` · `rb-health.mts` | app read endpoints (bearer token) |
| `netlify/lib/` | auth, read-only Alpaca client, storage, processor, structured logs |
| `src/engine/automation/` | shared pure modules: time/calendar, indicators, snapshot, decision gate, queue, parity |
| `src/components/live/` | Live Alert Queue, Data validation, Automation settings |
| `src/engine/automation/__tests__/`, `netlify/__tests__/` | automated tests |
