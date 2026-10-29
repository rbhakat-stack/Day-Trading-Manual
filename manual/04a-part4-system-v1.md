# PART IV — MY DAY TRADING SYSTEM v1 (LEVEL 4) {.unnumbered .part}

# System Overview and Universe

::: {.rule custom-style="Box Rule"}
**RULE VERSION — RB v1.1 (2026-10-29)**

Part IV documents **RB v1.1**, the rules implemented in the RB v1 Trade Calculator and Opportunity Ranker (Chapter 38). v1.1 changed the stop (minimum 1 × ATR), the breakout buffer (0.02% of price, minimum $0.01), the position cap ($20,000 per ticker) and turned the time window, the candle colour, the 15-minute confirmation, chasing, staleness and duplicate positions into **hard rules**. Every change is listed in the Change Log (Appendix E). "v1" in this manual means the current v1.x rules.
:::

## The v1 system on one page

| Stage | LONG | SHORT | Tool |
|---|---|---|---|
| Universe | S&P 500, $10–$500, Daily Volume MA20 > 1M | same | Scanner |
| Candidate scan | Bullish momentum scanner | Bearish momentum scanner | TrendSpider Market Scanner |
| Rank the scan | RVOL, VWAP distance, EMA separation, RSI 55–70, daily move, 15m, extension | mirror (RSI 30–45) | Your judgement / Sidekick |
| Candidate list | Static LONG list | Static SHORT list | Watchlists |
| Setup alert | RB v1 – LONG Setup (6 AND conditions) | RB v1 – SHORT Setup | Multi-Factor Alerts |
| Hard rules | Green candle (C > O) · 09:45 ≤ time < 15:30 ET · last completed 15m Close > EMA20 · not stale · not chased · no position in the ticker | Red candle (C < O) · same window · 15m Close < EMA20 · same | Trade Calculator |
| Inspect | Do-Not-Take list (judgement items) | same | You |
| Entry (E) | Signal-candle **high** + buffer, buffer = MAX($0.01, 0.02% × High) | Signal-candle **low** − buffer, buffer = MAX($0.01, 0.02% × Low) | Trade Calculator |
| Risk (R) | **MAX(E − Low, 1 × ATR)** | **MAX(High − E, 1 × ATR)** | Trade Calculator |
| Stop | **E − R** (= signal low unless ATR controls) | **E + R** | Trade Calculator |
| Size | MIN(floor(0.25% equity ÷ R), floor($20,000 ÷ E)) | same | Trade Calculator |
| Target | **E + 2R** | **E − 2R** | Trade Calculator |
| Capital | Opportunity score ≥ 85 and capital allocated, best score first | same | Opportunity Ranker |
| Exits | A stop · B 2R · C trend failure · D time stop | same | You + broker |
| Review | Journal every trade | same | Spreadsheet |

## Universe

::: {.rule custom-style="Box Rule"}
**MY v1 RULE — Universe**

* **Primary universe:** S&P 500 constituents.
* **Price:** $10–$500 (on the 5-minute close).
* **Liquidity:** Daily Volume 20-period MA > 1,000,000 shares.
* **Session:** Regular session (09:30–16:00 ET). Extended hours are not traded.
* **New-entry window (hard rule, v1.1):** **09:45 to before 15:30 ET.** Before 09:45 = TOO EARLY; 15:30 or later = NEW ENTRY WINDOW CLOSED; 16:00 or later (or before 09:30) = AFTER (BEFORE) REGULAR SESSION. Outside the window the setup is **NOT ELIGIBLE**, whatever it looks like.
:::

| Filter | What it removes | Why |
|---|---|---|
| S&P 500 | Small caps, illiquid names, most "meme" stocks | Liquidity, tight spreads, easier to borrow for shorts, fewer halts. |
| ≥ $10 | Low-priced stocks | On low-priced stocks a one-cent tick is a large *percentage* of price, and spreads are relatively wider. (Few S&P 500 names are below $10.) |
| ≤ $500 | Very high-priced stocks | At 0.25% risk ($250), a $900 stock with a $4 stop yields only 62 shares. That works mathematically, but sizing becomes coarse and 2R targets are large in dollars. |
| Volume MA20 > 1M | Thinly traded names | Fills close to plan, low slippage. |
| Regular session | Pre/post-market | Thin liquidity, wide spreads, limit-only order rules, unreliable indicators. |

