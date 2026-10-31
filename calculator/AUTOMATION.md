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
| RVOL20 | Volume ÷ SMA(Volume, 20), current bar included (TrendSpider Relative Volume, Length 20, SMA, Base 1). **Known difference:** TrendSpider's denominator is the SMA20 ending at the *previous* bar (current bar excluded). Live RB v1.1 is frozen and unchanged; only the Historical SIP diagnostic uses the TrendSpider formula (section 9). |
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
| `netlify/functions/rb-historical-parity.mts` · `netlify/lib/historicalSip.ts` · `src/engine/automation/historicalParity.ts` · `src/components/live/HistoricalSipTest.tsx` | Historical SIP Parity Test (diagnostic only, section 9) |

---

## 9. Historical SIP Parity Test

> **DIAGNOSTIC ONLY — NO TRADE TICKET / NO LIVE DECISION.** This tool is separate from the live pipeline. It does not
> create, rank, allocate capital to, store or execute anything.

### Purpose

Answer one question before you pay for real-time SIP: *for this exact historical TrendSpider alert, would Alpaca SIP
have produced materially the same candle and indicator values?* The live path cannot answer it on a free plan: it also
fetches the current price (latest trade), which needs a real-time SIP subscription, so `ALPACA_DATA_FEED=sip` currently
ends in *DATA ERROR*.

### Intrabar alerts — why the signal candle is the ACTIVE candle here

TrendSpider RB v1 multi-factor alerts can fire **before** the 5m candle closes. Two observed cases:

* **IBM.** The alert came at ≈ 15:54. The signal candle was the still-forming 15:50–15:55.
* **NEE.** The alert came at ≈ 15:44. The signal candle was the still-forming 15:40–15:45. The earlier diagnostic
  wrongly picked the completed 15:35–15:40.

So this diagnostic reconstructs the **active** 5m candle as it looked at the alert instant. The live webhook path is
**unchanged**: it still uses the last completed 5m candle (section 4). Whether the live path should change is a
separate decision, to be made only after enough parity evidence.

### How to use it

1. **Live Alert Queue → Historical SIP Test** (the app access token must be set in Automation settings).
2. Enter the **ticker** and **direction**, then choose the **timestamp precision**:
   * **Exact second:** `YYYY-MM-DD HH:MM:SS`, e.g. `2026-10-30 15:44:00`.
   * **Approximate minute:** `YYYY-MM-DD HH:MM`, e.g. `2026-10-30 15:44`. Use this when TrendSpider shows only the
     minute.
3. Click **RUN HISTORICAL SIP TEST**. **Alert timing** shows:
   * the requested timestamp
   * the active 5m candle
   * the reconstruction cutoff(s)
   * the completed 15m candle
   * the precision
   * the 1-minute bars used
4. Type the 12 TrendSpider values: O/H/L/C, ATR14, EMA9, EMA20, RSI14, RVOL20, VWAP, 15m Close, 15m EMA20. The table
   compares them with the existing Automation-settings tolerances, which are unchanged and not loosened.
5. **Derived RB v1 Ticket — Diagnostic Only** is labelled *DERIVED FROM INTRABAR HISTORICAL RECONSTRUCTION — NOT AN
   ACTIVE TRADE*. After 15:30 it shows NOT ELIGIBLE, exactly as the calculator does.

### Reconstruction algorithm and timestamp rules

**Data.** Two historical SIP requests are made:

* 5-minute bars for the completed history, from 09:30 ET five trading days back (the same start as live) up to the
  active bucket.
* 1-minute bars inside the active bucket, up to the latest cutoff.

**Definitions.** An Alpaca 1-minute bar stamped `t` covers trades in `[t, t + 60 s)`.

| Item | Rule |
|---|---|
| Active bucket | `[floor5(T), floor5(T) + 5 min)` on the 09:30 grid. 15:44:00 → 15:40–15:45; 15:54:00 → 15:50–15:55; 15:45:00 → 15:45–15:50 |
| 1m bar included | iff `bucketStart ≤ t` **and** `t + 60 s ≤ cutoff`. Every trade in it happened strictly before the cutoff |
| Exact second, `:00` | One reconstruction, cutoff = T. 15:44:00 uses the 15:40, :41, :42 and :43 bars. The 15:44 bar starts at 15:44:00 and is excluded |
| Exact second, other `:SS` | 1-minute bars cannot cut inside a minute. Shown as **INTRABAR_TIME_PRECISION_LIMITATION**, with a bracket: earliest = state at `HH:MM:00`, latest = state at `HH:MM+1:00` (may include trades after the alert) |
| Approximate minute `HH:MM` | Labelled **APPROXIMATE INTRABAR RECONSTRUCTION**. The alert happened somewhere in `[HH:MM:00, HH:MM:59]`, so it is bracketed the same way. Never treated as an exact second |
| Completed history | 5m bars with `t + 5 min ≤ bucketStart` |
| Alert exactly at a bucket start | The active candle has no trades yet: **NO_INTRABAR_DATA**, fail closed. Enter a time inside the candle you mean |

