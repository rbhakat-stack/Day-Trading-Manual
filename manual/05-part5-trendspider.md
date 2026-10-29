# PART V — TRENDSPIDER (LEVEL 5) {.unnumbered .part}

::: {.warn custom-style="Box Warn"}
**ABOUT THE UI INSTRUCTIONS IN THIS PART**

The labels in **bold monospace-like quotes** (e.g., **NEW SCANNER**, **Skip to Point & Click Editor**, **Create Alert**) come from TrendSpider's official Knowledge Base as checked on 2026-10-28. TrendSpider updates its interface frequently, and some help articles disagree with each other (e.g., how to add a sidebar widget). Where the documentation was silent, the step is marked **VERIFY**. No screenshots in this manual were captured from the live product yet: each is a placeholder for you to fill (Appendix C).
:::

# TrendSpider — The Complete UI Tour

## The main areas

| Area | What it is | Official name(s) [TS] |
|---|---|---|
| **Main chart** | The price chart for the current symbol | — |
| **Symbol / ticker selector** | Type a ticker to load it | **Symbol Search & Selection Field** |
| **Timeframe** | Candle period, 1 minute to monthly | **Timeframe** dropdown |
| **Chart type** | Line, Bars, Candles, Hollow Candles, Raindrop, Heikin Ashi | **Chart Type** |
| **Top toolbar** | Toggles and tools | see below |
| **Right sidebar** | Widgets: watchlists, notifications, trading, etc. | **Watch Lists**, **Notifications**, Trading Widget |
| **Bottom panel / bottom-left** | Opens Strategy Tester and (in single-symbol workspaces) Market Scanner | **Strategy Tester**, **Market Scanner** |
| **Account menu** | Profile icon, top right | **Account & Settings**, **Log Out** |

## Top toolbar — what each control does [TS]

| Control | Purpose | Used in v1? |
|---|---|---|
| **Add or Remove From Watch Lists** | Create/delete watchlists, assign the symbol | Yes |
| **Workspace Layout Switcher** | 1–4 charts on screen | Optional: show 5m and 15m side by side |
| **Toggle Multi Time Frame Analysis (MTFA)** | Show indicators/trendlines from other timeframes | Optional |
| **Toggle Automatic Fibonacci** | Auto Fibonacci retracements | No |
| **Toggle Trends** | Automatic trendlines | No |
| **Toggle Standard Indicators** / **Indicators** | Show/hide indicators; the ⋮ next to Indicators opens the **Indicator Manager** | **Yes** |
| **Toggle Candlestick Patterns** | Marks detected candle patterns | Optional, educational |
| **Toggle Chart Patterns** | Marks chart formations | No |
| **Toggle Heatmap** | Support/resistance zones | Optional (Do-Not-Take item 5) |
| **Toggle Other Data** | Earnings, dividends, splits, analyst estimates, short volume | **Yes**: check earnings |
| **Alerts & Bots** | Show alerts; ⋮ menu creates **Simple Dynamic Alert**, **Multi-Factor Alert**, **Trading Bot** | **Yes** |
| **Visual Scripts** | Opens the **Script Manager** (saved condition templates) | Yes (templates) |
| **Sidekick AI** | AI assistant | Yes (with care) |
| **Share Chart Tool** | Screenshot + share URL | **Yes**: journal screenshots |

::: {.shot custom-style="Box Screenshot"}
**[SCREENSHOT REQUIRED — SS-01 · TrendSpider full workspace, current UI]**

*Full screen:* single-chart workspace with AAPL 5m loaded. *Annotate:* ① Symbol Search field ② Timeframe dropdown ③ Chart Type ④ Indicators button and its ⋮ ⑤ Alerts & Bots and its ⋮ ⑥ Visual Scripts ⑦ Sidekick AI ⑧ right sidebar widgets ⑨ Strategy Tester button (bottom-left) ⑩ Market Scanner button ⑪ profile icon (Account & Settings).
:::

::: {.shot custom-style="Box Screenshot"}
**[SCREENSHOT REQUIRED — SS-02 · Top toolbar, cropped]**

*Crop:* the full top toolbar. *Annotate* each toggle with its official name from the table above.
:::

## Right sidebar widgets

| Widget | Purpose in v1 |
|---|---|
| **Watch Lists** | Shows your static LONG/SHORT lists and Smart Watchlists (scanner-driven) |
| **Notifications** | Alert triggers, expirations and errors, with timestamps in Eastern time [TS] |
| **Trading Widget** | Order ticket via SignalStack (Chapter 35) |

::: {.warn custom-style="Box Warn"}
**VERIFY — adding a widget**

TrendSpider's help articles describe adding a sidebar widget in two different ways ("Watch" button at the top of the widget list vs "Sidebar → Add New Widget"). Use whichever your UI shows, and note it in Appendix C (SS-19).
:::

## Settings

**Account & Settings** (profile icon, top right) manages notifications, profile and billing [TS]. Notification setup is in Chapter 29.