# The Bullish Candidate Scanner

**Scanner name:** `RB v1 – Regular-Session Bullish Momentum`
**Search in:** S&P 500 · **Logic:** ALL of the following · **Current Candle:** ON · **Ext. Hours:** OFF

| # | Condition (as built) | Timeframe | What it contributes | Overlaps with |
|---|---|---|---|---|
| 1 | Close > 10 (constant) | 5m | Price floor | — |
| 2 | Close < 500 (constant) | 5m | Price ceiling | — |
| 3 | Volume MA(20) > 1,000,000 | **Daily** | Liquidity | — |
| 4 | Relative Volume (20) > 2.0 | 5m | The stock is **in play** right now: twice its normal activity | Partly with #5 (moves often need volume) |
| 5 | Close is above Close 1 candle ago **by at least 1%** | **Daily** | The stock is **up ≥ 1% on the day**, so it has daily-level directional bias | #6, #8 (up days tend to be above VWAP and higher RSI) |
| 6 | Close > VWAP | 5m | Intraday buyers in control | #7, #8 |
| 7 | EMA(9) > EMA(20) | 5m | Short-term trend up | #6, #8 |
| 8 | RSI(14) > 55 | 5m | Upside momentum | #6, #7 |
| 9 | Close > EMA(20) | **15m** | Higher-timeframe trend up | #7 |

### Understanding the overlap

Conditions 6, 7 and 8 are **highly correlated**. In a steady uptrend, all three are usually true together. That is fine: overlapping conditions make the scan *stricter about the same idea* (an intraday uptrend) rather than adding new information. The genuinely *independent* information comes from:

* **#3 Liquidity** (can I trade it efficiently?)
* **#4 RVOL** (is anyone actually participating?)
* **#5 Daily change** (is there a daily directional story?)
* **#9 15m trend** (does the bigger picture agree?)

::: {.why custom-style="Box Why"}
**WHY IT MATTERS — three timeframes is the scanner limit**

This scan uses exactly three timeframes: 5m, 15m and Daily. TrendSpider's scanner supports **up to three timeframes at once [TS]**. You cannot add, for example, a 1-hour condition without removing one of these.
:::

::: {.warn custom-style="Box Warn"}
**VERIFY — the exact "by at least X%" wording**

Your build uses a Daily condition of the form "Close … above … Close 1 candle ago … by at least 1%". TrendSpider documents candle offsets in its scripting help, but the official pages reviewed did not show the exact "by at least" control. Document the precise wording you see in the editor in Appendix C (SS-14) so it can be rebuilt identically.
:::

**With Current Candle ON**, condition #5 compares *today's developing daily candle* (i.e., the current price) to *yesterday's close*. That is exactly "current price is ≥ 1% above previous close".

# The Bearish Candidate Scanner

**Scanner name:** `RB v1 – Regular-Session Bearish Momentum`
**Search in:** S&P 500 · **Logic:** ALL · **Current Candle:** ON · **Ext. Hours:** OFF

| # | Condition | TF | Contribution | LONG counterpart |
|---|---|---|---|---|
| 1 | Close > 10 | 5m | Price floor (*not* inverted: still a price band) | same |
| 2 | Close < 500 | 5m | Price ceiling (not inverted) | same |
| 3 | Volume MA(20) > 1,000,000 | D | Liquidity (not inverted) | same |
| 4 | Relative Volume (20) > 2.0 | 5m | In play (*not* inverted: high volume matters both ways) | same |
| 5 | Close is **below** Close 1 candle ago **by at least 1%** | D | Down ≥ 1% on the day | inverted |
| 6 | Close **<** VWAP | 5m | Sellers in control intraday | inverted |
| 7 | EMA(9) **<** EMA(20) | 5m | Short-term trend down | inverted |
| 8 | RSI(14) **<** 45 | 5m | Downside momentum | inverted (55 → 45, symmetric around 50) |
| 9 | Close **<** EMA(20) | 15m | Higher-timeframe trend down | inverted |

::: {.mistake custom-style="Box Mistake"}
**COMMON MISTAKE — inverting everything**