**Future-data leakage prevention.**

* The requests already end before the cutoff (1m `end` = cutoff − 1 s; 5m `end` = bucket start − 1 s).
* The engine also filters by the rules above, so nothing stamped at or after the cutoff can enter, even if a provider
  returned it.
* Tests modify every bar after the cutoff and assert the result is identical.

**Indicators.**

* The partial candle is built from the included 1m bars only:
  * open = first open
  * high = max high
  * low = min low
  * close = last close
  * volume = summed volume up to the cutoff
* It is appended to the completed 5m history.
* The **unchanged** `buildAlertSnapshot`, and therefore the unchanged EMA / Wilder RSI / ATR / VWAP functions,
  computes O/H/L/C, ATR14, EMA9, EMA20, RSI14 and VWAP with that partial bar as the newest bar.
* RVOL20 is the one exception: it uses the diagnostic-only `historicalParityRvol` (below), not the shared same-bar
  `rvol()`.
* VWAP uses the configured mode (SESSION by default) over the same bars, so only volume up to the cutoff counts.

**RVOL: TrendSpider-parity formula (diagnostic only).** TrendSpider's displayed Volume, Volume SMA20 and Relative
Volume values (VRSK, 6 consecutive completed candles) show:

`RVOL(t) = Volume(t) ÷ SMA20(Volume) ending at t−1`

That is, the current candle is **not** in its own baseline. The diagnostic uses exactly that:

* **Numerator:** active-candle volume up to the cutoff (the whole candle when the cutoff is its end).
* **Denominator:** SMA of the 20 completed regular-session 5m candles **before** the active candle. It depends only
  on candles that finished before the active one started, so it is **frozen** for the whole candle. The earliest and
  latest bounds share it; only the numerator grows.
* **Fewer than 20 completed candles:** `RVOL_PARITY_BASELINE_UNAVAILABLE`, fail closed.
* **Alert condition:** `RVOL20 > 1.5` in the diagnostic is evaluated on this value.

The parity table compares TrendSpider's RVOL with this **TrendSpider-parity SIP RVOL** and nothing else. The old
same-bar value is shown beside it as *LEGACY RB FORMULA — DIAGNOSTIC ONLY*, for reference.

**Formula parity is not data parity.** TrendSpider's volume series can differ materially from Alpaca SIP. On VRSK
12:25, TrendSpider shows 6,649 shares and SIP has 11,336. No scaling or vendor correction is applied. Every result
still carries **RVOL SEMANTICS UNDER VALIDATION** until the cross-ticker volume study is done.

**15m confirmation is unchanged.** It is the last fully completed 15m candle at the alert time (the same rule and code
as live), computed only from completed history. At 15:44 it is 15:15–15:30, because 15:30–15:45 is still forming.

**Comparison with a bracket.**

* **PASS** = within tolerance of at least one bound; the table says which.
* **BETWEEN BOUNDS — UNRESOLVED** = the TrendSpider value lies between the earliest and latest values but is within
  tolerance of neither. 1-minute data cannot resolve it.
* **MISMATCH** otherwise.

### IBM and NEE

* **IBM ≈ 15:54 LONG.**
  * Active candle 15:50–15:55, 15m candle 15:30–15:45.
  * The **latest** bound includes all five minutes, so it equals the completed 15:50–15:55 candle that previously
    matched all 12 TrendSpider values (a regression test asserts the identity on synthetic data). RVOL is the
    exception: it now uses the TrendSpider-parity formula, so it differs slightly from that earlier value.
  * The **earliest** bound (through 15:54:00) omits the 15:54 minute. High, low, close, volume, RVOL and VWAP can
    differ by whatever traded in that last minute. If TrendSpider matches the latest bound and not the earliest, the
    alert fired late in the 15:54 minute, or TrendSpider values the candle as of its close.
* **NEE ≈ 15:44 SHORT.**
  * Active candle 15:40–15:45 (no longer 15:35–15:40), 15m candle 15:15–15:30.

### Why it needs no real-time SIP subscription

