# PART VII — PERFORMANCE EVALUATION (LEVEL 7) {.unnumbered .part}

# Trade Journal

A trade not recorded is a trade you cannot learn from. The journal is your **primary evidence** for whether v1 works. The companion spreadsheet `journal/RB-v1-Trade-Journal.xlsx` implements this schema with formulas.

## Schema

Example: a MSFT LONG with signal candle H 412.30 / L 411.40 and ATR 0.85, sized by the RB v1.1 Trade Calculator.

| # | Field | Type / example | Notes |
|---|---|---|---|
| 1 | Trade ID | 2026-10-29-01 | Date + sequence |
| 2 | Date | 2026-10-29 | |
| 3 | Time (entry) | 10:17 | ET |
| 4 | Ticker | MSFT | |
| 5 | Direction | LONG / SHORT | |
| 6 | Alert time | 10:10 | Close of signal candle; must be 09:45 to before 15:30 |
| 7 | Exit time | 10:46 | |
| 8 | Signal candle high | 412.30 | |
| 9 | Signal candle low | 411.40 | |
| 10 | ATR(14), 5m | 0.85 | At the signal candle |
| 11 | Buffer | 0.08 | MAX(0.01, 0.02% × 412.30 = 0.08246), rounded |
| 12 | Planned entry (E) | 412.38 | formula |
| 13 | Actual entry (fill) | 412.41 | Slippage = 13 − 12 (LONG) |
| 14 | R (risk/share) | 0.98 | MAX(E − Low = 0.98, 1 × ATR = 0.85); formula |
| 15 | Stop | 411.40 | E − R; formula |
| 16 | Position size | 48 | MIN(floor(250 ÷ 0.98) = 255, floor(20,000 ÷ 412.38) = 48); formula |
| 17 | Planned dollar risk | 47.04 | 14 × 16 |
| 18 | Target (2R) | 414.34 | E + 2R; formula |
| 19 | Exit price | 413.10 | |
| 20 | Exit reason | A-Stop / B-Target / C-VWAP / C-EMA / D-Time / Manual-Other | |
| 21 | P/L $ | 33.12 | (Exit − Fill) × size, sign-adjusted |
| 22 | P/L % (of equity) | formula | P/L ÷ equity at entry |
| 23 | R result | +0.70 | P/L ÷ planned dollar risk |
| 24 | MFE (R) | +0.9 | Max favourable excursion, in R |
| 25 | MAE (R) | −0.3 | Max adverse excursion, in R |
| 26 | R at 30 min | +0.4 | For the time-stop study |
| 27 | Opportunity score / tier | 87 · HIGH PRIORITY | From the Opportunity Ranker (Chapter 38) |
| 28 | RVOL | 2.4 | At signal |
| 29 | RSI | 63 | At signal |
| 30 | VWAP relationship | +0.8 ATR | Distance in ATR |
| 31 | EMA alignment | 9>20, sep 0.15% | |
| 32 | 15m confirmation | Yes (09:45–10:00 candle) | Last completed 15m candle |
| 33 | Screenshot before | link/file | Share Chart Tool |
| 34 | Screenshot after | link/file | |
| 35 | Market regime | SPY above VWAP, trending up | |
| 36 | News catalyst? | Y/N + note | |
| 37 | Followed rules? | Y/N | Honest |
| 38 | Mistake? | none / chased / moved stop / oversized / early exit / … | Category list |
| 39 | Notes | free text | Emotions included |

The app's own **Journal** tab stores the same plan numbers automatically when you save an active trade, and its **Dashboard** and the ranker analytics summarise them. Keep one journal as your master record and back it up.

## What matters at 20, 50 and 100 trades

| Milestone | Purpose | Look at | Do NOT conclude |
|---|---|---|---|
| **20 trades** | **Workflow validation** | Rules followed %; time from alert to order; sizing errors; order/plumbing errors; slippage per trade | Whether the strategy "works" |
| **50 trades** | **Early signal** | Win rate, average win/loss in R, expectancy, exit-reason mix, R by direction (LONG vs SHORT), R by time of day | Final parameter changes |
| **100+ trades** | **More useful evidence** | Expectancy with confidence range, profit factor, max drawdown, longest losing streak, R by Opportunity score tier, time-stop study, Exit C study | That live results will match |

# Performance Analysis

## Core metrics