Only *directional* conditions are mirrored. Price band, liquidity and RVOL stay **the same** for shorts. An "RVOL < 2" bearish scan would find *quiet* stocks, which is the opposite of what you want.
:::

# The LONG Alert — "RB v1 – LONG Setup"

::: {.rule custom-style="Box Rule"}
**MY v1 RULE — LONG alert (ALL conditions, AND logic)**

1. 5m Close > VWAP
2. 5m EMA9 > EMA20
3. 5m RSI14 > 55
4. 5m RVOL20 > 1.5
5. 5m Close > Open (the signal candle is green)
6. 15m Close > EMA20
:::

| # | Condition | Plain English |
|---|---|---|
| 1 | Close > VWAP | The signal candle closed above the day's average cost. |
| 2 | EMA9 > EMA20 | Short-term trend is up. |
| 3 | RSI14 > 55 | Momentum is to the upside. |
| 4 | RVOL20 > 1.5 | This candle traded at least 1.5× recent average volume. |
| 5 | Close > Open | Buyers won *this specific* 5-minute period. |
| 6 | 15m Close > EMA20 | The bigger picture agrees. |

## The two alert conditions that are also hard rules (v1.1)

The alert already contains conditions 5 and 6, but an alert can fire on data that later changes (Chapter 9), and you type the numbers into the Trade Calculator yourself. In v1.1 the calculator therefore **re-checks both as hard rules**. Either failure = **NOT ELIGIBLE**, even though entry, stop, target and size can still be calculated.

::: {.rule custom-style="Box Rule"}
**MY v1.1 RULE — Candle direction and 15-minute confirmation are HARD rules**

* **Candle direction.** LONG requires signal-candle **Close > Open**; SHORT requires **Close < Open**. A doji (Close = Open) fails both. Calculator label: *NOT ELIGIBLE — LONG (SHORT) SIGNAL CANDLE INVALID*.
* **15-minute confirmation.** LONG requires the **last completed 15m Close > 15m EMA20**; SHORT requires **last completed 15m Close < 15m EMA20**. Equal fails. Label: *NOT ELIGIBLE — 15M TREND CONFIRMATION FAILED*.
:::

## The "last completed 15m candle" rule

::: {.rule custom-style="Box Rule"}
**MY v1.1 RULE — Which 15-minute candle to read**

Use the last **fully completed regular-session** 15-minute candle at the **alert time**. Never use the still-forming candle, a pre-/post-market candle, or a candle that completed *after* the alert. 15m candles start at 09:30, 09:45, 10:00 … 15:45; a candle is complete at its end time.
:::

| Alert time (ET) | Still forming (do NOT use) | Last completed 15m candle (use this one) |
|---|---|---|
| 10:07 | 10:00–10:15 | **09:45–10:00** |
| 10:18 | 10:15–10:30 | **10:00–10:15** |
| 14:52 | 14:45–15:00 | **14:30–14:45** |
| 15:29 | 15:15–15:30 | **15:00–15:15** |
| 09:40 | 09:30–09:45 | none yet. The alert is too early anyway (window opens 09:45) |

Read that candle's **Close** and its **EMA20** value from the 15m chart (hover over the candle) and type both into the calculator. The calculator shows which candle it expects next to the 15m inputs.

## AND vs OR logic

| Logic | TrendSpider label [TS] | Fires when | Example with 6 conditions |
|---|---|---|---|
| **AND** | "All of the following" | *Every* condition is true | All 6 true → fires; 5 of 6 → **no** alert |
| **OR** | "Any of the following" | *At least one* is true | Any single condition true → fires (far too often) |
| NOT | "None of the following" | None are true | Used to exclude |

v1 uses **AND ("All of the following")** exclusively.

## Why the alert uses RVOL > 1.5 while the scanner uses RVOL > 2.0

1. **Different jobs.** The scanner asks *"which stocks are in play today?"*. A high bar (2.0) keeps the list short. The alert asks *"is this particular candle supported by volume?"*. Once a stock is already in play, a healthy continuation candle does not need double volume, and a pullback-resumption candle often has *less* volume than the initial surge.
2. **Avoiding missed setups.** Requiring 2.0 on the trigger candle would miss many valid continuation entries.
3. **Partial vs complete candle.** With Current Candle ON, the scanner's RVOL may be computed on a *partial* candle, which understates volume early in the bar. The alert evaluates a *completed* 5m candle **[TS: alerts are checked when the smallest-timeframe candle closes]**.