# Configuring My Chart (AAPL Example)

## Step-by-step

::: {.ts custom-style="Box TrendSpider"}
**TRENDSPIDER STEP — Load symbol and timeframe**

1. Click the **Symbol Search & Selection Field** and type `AAPL`, then press Enter.
2. Open the **Timeframe** dropdown and select **5 min**.
3. Set **Chart Type** to **Candles**.
4. Make sure extended-hours display matches your scanner/alerts. v1 = **regular session**. **VERIFY** where the chart's extended-hours toggle is in your UI, and record it in SS-04.
:::

::: {.shot custom-style="Box Screenshot"}
**[SCREENSHOT REQUIRED — SS-03 · Symbol Search with AAPL typed]** and **[SS-04 · Timeframe dropdown open with "5 min" highlighted]** — number ① symbol field, ② timeframe dropdown, ③ 5 min option.
:::

::: {.ts custom-style="Box TrendSpider"}
**TRENDSPIDER STEP — Add indicators via the Indicator Manager [TS]**

1. Click the **vertical ellipsis (⋮)** next to the **Indicators** button in the top menu bar to open the **Indicator Manager**.
2. Search the indicator by name (TrendSpider offers 200+). Select it, set its preferences, and click **Apply**.
3. To edit later: find it in the list of active indicators (right column) and adjust; or right-click the indicator on the chart → **Properties**; or use the **Quick Editor** via the chart legend's expand button.
4. To remove: the trash icon beside it.
:::

::: {.shot custom-style="Box Screenshot"}
**[SCREENSHOT REQUIRED — SS-05 · Indicator Manager open, search box with "Volume Weighted"]** — ① ⋮ next to Indicators ② search box ③ indicator result ④ active-indicators column ⑤ Apply button.
:::

## Exact v1 parameters

| Indicator (TrendSpider name) | Field | Value | Meaning |
|---|---|---|---|
| **Volume Weighted Average Price** | Length | 14 | Periods (see the Chapter 3 VERIFY box) |
| | Offset | 0 | Current candle |
| | Price Source | HLC3 | (H + L + C) ÷ 3 |
| **Exponential Moving Average** #1 | Length | 9 | EMA9 |
| | Offset | 0 | Current candle |
| | Price Source | Close | |
| **Exponential Moving Average** #2 | Length | 20 | EMA20 |
| | Offset | 0 | |
| | Price Source | Close | |
| **Relative Strength Index** | Length | 14 | RSI14 |
| | Upper band | 70 | Reference line only; v1 doesn't sell at 70 |
| | Lower band | 30 | Reference line only |
| | Price Source | Close | |
| **Relative Volume** | (MA) Length | 20 | Average of last 20 bars' volume |
| | MA Type | SMA | Simple average |
| | Base | 1 | Reference line = average volume |
| **Volume** | MA Length | 20 | Volume moving-average overlay |
| | MA Type | SMA | |