| Metric | Formula | Example (20 trades: 8 wins totalling +14R, 12 losses totalling −12.6R) |
|---|---|---|
| **Win rate** | Wins ÷ Trades | 8 ÷ 20 = **40%** |
| **Loss rate** | Losses ÷ Trades | **60%** |
| **Average winner** | Σ winning R ÷ Wins | 14 ÷ 8 = **+1.75R** |
| **Average loser** | Σ losing R ÷ Losses | −12.6 ÷ 12 = **−1.05R** |
| **Payoff ratio** | Avg winner ÷ \|Avg loser\| | 1.75 ÷ 1.05 = **1.67** |
| **Expectancy** | WinRate × AvgWin − LossRate × \|AvgLoss\| | 0.40 × 1.75 − 0.60 × 1.05 = 0.70 − 0.63 = **+0.07R** |
| **Total R** | Σ all R | 14 − 12.6 = **+1.4R** (= 20 × 0.07) |
| **Profit factor** | Gross profit ÷ Gross loss | 14 ÷ 12.6 = **1.11** |
| **Max drawdown** | Largest peak-to-trough fall of the equity curve | e.g., peak +3.2R → trough −1.8R = **5.0R** (≈ $1,250) |
| **Consecutive losses** | Longest losing streak | e.g., 6 |

*Profit factor > 1 = profitable before costs. Most robust intraday systems sit around 1.2–1.8 [IND]. Values > 3 on small samples usually mean luck or overfitting.*

## Losing streaks are normal

With a 40% win rate, the probability that any given 6 trades are *all* losses is 0.6⁶ ≈ **4.7%**. Over 100 trades, a 6-loss streak somewhere is **likely**. At $250 per loss that's −$1,500 even if the system is profitable. Plan for it emotionally *now*.

## Sharpe ratio (conceptual)

Sharpe = (average return − risk-free return) ÷ standard deviation of returns. It measures **return per unit of volatility**. Higher is smoother. For a small sample of trades it is unstable. Use it only once you have months of daily P/L, and prefer expectancy and drawdown at first.

## Statistical traps

| Trap | Meaning | Defence |
|---|---|---|
| **Small sample** | 10–20 trades can show almost any result by luck | Wait for 100+ trades before strong conclusions |
| **Overfitting** | Tweaking rules until past results look great; the rules then fit noise | Fix rules first; test on unseen data; few parameters |
| **Survivorship bias** | Testing only on stocks that exist *today* (today's S&P 500), ignoring names that were removed (often after falling) | Treat backtests on current constituents as optimistic |
| **Look-ahead bias** | Using information that wasn't available at decision time (e.g., the day's final close, a candle's close before it closed) | Current-candle data in the scanner is fine live, but in backtests make sure exits use "After candle closes" |
| **Selection bias** | Journalling only "good" trades | Record every trade and every skipped valid alert |

::: {.why custom-style="Box Why"}
**ONE PROFITABLE DAY PROVES ESSENTIALLY NOTHING**

A coin-flip system with 2R targets will have many green days. A single day is maybe 0–5 trades: statistically meaningless. Judge the *process* daily, and the *system* only after 50–100 trades.
:::

# Safety and Discipline

| Rule | Psychological rationale |
|---|---|
| **Paper trade first.** | Mechanical skill (orders, sizing, speed) must become automatic before money adds stress. |
| **No real-money automation initially.** | Automation multiplies both edge and errors. You don't yet know which you have. |
| **Never increase position size to recover a loss.** | "Getting it back" is loss aversion speaking. Bigger size after losses causes the account-ending day. |
| **Never remove a stop because price approaches it.** | Hope is not a strategy. The stop is the decision you made while calm. |
| **Never chase a missed entry.** | FOMO buys late, at worse prices and with larger risk. Another setup will come. |
| **Avoid revenge trading.** | After a loss, the urge to act immediately produces impulsive, low-quality trades. Use the daily loss limit. |
| **Avoid excessive simultaneous correlated positions.** | Five tech longs are one big bet. They will stop out together. |
| **Avoid treating one good day as proof.** | Overconfidence leads to rule-breaking and size creep. |
| **Avoid adjusting parameters until historical results look good.** | Curve-fitting produces beautiful backtests and poor futures. |
| **Avoid changing strategy mid-session**, unless correcting a software/configuration error. | Mid-session changes are emotional reactions to the last few trades, and they corrupt your data. |