## What the alert means — and what it does not mean

::: {.rule custom-style="Box Rule"}
**ALERT ≠ TRADE**

The alert means: **"Inspect this stock now."** It does **not** mean "buy". After it fires you still must: verify the timestamp, identify the signal candle, run the alert through the Trade Calculator (hard rules, entry, stop, size, target), check the Do-Not-Take list, send it to the Opportunity Ranker, and wait for the price to **break the entry trigger**.
:::

# The SHORT Alert — "RB v1 – SHORT Setup"

::: {.rule custom-style="Box Rule"}
**MY v1 RULE — SHORT alert (ALL conditions)**

1. 5m Close < VWAP
2. 5m EMA9 < EMA20
3. 5m RSI14 < 45
4. 5m RVOL20 > 1.5 *(not inverted)*
5. 5m Close < Open (the signal candle is red)
6. 15m Close < EMA20
:::

| # | Plain English |
|---|---|
| 1 | The signal candle closed below the day's average cost: sellers in control. |
| 2 | Short-term trend is down. |
| 3 | Momentum is to the downside. |
| 4 | Volume confirms participation (high volume matters in both directions). |
| 5 | Sellers won this 5-minute period. |
| 6 | The higher timeframe trend is down. |

Conditions 5 and 6 are **hard rules** in v1.1 for SHORTs too: the signal candle must close **below** its open, and the **last completed** 15m Close must be **below** the 15m EMA20 (Chapter 13 explains which 15m candle to read).

# Candidate Ranking

## Why the scanner returns too many stocks

On a strong trend day (e.g., the S&P 500 up 1.5%), dozens of stocks can pass the bullish scan at once, because the market lifts everything. You cannot watch 40 charts, and alerts are capped by plan (Chapter 28). Ranking narrows the list to the **best 5–15**.

There are two different ranking steps in v1.1:

| Step | When | Question | Tool |
|---|---|---|---|
| **Scan ranking** (this chapter) | ~09:40, 11:00, 13:30 | Which scanner results go on today's alert lists? | Your judgement with the factor table below |
| **Opportunity ranking** (Chapter 38) | Each time an alert passes the calculator's hard rules | Which eligible setup gets my limited capital? | Opportunity Ranker: 100-point score, threshold 85 |

## Ranking factors

| Factor | How to measure | LONG preferred | SHORT preferred | Red flag (either side) |
|---|---|---|---|---|
| **RVOL** | 5m RVOL20 | 2–6 | 2–6 | > 10 (news spike, climax) |
| **Distance from VWAP** | (Close − VWAP) ÷ 5m ATR | +0.2 to +1.5 ATR | −0.2 to −1.5 ATR | > 2.5 ATR away |
| **EMA separation** | (EMA9 − EMA20) ÷ Price | clearly positive (≈ 0.1–0.6%) | clearly negative | ≈ 0 (chop) or very wide (stretched) |
| **RSI14 (5m)** | Indicator value | **55–70** | **30–45** | > 78 / < 22 |
| **Daily % move** | (Price − Prev close) ÷ Prev close | +1% to +4% | −1% to −4% | > ±7–8% (exhaustion or news) |
| **15m relationship** | Close vs 15m EMA20 and its slope | above, EMA rising | below, EMA falling | flat 15m EMA |
| **Overextension** | Count of consecutive same-colour 5m candles; distance from EMA20 | ≤ 4–5 in a row | ≤ 4–5 in a row | parabolic, vertical moves |

::: {.rule custom-style="Box Rule"}
**MY v1.1 RULE — Scoring happens in the Opportunity Ranker**

The earlier 0–2 rubric (maximum 14) is **replaced** by the Opportunity Ranker's 100-point score (Chapter 38), which uses the same ideas (RVOL, RSI zone, VWAP/EMA distance in ATR, 15m trend, candle quality, time of day) plus portfolio fit. Use the factor table above only to choose which scanner results go on your alert lists. Record the Opportunity score and tier in the journal.
:::

## Why more momentum is not always better