::: {.shot custom-style="Box Screenshot"}
**[SCREENSHOT REQUIRED — SS-06 to SS-11 · Each indicator's settings dialog]** — SS-06 VWAP, SS-07 EMA9, SS-08 EMA20, SS-09 RSI, SS-10 Relative Volume, SS-11 Volume. For each, crop the dialog and number every field in the order of the table above.
:::

::: {.shot custom-style="Box Screenshot"}
**[SCREENSHOT REQUIRED — SS-12 · Final configured AAPL 5m chart]** — ① VWAP line ② EMA9 ③ EMA20 ④ RSI pane with 70/30 ⑤ RVOL pane with base line 1 ⑥ Volume pane with MA20 ⑦ legend showing `VWAP(14, 0, HLC3)`.
:::

::: {.mistake custom-style="Box Mistake"}
**COMMON MISTAKE**

The chart, the scanner and the alerts each have **their own** indicator parameters. Changing VWAP on the chart does *not* change it in a saved alert. Whenever you change a parameter, update all three and log the change.
:::

**Tip:** Use the **Workspace Layout Switcher** to show two charts: AAPL 5m (left) and AAPL 15m with EMA20 (right).

# Market Scanner — Building the RB v1 Scanners

## Opening the scanner and starting a new scan [TS]

::: {.ts custom-style="Box TrendSpider"}
**TRENDSPIDER STEP — New scanner**

1. Click **Market Scanner** (in the bottom panel of single-symbol workspaces; in the top toolbar of Dashboard workspaces).
2. In the left panel click **NEW SCANNER**.
3. You can describe the scan to the AI builder, or click **Skip to Point & Click Editor** to build it manually. **Use the Point & Click Editor** so that every condition is exactly as specified.
4. Name: `RB v1 – Regular-Session Bullish Momentum`.
5. **Search In** (symbol list): choose **S&P 500**.
6. Chart type: candlestick.
7. Data options: tick **Current Candle**; leave **Ext. Hours** **unticked**.
:::

::: {.shot custom-style="Box Screenshot"}
**[SCREENSHOT REQUIRED — SS-13 · Market Scanner with NEW SCANNER and the AI / "Skip to Point & Click Editor" choice]** · **[SS-15 · Search In dropdown with S&P 500 selected]** · **[SS-16 · Current Candle ✓ and Ext. Hours ☐ checkboxes]**
:::

## Adding conditions

::: {.ts custom-style="Box TrendSpider"}
**TRENDSPIDER STEP — Conditions (same visual editor as Multi-Factor Alerts [TS])**

1. Click **add parameter here** → **Condition**.
2. **First set the timeframe** of the condition. TrendSpider says setting the timeframe is the first step when adding a parameter [TS]. To change it later, click the left side of the parameter block where the timeframe is shown.
3. Choose the **subject** (e.g., Price → Close, or Indicator → Exponential Moving Average 9).
4. Choose the **comparison** (e.g., *is above*, *is below*, *crossed above*).
5. Choose the **object**: a **Constant Value** (e.g., 10), another indicator (e.g., VWAP), or a value **N candles ago**.
6. Repeat for each condition. Ensure the group's logic is **All of the following**.
7. Hover over any part of a condition (it highlights) to edit it [TS].
8. Optional: **script actions… → Set all time frames to** applies one timeframe to all parameters [TS]. *Do not use it here*: you need three different timeframes.
:::

::: {.warn custom-style="Box Warn"}
**VERIFY — exact menu wording**

The terms *Price*, *Indicator*, *Constant Value*, *is above*, *candles ago* and *by at least* reflect your current build and standard TrendSpider scripting concepts, but the official pages reviewed do not reproduce every dropdown label. Capture SS-14 and correct any wording here.
:::

## The nine bullish conditions

| # | Timeframe | Subject | Comparison | Object |
|---|---|---|---|---|
| 1 | 5 min | Price: Close | is above | Constant Value **10** |
| 2 | 5 min | Price: Close | is below | Constant Value **500** |
| 3 | **Daily** | Indicator: Volume MA (Length 20) | is above | Constant Value **1,000,000** |
| 4 | 5 min | Indicator: Relative Volume (20, SMA) | is above | Constant Value **2.0** |
| 5 | **Daily** | Price: Close | is above | Price: Close **1 candle ago**, **by at least 1%** |
| 6 | 5 min | Price: Close | is above | Indicator: VWAP (14, 0, HLC3) |
| 7 | 5 min | Indicator: EMA (9) | is above | Indicator: EMA (20) |
| 8 | 5 min | Indicator: RSI (14) | is above | Constant Value **55** |
| 9 | **15 min** | Price: Close | is above | Indicator: EMA (20) |

::: {.shot custom-style="Box Screenshot"}
**[SCREENSHOT REQUIRED — SS-14 · Point & Click editor showing all nine conditions]** — number each condition 1–9 to match the table, and zoom-crop condition 5 to show the "1 candle ago" and "by at least 1%" controls.
:::

## Scan, save, results

::: {.ts custom-style="Box TrendSpider"}
**TRENDSPIDER STEP — Run and save [TS]**

1. Click **Scan**. TrendSpider evaluates every symbol in the list and shows matches in the right panel. Use the **Full Screen** toggle to see more results.
2. Click **Save**. The scan appears in the left panel and is searchable.
3. Results menu (three dots above results): **clone the results into a new watchlist** and **Columns To Display**.
4. **Scans do not auto-refresh.** Use the circular **Refresh Scan Results** button [TS].
5. Optional: three dots next to **Save** → **Run this scanner on a schedule** (results go to your inbox) or **Clone this scanner**.
:::

::: {.shot custom-style="Box Screenshot"}
**[SCREENSHOT REQUIRED — SS-17 · Scan results with the three-dot menu open]** — ① result list ② Refresh Scan Results ③ three-dot menu ④ "clone results into new watchlist" ⑤ Columns To Display.
:::

## The bearish scanner

Fastest method: open the bullish scanner → three dots next to **Save** → **Clone this scanner** → rename it `RB v1 – Regular-Session Bearish Momentum` → change **only** conditions 5–9:

| # | Change to |
|---|---|
| 5 | Daily Close **is below** Close 1 candle ago **by at least 1%** |
| 6 | 5m Close **is below** VWAP |
| 7 | 5m EMA9 **is below** EMA20 |
| 8 | 5m RSI14 **is below 45** |
| 9 | 15m Close **is below** EMA20 |

Conditions 1–4 are unchanged. Save. Capture as SS-18.

## Current Candle ON, Extended Hours OFF — why

| Setting | v1 value | Effect [TS] | Why for v1 |
|---|---|---|---|
| **Current Candle** | **ON** | The forming candle is used *as if closed*; OFF = last closed candle | Candidates appear in real time instead of up to 5 minutes late |
| **Ext. Hours** | **OFF** | Pre/post-market data excluded from calculations | v1 trades the regular session; pre-market data would distort VWAP, EMAs and RVOL |

Side effect of Current Candle ON: results can **change within the same 5 minutes**. A stock may appear at 10:02 and disappear at 10:04. That is normal. The scanner is a *candidate finder*; the **alert** (evaluated on closed candles) is the trigger.

## What would change for a true pre-market scanner

| Item | Regular-session v1 | Pre-market scanner |
|---|---|---|
| Ext. Hours | OFF | **ON** (and all indicators include pre-market data) |
| Daily % change | vs prior close | Gap % vs prior close (pre-market price) |
| RVOL | 5m vs recent bars | Pre-market volume vs typical pre-market volume (thin; very noisy) |
| VWAP | Session | Pre-market VWAP starting 04:00 |
| Orders | Any type | Limit orders only, with `extended_hours` TIF rules at the broker [ALP] |
| Status | — | **Not part of v1** |

# Smart Watchlists and Static Candidate Lists

| Type | What it contains | Updates | v1 role |
|---|---|---|---|
| **Dynamic scanner results** | Symbols passing the scan *at the moment you clicked Scan/Refresh* | Only when refreshed [TS] | Discovery |
| **Smart Watchlist** | A *saved scan* displayed in the Watch Lists widget, re-runnable from there [TS] | When refreshed | Convenient re-scan from the sidebar |
| **Static watchlist** | A fixed list of symbols you chose | Never, unless you edit it | **Alert targets**: the LONG/SHORT candidate lists |

::: {.ts custom-style="Box TrendSpider"}
**TRENDSPIDER STEP — Smart Watchlist [TS]**

1. Save the scan in Market Scanner.
2. Open the **Watch Lists** widget in the right sidebar.
3. Click the current watchlist name and pick the saved scan.
4. Refresh it from the widget when you want new results.
:::

::: {.ts custom-style="Box TrendSpider"}
**TRENDSPIDER STEP — Static candidate list**

Either: scan results → three dots → **clone the results into a new watchlist** (then delete the weaker names); or **Add or Remove From Watch Lists** on each chart. Name them by date: `RB v1 LONG 2026-10-29`, `RB v1 SHORT 2026-10-29`.
:::

::: {.shot custom-style="Box Screenshot"}
**[SCREENSHOT REQUIRED — SS-19 · Watch Lists widget selecting a saved scan as Smart Watchlist]** · **[SS-20 · Add or Remove From Watch Lists dialog creating "RB v1 LONG <date>"]**
:::

## The v1 candidate workflow

```
S&P 500 (~500 symbols)
   │  Market Scanner (bullish / bearish), ~9:40+ and refreshed periodically
   ▼
Scanner results (e.g. 5–40 names)
   │  Candidate ranking (Chapter 15)
   ▼
Static lists: RB v1 LONG <date> (≤10) · RB v1 SHORT <date> (≤10)
   │  Multi-Factor Alerts on each symbol (manually or via Sidekick)
   ▼
Alert fires → inspect → (maybe) paper trade
```

**Why static lists need refreshing daily (or intraday):** a stock that qualified at 9:45 may be flat by 11:00, and fresh movers appear. Alerts attach to *symbols*: an alert on yesterday's candidate keeps firing on yesterday's idea. Rebuild the lists every morning, review them around 11:00 and 13:30, and delete or let expire the alerts on dropped names.

# Sidekick — TrendSpider's AI Assistant

## What Sidekick is [TS]

Sidekick is an AI chat assistant **inside** TrendSpider. It works from TrendSpider's own data and, with your permission, your account content (charts, watchlists, backtests). Key facts:

| Capability / limit | Detail |
|---|---|
| **Can do** | Build, run, save and schedule scans; create and organise watchlists (including from scan results); build Multi-Factor Alerts for one ticker or a whole watchlist; add basic chart annotations; write custom indicators |
| **Alert creation limit** | ~**20 tickers per message** (soft limit) |
| **Analysis limit** | ~15–20 tickers at once; use a scan for larger lists |
| **Data it reads** | Price data, fundamentals, filings, earnings call transcripts, analyst estimates, options flow, short volume, insider activity, your chart, your broker holdings if SignalStack is connected (read-only) |
| **Cannot** | Browse the internet; **place, modify or close trades** |
| **News** | A news feed is **not** listed among its data sources → **VERIFY** before relying on it for news risk |
| **Messages** | **25 free messages per calendar month** on every plan; paid Sidekick packages add more |
| **Confirmation step** | The documentation does **not** describe an approval step before it acts → assume it acts immediately |

::: {.warn custom-style="Box Warn"}
**SAFETY WARNING — Sidekick can change your account**

Sidekick can create alerts, scans and watchlists. A vague prompt like "set alerts on my list" could create alerts on the *wrong* list, with the *wrong* conditions, or use up your alert capacity. **Before large actions:**

1. Ask it first to **describe** what it will do ("Show me the exact conditions and symbols you would use; do not create anything yet").
2. Check the list name, timeframe and every condition against this manual.
3. Then ask it to execute.
4. Afterwards, open 2–3 created alerts and verify them manually.
:::

## Prompt structure: Action + Scope + Filters + Output [TS]

| Part | Meaning | Example |
|---|---|---|
| **Action** | What to do | "Scan", "Rank", "Set alerts", "Add to watchlist" |
| **Scope** | The universe | "my watchlist RB v1 LONG 2026-10-29", "S&P 500" |
| **Filters** | Conditions | "5m RSI14 between 55 and 70" |
| **Output** | Format | "Table, top 10, columns: …" |

## Ready-to-copy prompts

**1. Rank bullish candidates**

```
Rank the symbols in my saved scan "RB v1 – Regular-Session Bullish Momentum"
(regular session only). For each, using the 5-minute chart, report: RVOL(20),
RSI(14), % distance of close from VWAP, (EMA9-EMA20)/price in %, 5m ATR(14),
distance from VWAP in ATR units, today's % change vs prior close, and whether
the 15-minute close is above a rising EMA20. Prefer RSI 55-70, RVOL 2-6,
VWAP distance 0.2-1.5 ATR, daily change +1% to +4%. Flag anything with RSI > 78,
RVOL > 10, or more than 2.5 ATR above VWAP as "overextended". Output a table
sorted best to worst, top 10. Do not create or modify anything.
```

**2. Rank bearish candidates**

```
Same as before but for "RB v1 – Regular-Session Bearish Momentum": prefer
RSI 30-45, price 0.2-1.5 ATR below VWAP, EMA9 below EMA20, daily change -1% to
-4%, 15-minute close below a falling EMA20. Flag RSI < 22, RVOL > 10, or more
than 2.5 ATR below VWAP. Also flag any stock down 10% or more from the prior
close (possible short-sale restriction). Top 10 table. Do not create anything.
```

**3. Create static watchlists**

```
Create a new watchlist named "RB v1 LONG <YYYY-MM-DD>" containing exactly these
symbols: <SYM1>, <SYM2>, ... Then show me the list contents. Do not add
alerts.
```

**4. Why does a stock qualify?**

```
On <SYMBOL>, regular session only: show the latest closed 5-minute candle's
open, high, low, close, volume, VWAP(14,0,HLC3), EMA9, EMA20, RSI14, RVOL(20,SMA)
and the latest 15-minute close and EMA20. For each RB v1 LONG condition
(close>VWAP, EMA9>EMA20, RSI>55, RVOL>1.5, close>open, 15m close>EMA20) say
TRUE/FALSE with the numbers.
```

**5. Compare candidates**

```
Compare <SYM1> and <SYM2> for an RB v1 LONG setup on the 5-minute chart:
extension from VWAP in ATR units, RSI, RVOL, EMA separation, nearest resistance
above (prior day high, today's high), and earnings date. Which has more room to
reach a 2R target from a break of the last candle's high? Table format.
```

**6. Create alerts across a watchlist (two-step)**

```
STEP 1 (preview only): For each symbol in watchlist "RB v1 LONG <date>",
describe the Multi-Factor Alert you would create: name "RB v1 – LONG Setup",
ALL of: 5m Close > VWAP(14,0,HLC3); 5m EMA(9) > EMA(20); 5m RSI(14) > 55;
5m Relative Volume(20, SMA) > 1.5; 5m Close > Open; 15m Close > EMA(20).
Regular session only (no extended hours). Expire at end of today. Do NOT create
yet - list the symbols and conditions.
```

Then, after checking: `STEP 2: Create exactly those alerts.` (≤ 20 symbols per message.)

**7. Review overextension**

```
For each symbol in "RB v1 LONG <date>", compute how many 5m ATRs price is above
VWAP and above the 5m EMA20, and count consecutive green 5-minute candles.
Mark "extended" if > 2.5 ATR above VWAP or > 5 consecutive green candles.
```

**8. News / earnings risk**

```
For each symbol in "RB v1 LONG <date>" and "RB v1 SHORT <date>": list the next
earnings date and flag any reporting today after the close or tomorrow before
the open. Note any data you have on unusual activity today. State clearly if
you do not have news data.
```

**9. Analyse an alert after it fires**

```
My "RB v1 – LONG Setup" alert fired on <SYMBOL> at <HH:MM> ET. Using the
5-minute candle that closed at that time as the signal candle: give its high,
open, close, low, range, range vs 5m ATR(14), distance of close from VWAP in
ATR, RSI, RVOL, and the close and EMA20 of the last COMPLETED 15m candle at
the alert time. Do not compute the order: I will use my Trade Calculator.
Note any nearby resistance within 2R. Do not create anything.
```

The order numbers (buffer, R with its 1 ATR minimum, stop, target and shares with the $20,000 cap) always come from the Trade Calculator (Chapter 38), never from Sidekick.

::: {.mistake custom-style="Box Mistake"}
**COMMON MISTAKE**

Treating Sidekick's numbers as authoritative. It is a language model. Spot-check any value you will trade on directly on your chart, especially entry, stop and size.
:::

::: {.shot custom-style="Box Screenshot"}
**[SCREENSHOT REQUIRED — SS-21 · Sidekick panel with a ranking prompt and table answer]** · **[SS-22 · Sidekick result after creating alerts, plus the alert list confirming them]**
:::

# Multi-Factor Alerts — RB v1 LONG and SHORT

## Facts that shape alert design [TS]

| Fact | Consequence |
|---|---|
| The lowest alert timeframe is **5 minutes** | v1 fits exactly; you cannot alert on 1m |
| An alert is checked **when the candle of its smallest timeframe closes** | Alert fires just after each 5m close; the signal candle is *complete* |
| Larger-timeframe conditions use the last calculated value and **can become untrue when that candle closes** | Re-check the 15m chart manually |
| Extended-hours data is **only** used if **Use Extended Hours** is ticked; that unlocks **Fire During** (Market hours / Extended session / Pre-Market / Post Market) | v1: leave **unticked** |
| **Expiration** sets how long it stays active *and* how many times it can fire; whichever comes first cancels it. Expiration counts **calendar days** | Choose deliberately |
| **Create Alert** applies to the **ticker currently open** | Alerts attach to *symbols* |
| Alerts are delivered via email, SMS, webhook (and the mobile app) | Chapter 29 |
| The Alerts FAQ documents a soft limit of **20 alerts per Sidekick message** | Batch by 20 |

## Screen-by-screen: building "RB v1 – LONG Setup"

::: {.ts custom-style="Box TrendSpider"}
**TRENDSPIDER STEP — Create the LONG alert [TS]**

1. Load the symbol (e.g., AAPL) on any timeframe.
2. Click the **vertical ellipsis (⋮)** next to **Alerts & Bots** in the top toolbar → **Multi-Factor Alert**.
3. Choose **Skip to Point & Click Editor**.
4. **Chart Type:** Generic OHLC (candles).
5. **Alert Name:** `RB v1 – LONG Setup` (the symbol is appended automatically).
6. **Your Note:** `Inspect only. Run the RB v1.1 calculator: E = high + buffer; R = max(E - low, 1 ATR); 0.25% risk, $20k cap; 2R. 09:45-15:30 only.` Leave it plain text: JSON here is sent to a configured webhook.
7. **Expiration:** see the table below.
8. **Extended Market Hours / Use Extended Hours:** **unticked**.
9. Conditions: **add parameter here** → **Condition**, six times, all in one group set to **All of the following**:
:::

| # | Timeframe | Condition | Candle reference |
|---|---|---|---|
| 1 | 5 min | Close **is above** VWAP (14, 0, HLC3) | Happened (current) |
| 2 | 5 min | EMA (9) **is above** EMA (20) | Happened |
| 3 | 5 min | RSI (14) **is above** 55 | Happened |
| 4 | 5 min | Relative Volume (20, SMA, base 1) **is above** 1.5 | Happened |
| 5 | 5 min | Close **is above** Open | Happened |
| 6 | 15 min | Close **is above** EMA (20) | Happened |

10. Leave each condition on **Happened** (the default: the exact candle) rather than **Happened Within** N candles [TS].
11. Click **Create Alert**.

::: {.shot custom-style="Box Screenshot"}
**[SCREENSHOT REQUIRED — SS-23 · Alerts & Bots ⋮ menu showing Multi-Factor Alert]** · **[SS-24 · Alert settings: ① Chart Type ② Alert Name ③ Your Note ④ Expiration ⑤ Use Extended Hours unticked]** · **[SS-25 · Six LONG conditions under "All of the following", numbered 1–6]**
:::

## "RB v1 – SHORT Setup"

Repeat with name `RB v1 – SHORT Setup` and conditions:

| # | TF | Condition |
|---|---|---|
| 1 | 5 min | Close **is below** VWAP (14, 0, HLC3) |
| 2 | 5 min | EMA (9) **is below** EMA (20) |
| 3 | 5 min | RSI (14) **is below** 45 |
| 4 | 5 min | Relative Volume (20) **is above** 1.5 *(not inverted)* |
| 5 | 5 min | Close **is below** Open |
| 6 | 15 min | Close **is below** EMA (20) |

**Tip:** save the condition group as a template (**script actions → Save as template**) [TS], so that next time you can **Load From Template** instead of rebuilding. Capture SS-26.

## Expiration and repeat behaviour

| Setting | Recommendation [REC] | Why |
|---|---|---|
| Time expiration | **End of today** (1 calendar day) | Candidate lists are rebuilt daily |
| Number of triggers | **Multiple** (e.g., up to 5) rather than once | A stock can produce several valid setups in a day; "once" may fire at 9:35 noise and then go silent |
| Session | Regular only (Use Extended Hours unticked) | v1 rule |

::: {.warn custom-style="Box Warn"}
**VERIFY — trigger-count and repeat options**

TrendSpider documents that Expiration controls both duration and number of triggers, but the reviewed pages did not list the exact choices (e.g., "once", "N times", "every time"). Record your UI's options in SS-24.
:::

## Active alerts, capacity and Sidekick

* Created alerts appear in the alerts list and on the chart. Triggers and expirations appear in the **Notifications** widget [TS].
* **Capacity depends on plan.** The pricing page checked on 2026-10-28 listed alert limits of **10 / 50 / 100 / 400** for the Standard / Premium / Enhanced / Advanced plans. 10 LONG + 10 SHORT candidates = **20 alerts**, which already exceeds the smallest tier. **VERIFY your plan's limit** in your account.
* **Alerts attach to symbols.** "Create Alert" applies to the ticker currently open [TS]. To cover a list, create them one by one, or ask Sidekick (≤ 20 per message) to create them across a watchlist, using the two-step preview → create prompt from Chapter 27.

# Notifications

::: {.ts custom-style="Box TrendSpider"}
**TRENDSPIDER STEP — Account & Settings → Notifications [TS]**

1. Click your **profile icon** (top right) → **Account & Settings**.
2. In the **Notifications** panel, enter a **phone number** for SMS and/or an **email address**.
3. Optional: a **Webhook URL** (alerts sent as HTTP POST; times out after 5 s). **Not used in v1.**
4. Optional: a **do-not-disturb** time range (affects SMS and email only, not webhooks) and a checkbox to **turn off alerts on weekends**.
5. Click **Save**.
:::

| Channel | Officially documented? | v1 role [REC] |
|---|---|---|
| **Mobile push** (TrendSpider mobile companion app, iOS/Android) | The app has an Alerts tab and push notifications that open the alert's chart (2021 release notes) [TS]. **VERIFY current settings.** | **Primary** |
| **SMS** | Yes [TS] | **Backup** |
| **Email** | Yes [TS] | **Audit trail / history** |
| **Webhook** | Yes [TS] | **Not used in v1** (automation) |
| **Notifications widget** | Yes; shows triggers and errors in Eastern time [TS] | On-screen during the session |

::: {.rec custom-style="Box Recommendation"}
**RECOMMENDATION — Test notifications before your first session**

TrendSpider's notification page does not document a "send test" button. To test: create a throwaway Multi-Factor Alert on a liquid stock with a condition that will be true at the next 5m close (e.g., 5m Close > 1). Confirm that push, SMS and email all arrive, note the delay in seconds, and then delete the alert. Do it during market hours: if the alert is not set to use extended hours, it is checked during the regular session.
:::

::: {.shot custom-style="Box Screenshot"}
**[SCREENSHOT REQUIRED — SS-27 · Notifications widget with a triggered alert]** · **[SS-28 · Account & Settings → Notifications panel: ① phone ② email ③ webhook URL ④ do-not-disturb ⑤ weekends ⑥ Save]** · **[SS-29 · Mobile app push notification and Alerts tab]**
:::

# The Position Tool

## What it is

A **drawing tool** that marks an entry, a stop and a target on the chart as shaded risk/reward zones. You use it to *see* whether a trade makes sense before placing it.

::: {.warn custom-style="Box Warn"}
**VERIFY — limited official documentation**

TrendSpider's official source located for the Position Tool is an older blog release note. It states the tool is in the **left drawing toolbar** (second from the bottom at that time), hotkey **ALT+P**; right-click → properties to edit colours, labels and **enter exact levels**; and right-click to **add an alert** to any of its levels. Whether it currently displays share quantity or an R:R ratio was **not** confirmed. Capture SS-30/31 and update this section.
:::

## How to use it before a paper trade

1. After the alert, identify the signal candle.
2. Select the Position Tool (ALT+P, or from the left toolbar) and draw it from the entry level.
3. Right-click → properties → type exact levels:
   * Copy the three prices from the Trade Calculator (Chapter 38).
   * LONG: Entry E = signal high + buffer; Stop = E − R with R = MAX(E − signal low, 1 × ATR); Target = E + 2R.
   * SHORT: Entry E = signal low − buffer; Stop = E + R with R = MAX(signal high − E, 1 × ATR); Target = E − 2R.
4. Look at the chart: is there resistance (LONG) or support (SHORT) **inside** the green zone? If yes → Do-Not-Take item 5.
5. Optional: add alerts on the stop and target levels as a back-up reminder.
6. Use the **Share Chart Tool** to capture this "before" screenshot for your journal.

::: {.shot custom-style="Box Screenshot"}
**[SCREENSHOT REQUIRED — SS-30 · Position Tool drawn on a 5m chart with entry/stop/target]** · **[SS-31 · Position Tool properties dialog with exact levels]**
:::

# Strategy Tester — Backtesting v1

## What the Strategy Tester can and cannot do [TS]

| Feature | Supported? |
|---|---|
| Access | **Strategy Tester** button, bottom-left; opens below the chart; **Maximize** toggle top-right |
| Strategy settings | **Name**, **Timeframe** (**only one** per strategy), **Depth** (candles or date range, limited by plan), **Settings**: chart type, extended hours on/off, **direction (long or short)**, trade cost (%) |
| Entry | **Script** (same visual editor as alerts/scanner) or **List of Signals**; AI button available |
| Exits | **Script**, **Take Profit**, **Stop Loss**, **Trailing Stop**, **Entry Invalidated**, **# Candles Passed**, **List of signals**; stop/target in **Price Units** or ATR multiples (e.g., **xATR(7)**); option for exits to fire **After candle closes** |
| Partial exits / scaling in | **No.** Any exit closes 100%; no consecutive entries |
| Long + short in one strategy | **No.** Build separate strategies |
| Multiple timeframes | **Not with traditional indicators** (FAQ). Approximate with custom indicators |
| Export | Arrow button → **Download Test Results** (CSV/TSV) |
| Run / Save | **Run**; **Save** after every change |
| Backtest depth by plan (pricing page) | Min backtest timeframe and depth vary by plan, e.g., 5 min / 10K candles on Premium |

## The closest possible v1 backtest

**Strategy "RB v1 LONG – approx"**: Timeframe **5 min**, Settings: Ext. Hours **off**, Direction **Long**, Trade cost e.g. **0.02%** (a slippage/fee allowance [REC]).

**Entry (Script, All of):**

| v1 condition | Strategy Tester version | Exact? |
|---|---|---|
| Close > VWAP | Close > VWAP(14, 0, HLC3) | ✓ |
| EMA9 > EMA20 | EMA(9) > EMA(20) | ✓ |
| RSI14 > 55 | RSI(14) > 55 | ✓ |
| RVOL20 > 1.5 | Relative Volume(20) > 1.5 | ✓ |
| Close > Open | Close > Open | ✓ |
| **15m Close > EMA20** | **Approximation:** 5m Close > EMA(**60**) on the 5m chart (≈ 20 × 15-minute bars of time) | ✗ approximation |
| Scanner filters (S&P 500, price, daily +1%, Daily Vol MA) | Run the test per symbol on a list of liquid S&P 500 names; the daily +1% filter **cannot** be reproduced on a single 5m timeframe | ✗ |
| Entry on **break of signal high** within 10 minutes (2 candles), only 09:45–15:30 ET | Tester enters on the signal; it cannot express "next candle trades above this candle's high" without custom scripting. Restrict the session window if the tester offers it (VERIFY) | ✗ |

**Exits:**

| v1 exit | Strategy Tester version | Exact? |
|---|---|---|
| A: stop = E − MAX(E − signal low, 1 × ATR) | **Stop Loss** = 1 × ATR is the v1.1 *minimum*, so it matches whenever ATR controls; when structure is wider, the tester's stop is too tight | ✗ approximation |
| B: 2R | **Take Profit** = 2 × the stop distance (e.g., Stop 1 xATR, Take Profit 2 xATR) | ≈ (R defined by ATR, not candle) |
| C: trend failure | **Script exit:** Close < VWAP **OR** EMA(9) crossed below EMA(20), **After candle closes** ✓ | ✓ |
| D: time stop | **# Candles Passed** = 6 (exits regardless of +0.5R; the tester cannot condition on MFE) | ✗ approximation |

Build **"RB v1 SHORT – approx"** separately with Direction **Short** and all conditions mirrored.

::: {.warn custom-style="Box Warn"}
**WHAT THE BACKTEST CANNOT TELL YOU**

Because the 15m filter, the daily filter, the breakout entry and the candle-based stop are approximated, the backtest measures a *cousin* of v1, not v1 itself. Use it to answer directional questions ("does the trend-failure exit help?", "is a 2R target better than 1.5R?"), **not** to predict v1's P/L. Your paper-trading journal is the primary evidence.
:::

## Interpreting results

| Metric | Question it answers | Caution |
|---|---|---|
| Number of trades | Is the sample large enough? | < 100 trades = little statistical meaning |
| Win rate | How often it wins | Meaningless without average win/loss |
| Average win/loss, profit factor | Is the payoff sufficient? | Chapter 40 |
| Max drawdown | Worst peak-to-trough | Will you tolerate it? |
| Equity curve vs Buy & Hold (grey) | Smooth vs lumpy | One big winner can hide many losers |
| Price Behavior Explorer | Price change vs candles since entry | Useful for the time-stop question |

## Avoiding overfitting

* Decide the parameters **before** testing; change **one** thing per test.
* Test on one period (e.g., Jan–Jun), then confirm on a **different** period (Jul–Oct) without changing anything.
* Prefer round, simple values (RSI 55, not 56.3).
* If small parameter changes swing results wildly, the edge is not robust.

::: {.shot custom-style="Box Screenshot"}
**[SCREENSHOT REQUIRED — SS-32 · Strategy Tester settings: ① Name ② Timeframe ③ Depth ④ Settings (direction, ext. hours, trade cost) ⑤ Entry script ⑥ Exit conditions]** · **[SS-33 · Results with ① equity curve ② tabular metrics ③ Download Test Results]**
:::