* It requests **only** `GET /v2/stocks/{symbol}/bars` with `feed=sip` and `timeframe` `1Min` or `5Min`. A
  server-side guard rejects every other request before any network call: latest trade, latest quote, snapshots,
  quotes, trades, a non-SIP feed, another timeframe, or an end time newer than 16 minutes. The age check is applied to
  the **latest** cutoff.
* Alpaca serves SIP **historical** bars on the free plan when the requested end is at least 15 minutes old. The test
  refuses anything newer and tells you when to retry. There is no current-price fetch at all.
* The SIP feed is forced for this request only. `ALPACA_DATA_FEED` is neither read nor changed, so live alerts keep
  their configured feed.

### What it never does

* **No live records.** It never creates or changes a live alert record and never touches the Netlify Blobs store,
  so it cannot affect de-duplication. A later real webhook for the same alert is stored normally.
* **No trading state.** It never creates an Opportunity Ranker candidate, reserves capital, changes portfolio heat,
  writes to the Journal, or changes Data-validation (IEX) parity entries.
* **No IEX fallback.** If SIP fails, the reason is shown and the test stops. The possible reasons are:
  * authorization failure (401/403)
  * entitlement failure (403 *subscription does not permit…*)
  * historical window unavailable (400/422)
  * rate limit
  * network
  * missing bars, or insufficient lookback (from the snapshot)
* **No secrets in responses.** Provider messages are sanitised, and keys never appear in responses or logs.
* **No persistence.** Results are kept only in your browser (`rbv1.diagnostics.historicalSip.v3`), apart from all
  live keys.

### Interpreting the results

* **PASS on all 12 fields** for several historical alerts: SIP reproduces TrendSpider closely enough for the live
  tolerances. That is evidence (not proof) that paying for real-time SIP would remove the IEX mismatches.
* **Persistent MISMATCH** on the same field: the gap is not a feed issue but a definition difference, so fix the setting
  rather than the feed. Examples:
  * VWAP mode (`SESSION` vs `ROLLING_14`; the alternative VWAP is in the snapshot)
  * ATR smoothing
  * TrendSpider's Extended Hours setting
* **ALERT_NOT_REPRODUCED** (review notice): the SIP values do not satisfy all six alert conditions. Investigate before
  trusting either source.
* The tool never decides that SIP is "better". It only reports differences against your TrendSpider values.
* The derived ticket is evaluated *as of the alert* (reconstructed close as price, 0 min elapsed), so time rules still
  apply. For example, 15:44 and 15:54 are after the 15:30 entry window, so the status shows NOT ELIGIBLE while the
  entry/stop/target/size math is still displayed.

### Limitations of minute-level reconstruction

* **Seconds.** Only `:00` cutoffs are exact; other seconds are bracketed. Exact-second cuts would need historical
  trades, which are not used: matching Alpaca's bar construction (trade-condition filtering) from raw trades would add
  its own error.
* **Gaps.** A minute with no trades has no 1m bar. This is flagged as INTRABAR_MINUTES_MISSING (or
  INTRABAR_OPEN_UNCERTAIN if the first minute is missing). OHLCV is still correct for the trades that exist.
* **Consistency between bar sizes.** The 5m history (Alpaca 5Min bars) and the 1m intrabar bars come from the same SIP
  trades. Alpaca's 5m bar is assumed to equal the aggregate of its 1m bars.
* **Early session.** Alerts before 09:45 have no completed 15m candle, so the result is incomplete. That is consistent
  with the live rule, and RB v1 does not trade before 09:45 anyway.
* **Odd-lot-only minutes.** Alpaca emits no 1m bar for a minute that contains only odd-lot trades, so that volume is
  missing from both the 1m and the 5m bars. On VRSK 2026-10-30, 10:50–12:35, this lost 6,609 of 177,010 shares. Such a
  minute can also raise INTRABAR_MINUTES_MISSING even though trades did occur.
* **RVOL:** the formula matches TrendSpider; the volume data may not (see above).

### Rollback

The feature is additive. To remove it:

1. Delete `netlify/functions/rb-historical-parity.mts`. The endpoint disappears and nothing else calls it.
2. Optionally also remove:
   * the `historical` sub-tab line in `src/App.tsx`
   * `src/components/live/HistoricalSipTest.tsx`
   * `runHistoricalSip` in `src/lib/automationClient.ts`
   * `netlify/lib/historicalSip.ts`
   * `src/engine/automation/historicalParity.ts`
   * the optional `getBars1` method in `netlify/lib/alpaca.ts`, which only this feature uses
   * the `minuteBars` / `toFive` test fixtures
   * the new test files
   * the three `historical_test_*` log event names
3. No data migration is needed.