| Concept | Plain English | Why it hurts |
|---|---|---|
| **FOMO** (fear of missing out) | Buying because it's running and you feel left behind | You buy late, near the top, with a wide stop. |
| **Chasing** | Entering far beyond the planned trigger | Risk/share is larger than planned, or the stop is no longer logical. |
| **Overextension** | Price far from its averages (VWAP, EMA20) | Little room for 2R before a snap-back. |
| **Mean reversion** | Stretched prices tend to drift back toward an average | The "rubber band" snaps back to VWAP. |
| **Snap-back risk** | A sharp counter-move after an extended run | Hits your stop before your target. |

**Numerical example.** Stock A: price $101.20, VWAP $100.50, 5m ATR $0.40 → 1.75 ATR above VWAP. Stock B: price $103.60, VWAP $100.50, ATR $0.40 → 7.75 ATR above VWAP. B *looks* stronger, but a pull back merely halfway to VWAP is −$1.55, many times a typical stop. **A is the better candidate.**

# Entry Rules

## LONG entry

::: {.rule custom-style="Box Rule"}
**MY v1 RULE — LONG entry**

1. Alert fires. Identify the **signal candle**: the completed 5-minute candle that satisfied the alert. It must be **green** (Close > Open).
2. **Do not automatically buy.**
3. Entry trigger **E = signal-candle High + B**, where the buffer **B = MAX($0.01, 0.02% × High)**, rounded to the nearest cent.
4. **Timing:** the alert time (and the moment you would enter) must be inside the **09:45 to before 15:30 ET** window. If the trigger has not traded within **10 minutes** of the alert (two 5-minute candles), the setup is **STALE**. Do not chase.

*These timing rules are your trading rules, not TrendSpider limitations.*
:::

**What "break above the high + buffer" means.** The signal candle's high is the highest price buyers reached during that candle. A trade *above* that high shows buyers are still pushing beyond the signal: that is your **confirmation**. The buffer avoids entering on a single print that merely *touches* the high.

## The breakout buffer (v1.1)

::: {.rule custom-style="Box Rule"}
**MY v1.1 RULE — Buffer**

* **LONG:** B = MAX($0.01, 0.0002 × signal-candle **High**)
* **SHORT:** B = MAX($0.01, 0.0002 × signal-candle **Low**)
* Round B to the nearest cent (never below $0.01). 0.0002 = **0.02%** = 2 cents per $100 of price.
:::

| Signal price | 0.02% × price | Buffer B | Entry E |
|---|---|---|---|
| LONG High $45.80 | $0.00916 | **$0.01** (minimum) | $45.81 |
| LONG High $100.20 | $0.02004 | **$0.02** | $100.22 |
| LONG High $255.60 (IBM) | $0.05112 | **$0.05** | $255.65 |
| SHORT Low $87.40 | $0.01748 | **$0.02** | $87.38 |
| SHORT Low $212.57 (NVDA) | $0.042514 | **$0.04** | $212.53 |
| LONG High $484.00 | $0.0968 | **$0.10** | $484.10 |

Below $50 the $0.01 minimum always applies. The buffer replaces the v1.0 price-band table.

## SHORT entry

::: {.rule custom-style="Box Rule"}
**MY v1 RULE — SHORT entry**

The signal candle must be **red** (Close < Open). Entry trigger **E = signal-candle Low − B**, with B = MAX($0.01, 0.02% × Low). Same window (09:45 to before 15:30 ET) and same 10-minute stale limit. Otherwise skip.
:::

**Example:** Signal-candle Low = $87.40 → B = $0.02 → entry trigger **$87.38**.

## Hard entry rules (v1.1)

Any one of these makes the setup **NOT ELIGIBLE**. The Trade Calculator checks all of them, lists *every* failure, greys out the order ticket (INVALID — DO NOT PLACE) and disables Copy, Save and Send to Ranker. The numbers stay visible so you can learn from them, but they are not an order.

