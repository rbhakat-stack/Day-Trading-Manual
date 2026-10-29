# Document Control {.unnumbered}

| Item | Value |
|---|---|
| Title | Day Trading & TrendSpider Bible |
| Version | **1.1** |
| Created | 2026-10-28 |
| Last updated | 2026-10-29 (v1.1: rules aligned with the RB v1 Trade Calculator and Opportunity Ranker; see Appendix E) |
| Owner | Ranabir (rbhakat@gmail.com) |
| Strategy documented | **RB Day Trading System v1.1** (regular-session momentum, S&P 500 universe) |
| TrendSpider documentation checked | 2026-10-28 (help.trendspider.com Knowledge Base, trendspider.com pricing & product pages) |
| SignalStack documentation checked | 2026-10-28 (help.signalstack.com, signalstack.com/pricing) |
| Alpaca documentation checked | 2026-10-28 (docs.alpaca.markets: Paper Trading, Orders, User Protection, changelog) |
| Regulatory sources checked | 2026-10-28 (FINRA Rule 4210 amendments effective 2026-06-04; SEC Reg SHO Rule 201) |
| Screenshots | **None captured yet.** Every screenshot is a labelled placeholder (see Appendix C). All figures are schematic diagrams drawn from synthetic data, **not** product screenshots. |

::: {.warn custom-style="Box Warn"}
**IMPORTANT — WHAT THIS DOCUMENT IS AND IS NOT**

This manual is a personal educational reference and operating runbook. It documents *your own* chosen trading rules and explains how the software works. It is **not** personalised investment advice, and the author is not a licensed financial adviser. No setup, indicator or rule in this manual guarantees a profitable outcome. Paper-trading results do not predict live results. You are responsible for every trade you place.
:::

::: {.warn custom-style="Box Warn"}
**HOW TO READ "VERIFY" FLAGS**

Software changes. Wherever the official documentation did not confirm an exact menu name, field, default or behaviour, this manual says so with a **VERIFY** box instead of guessing. Before relying on any flagged item, check it in your own TrendSpider / SignalStack / Alpaca account and record what you find in the Change Log.
:::

# How to Use This Manual {.unnumbered}

## Who this is for {.unnumbered}

You are intelligent and analytical, but new to day trading and new to TrendSpider. This manual therefore **never assumes you know a term because it appeared earlier.** Key terms are re-explained where they matter, and every term is in the Glossary (Appendix A).

## The teaching pattern {.unnumbered}

Most concepts follow the same seven-step sequence:

| Step | Question it answers |
|---|---|
| 1. Plain English | What is it, in everyday words? |
| 2. Technical definition | What is it precisely (formula, rule)? |
| 3. Visual intuition | What does it look like on a chart? |
| 4. Numerical example | What do real numbers look like? |
| 5. How I use it | Where does it appear in my v1 system? |
| 6. Common mistake | What do beginners get wrong? |
| 7. When NOT to use it | When is it misleading or irrelevant? |

## Recommended learning sequence {.unnumbered}

| Level | Topic | Chapters | Goal before moving on |
|---|---|---|---|
| **Level 1** | Market basics | 1 | You can explain bid/ask/spread, long vs short, and each order type without notes. |
| **Level 2** | Candles | 2 | You can read OHLC from any candle and say what "1 candle ago" means on any timeframe. |
| **Level 3** | Indicators | 3–9 | You can explain VWAP, EMA9/20, RSI14, RVOL, ATR and why the 15-minute chart confirms the 5-minute chart. |
| **Level 4** | My strategy | 10–22 | You can recite the v1 scanner, alert, entry, stop, size, target and exit rules for LONG and SHORT. |
| **Level 5** | TrendSpider | 23–31 | You can build the chart, scanners, watchlists and alerts from scratch. |
| **Level 6** | Paper execution | 32–38 | You can run an alert through the Trade Calculator and Opportunity Ranker and place a correctly sized paper bracket-style order in under 60 seconds. |
| **Level 7** | Performance evaluation | 39–41 | You keep a journal and can calculate expectancy, profit factor and drawdown. |

After Level 7, use Part VIII (FAQ, Troubleshooting, Cheat Sheets) as day-to-day reference, and Chapter 45 (*Am I Ready for Live Trading?*) as the gate before risking real money.

## Conventions and box types {.unnumbered}

::: {.def custom-style="Box Definition"}
**DEFINITION** — a term explained in plain English and then technically.
:::

::: {.why custom-style="Box Why"}
**WHY IT MATTERS** — the practical consequence for your P/L or risk.
:::

::: {.mistake custom-style="Box Mistake"}
**COMMON MISTAKE** — a typical beginner error and how to avoid it.
:::

::: {.rule custom-style="Box Rule"}
**MY v1 RULE** (or **MY v1.1 RULE**) — a rule *you* have chosen. These are documented exactly as you specified. They are trading decisions, not software features or universal truths.
:::

::: {.ts custom-style="Box TrendSpider"}
**TRENDSPIDER STEP** — an instruction inside TrendSpider (or SignalStack / Alpaca), tied to official documentation where possible.
:::

::: {.rec custom-style="Box Recommendation"}
**RECOMMENDATION** — the author's suggestion. Not part of v1 unless you adopt it and record the change in the Change Log.
:::

::: {.warn custom-style="Box Warn"}
**VERIFY** — something the official documentation did not confirm, or that may have changed.
:::

::: {.shot custom-style="Box Screenshot"}
**[SCREENSHOT REQUIRED — SS-00 · Example placeholder]** — describes exactly which screen to capture, what to crop and what to number. Replace the placeholder with your own capture; the full list is in Appendix C.
:::

## Source labels {.unnumbered}

Every factual claim falls into one of six categories. When it is not obvious from context, the text labels it:

| Label | Meaning |
|---|---|
| **[TS]** | TrendSpider officially documents this. |
| **[SS]** | SignalStack officially documents this. |
| **[ALP]** | Alpaca officially documents this. |
| **[REG]** | Regulation / exchange rule (SEC, FINRA, exchanges). |
| **[RULE]** | Your chosen v1 trading rule. |
| **[IND]** | General industry practice or standard indicator mathematics. |
| **[REC]** | The author's recommendation. |

## Number formatting {.unnumbered}

* Prices are in US dollars, rounded to cents ($100.25).
* "Shares" are always whole shares, **rounded down**.
* Times are US Eastern Time (ET). TrendSpider states that its notifications are delivered in Eastern time [TS].
* "5m" = 5-minute chart; "15m" = 15-minute chart; "D" = daily chart.

# The Five Distinctions This Manual Repeats {.unnumbered}

These five ideas prevent most beginner disasters. They appear again throughout the manual.

| # | Distinction | In one sentence |
|---|---|---|
| 1 | **Scanner ≠ Alert** | A scanner *finds candidates* across many symbols at the moment you run it; an alert *watches one symbol* and notifies you when a defined setup occurs. |
| 2 | **Alert ≠ Trade** | An alert means "go and inspect this chart". It never means "buy now". |
| 3 | **Setup ≠ Outcome** | A perfect-looking setup can still lose. You are trading probabilities, not certainties. |
| 4 | **Paper ≠ Live** | Paper fills are simulated: no market impact, no queue position, and different emotions. Paper results are an approximation. |
| 5 | **Risk management > Prediction** | You cannot control whether a trade wins. You can always control how much it can lose. |