| Hard rule | LONG | SHORT | Calculator label |
|---|---|---|---|
| **One position or order per ticker** | No open position or pending order in the ticker. An opposite-direction alert never reverses a position | same | DO NOT ADD — POSITION/ORDER ALREADY EXISTS · MANAGE EXISTING TRADE FIRST |
| **Candle direction** | Close > Open | Close < Open | SIGNAL CANDLE INVALID |
| **Regular session** | Alert at or after 09:30 and before 16:00 ET | same | BEFORE / AFTER REGULAR SESSION |
| **Entry window** | 09:45 ≤ time < 15:30 ET, checked at the alert time **and** at alert time + minutes since alert | same | TOO EARLY · NEW ENTRY WINDOW CLOSED |
| **15m confirmation** | Last completed 15m Close > 15m EMA20 | Close < EMA20 | 15M TREND CONFIRMATION FAILED |
| **Trade structure** | Stop < Entry < Target, and at least 1 share | Target < Entry < Stop | INVALID TRADE STRUCTURE · POSITION SIZE IS 0 SHARES |
| **Setup failed** | Current price at or **below** the planned stop | at or **above** the stop | SETUP FAILED |
| **Stale** | Trigger not crossed and more than **10 minutes** since the alert | same | STALE SETUP |
| **Chased** | Trigger crossed and price more than **0.25 × ATR** beyond E | same, below E | DO NOT CHASE |

A minute-resolution time of **15:30** counts as closed (15:30 can mean 15:30:59). Example: an alert at 15:24 with 7 minutes elapsed is evaluated at 15:31 → NEW ENTRY WINDOW CLOSED.

## Trigger states when every hard rule passes

| Price vs trigger | Calculator shows | What you do |
|---|---|---|
| LONG price < E (SHORT price > E) | **BUY STOP** / **SELL STOP** at E | Place the stop entry (or wait and use Process A, Chapter 35). Distance to trigger is information only |
| Crossed by **≤ 0.25 ATR** | **MARKET — LATE ENTRY REVIEW** | Not a trade yet. Only if you tick *Use current price as market entry* does the calculator **recalculate everything** (R, stop, target, shares) from the current price |
| Crossed by **> 0.25 ATR** | **NOT ELIGIBLE — DO NOT CHASE** | Skip. Never convert it into a market, limit or pullback order |

**Worked example — IBM LONG late entry.** Signal candle O 255.30 · H 255.60 · L 255.24 · C 255.55, ATR $0.37 → E = $255.65. Chase limit = 0.25 × 0.37 = $0.0925.

* Price $255.50 → below E → **BUY STOP @ 255.65**, stop 255.24, target 256.47, 78 shares.
* Price $255.70 → $0.05 past E = 0.14 ATR → **LATE ENTRY REVIEW**. Recalculated at 255.70: structural risk 255.70 − 255.24 = 0.46 > ATR 0.37 → R = $0.46, stop **$255.24**, target **$256.62**, 78 shares, planned loss $35.88.
* Price $255.75 → $0.10 past E = 0.27 ATR → **DO NOT CHASE**.
* Price $255.11 → below the planned stop 255.24 → **SETUP FAILED**.
* Price $255.50 but 11 minutes since the alert and the trigger never traded → **STALE SETUP**.

## Why require confirmation?

The alert fires on a candle that *already closed*. Many signal candles are the *end* of a burst, not the start. Requiring the next candle(s) to trade beyond the signal extreme filters out setups where momentum immediately stalls. The cost is a slightly worse entry price. The benefit is avoiding many failed setups. Whether that trade-off is profitable for *your* system is a question for your journal (Chapter 40).

## Situations and what to do

| Situation | v1 action | Reason |
|---|---|---|
| **Price already ran too far** (beyond the trigger by > 0.25 ATR) | **Skip: hard rule (DO NOT CHASE)** | Your risk/share is now bigger than planned and the 2R target is further away. |
| **Price just past the trigger** (≤ 0.25 ATR) | Late-entry review: market entry only after a full recalculation | The stop, target and size change with the entry price. |
| **More than 10 minutes since the alert, trigger not hit** | **Skip: hard rule (STALE)** | Momentum setups are perishable. |
| **Price never breaks the candle** | Cancel any pending order 10 minutes after the alert; **no trade** | No confirmation. |
| **Price traded through the planned stop before entry** | **Skip: hard rule (SETUP FAILED)** | The setup has already failed. |
| **Alert before 09:45 or at/after 15:30 ET** | **Skip: hard rule (entry window)** | Opening volatility; too little time to reach 2R before the close. |
| **Candle is enormous** (range > ~2× 5m ATR) | **Skip**, or treat as a v2 discretionary case | The stop at the other end is too wide, and the candle may be exhaustion. |
| **Spread is wide** (> ~10% of risk/share) | **Skip** | Spread eats your edge. |
| **Stock gaps violently** (e.g., a 1-minute spike through trigger on news) | **Skip** | Fill quality is unknown, and news-driven moves don't respect technicals. |
| **Major resistance just above** (LONG) / **support just below** (SHORT) within 2R | **Skip** or require reward ≥ 2R *before* the level | No room to reach target. |

# Stop-Loss

## Stop-loss methods compared

| Method | LONG stop | SHORT stop | Pros | Cons |
|---|---|---|---|---|
| **Signal-candle extreme with a 1 ATR minimum (v1.1)** | E − MAX(E − Low, 1 × ATR) | E + MAX(High − E, 1 × ATR) | Structural, and never tighter than normal 5m noise | Large candles still give wide stops (smaller size) |
| Signal-candle extreme (v1.0) | Signal-candle **low** | Signal-candle **high** | Objective, structural: if price takes out the whole signal candle, the setup failed | Tiny candles give stops inside the noise |
| VWAP | Below VWAP | Above VWAP | Ties to the thesis "price above VWAP" | May be far away; VWAP moves |
| ATR | Entry − k × ATR | Entry + k × ATR | Volatility-consistent | Not tied to structure |
| Support/Resistance | Below support | Above resistance | Uses market structure | Subjective; obvious levels get "run" |
| Percentage | Entry × (1 − p%) | Entry × (1 + p%) | Simple | Ignores volatility and structure |

## The v1.1 stop: structure, with a 1 ATR minimum

::: {.rule custom-style="Box Rule"}
**MY v1.1 RULE — Risk per share (R), stop and target**

| | LONG | SHORT |
|---|---|---|
| Structural risk (SR) | E − signal Low | signal High − E |
| ATR risk (AR) | 1.0 × ATR(14), 5-minute | same |
| **R** | **MAX(SR, AR)** | **MAX(SR, AR)** |
| **Stop** | **E − R** | **E + R** |
| **Target** | **E + 2R** | **E − 2R** |

* When ATR controls, R is **rounded up** to the next cent, so the stop is never closer than the rule. When structure controls, R is already whole cents and the stop is exactly the signal-candle low (high).
* If the resulting stop creates **unacceptable risk**, **skip the trade**. Never move the stop artificially closer to make the trade "fit".
:::

**Logic:** the signal candle is the evidence for your trade. If price trades back through the *entire* signal candle, the buying (or selling) pressure that created it has been fully reversed, and the setup is invalid. But a very small candle puts its low inside ordinary 5-minute noise, so v1.1 never uses a stop closer than one average 5-minute range (1 × ATR).

| Example | E | SR | 1 × ATR | R | Controls | Stop | Target |
|---|---|---|---|---|---|---|---|
| IBM LONG: H 255.60, L 255.24, ATR 0.37 | 255.65 | 0.41 | 0.37 | **0.41** | Structure | **255.24** (= low) | **256.47** |
| NVDA SHORT: H 212.97, L 212.57, ATR 0.333 | 212.53 | 0.44 | 0.333 | **0.44** | Structure | **212.97** (= high) | **211.65** |
| LONG: H 100.20, L 100.00, ATR 0.333 | 100.22 | 0.22 | 0.333 | **0.34** (0.333 rounded up) | ATR | **99.88** (below the low) | **100.90** |

**When this stop may be too wide:**

* The signal candle is very large (> ~2× ATR).
* The stock is high-priced and volatile.
* The resulting position, after the $20,000 cap, is so small that the trade is not meaningful.

**When it may be too tight:** in v1.1 it cannot be tighter than 1 × ATR. A tiny signal candle (e.g., an $0.08 range) now gets an ATR-based stop below its low, so the trade is sized on the wider, more realistic risk.

::: {.mistake custom-style="Box Mistake"}
**COMMON MISTAKE — squeezing the stop**

"The real stop is $1.20 away, so I'll use $0.50 to get a bigger position." This replaces a *logical* stop with an *arbitrary* one. Price will often hit the arbitrary stop and then go to your target. **If the logical stop is too far, the correct answer is a smaller position or no trade.**
:::
