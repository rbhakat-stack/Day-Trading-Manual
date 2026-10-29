# PART VIII — REFERENCE {.unnumbered .part}

# Frequently Asked Questions

## Alerts and signals

**1. Why did I receive an alert but price immediately reversed?**
An alert describes the *last closed* candle. Many signal candles are the end of a burst. That's exactly why v1 requires a **break of the signal-candle extreme** before entry. If price reversed without breaking it, the system worked: you didn't enter.

**2. What if the alert arrives late?**
Delivery can lag (SMS/email delays, and routing). Check the timestamp. If more than 10 minutes have passed without the trigger trading (STALE), or price is more than 0.25 ATR beyond the trigger (DO NOT CHASE), skip. Both are hard rules in v1.1.

**3. Can multiple stocks trigger together?**
Yes, frequently, especially on strong market moves (they're correlated). Send each eligible one to the Opportunity Ranker: it allocates capital **best score first** (never by arrival order) and enforces the slot (4), capital, heat (1%) and correlation limits.

**4. What happens when an alert expires?**
It stops being checked and won't fire again. Expirations appear in the Notifications widget [TS]. Expiration counts calendar days [TS].

**5. What is the difference between a scanner and an alert?**
The scanner searches *many* symbols *when you run it* and lists candidates. An alert watches *one* symbol *continuously* (every 5m close) for a specific setup. **Scanner ≠ Alert.**

**6. Why not simply automate every trade?**
Because the alert isn't the whole system. v1 includes human checks (Do-Not-Take list, breakout confirmation), and you have no evidence yet that the system is profitable. Automation magnifies mistakes. Revisit after 100+ journaled trades.

**7. Why did my alert fire when my chart doesn't look like it qualifies?**
Usual causes: different indicator parameters in the alert vs the chart; the chart is showing extended hours while the alert isn't (or the reverse); the 15m candle changed after the alert (larger-timeframe conditions can become untrue when that candle closes [TS]); or you are looking at a later candle.

**8. Why did my alert not fire although the chart looks perfect?**
Check: alert expired; conditions are evaluated only at the **5m close** [TS]; one condition (often RVOL > 1.5 or Close > Open) failed; Use Extended Hours mismatch; plan alert limit reached.

## Indicators

**9. Why is RSI 75 not automatically a SHORT?**
RSI 75 means buyers have dominated recently: that's momentum, not a reversal signal. v1 shorts require price below VWAP, EMA9 < EMA20 and RSI < 45.

**10. Why can RVOL be 12 at the close?**
The closing auction and end-of-day rebalancing create huge volume in the final minutes. Compared with the prior 20 quieter bars, the ratio explodes. It's normal and not a v1 signal.

**11. Why does TrendSpider show post-market RVOL?**
If extended hours are shown on the chart, post-market bars have volume, and thin bars make ratios swing wildly. v1 ignores extended-hours readings.

**12. What does "last" mean?**
The price of the most recent trade. It isn't necessarily the price you can buy (ask) or sell (bid) at.

**13. What does "1 candle ago" mean?**
The previous candle *on that condition's timeframe*: on 5m, the previous 5-minute bar; on Daily, the previous trading day.

**14. Why is EMA9 below EMA20?**
Recent prices (weighted heavily in EMA9) are lower than the medium-term average, so the short-term trend is down. For a LONG that disqualifies the setup.

**15. What if price is above VWAP but RSI is weak (e.g., 50)?**
Fails v1 (RSI must be > 55). Price may be drifting above VWAP without momentum, which is common in chop.

**16. What if 5m is bullish but 15m is bearish?**
No LONG (fails condition 6, a hard rule in v1.1). The 5m move is likely a counter-trend bounce into higher-timeframe sellers. Judge the 15m on the **last completed** 15m candle at the alert time (Chapter 13).

**17. Why does my VWAP differ from someone else's?**
Different settings: session vs anchored, extended hours included or not, price source (HLC3 vs Close), and possibly the Length setting (see the Chapter 3 VERIFY box).

**18. Is "overbought" a reason to exit a LONG?**
Not in v1. Exits are A–D only. Overextension matters at *entry* (ranking/Do-Not-Take), not as an exit.

## Entries and stops

**19. What if the entry candle is huge?**
Range > ~2× the 5m ATR → skip. The stop is far, and the candle may be exhaustion.

**20. What if I miss the breakout?**
If price is more than 0.25 ATR beyond the trigger: skip (DO NOT CHASE, a hard rule). Within 0.25 ATR the calculator offers a late-entry review that recalculates R, stop, target and shares from the current price.

**21. What if the stop is too far away?**
Skip the trade, or accept the smaller share count that the formula gives. Never move the stop closer artificially. (It can never be *closer* than 1 ATR in v1.1.)

**22. What if the stock hits my target immediately?**
Great: the limit fills, and you record +2R (minus slippage). Don't re-enter impulsively. Wait for a new alert.

**23. Should I move my stop to break-even?**
Not in v1. Break-even stops are a v2 test item, to be evaluated with data.

**24. Why must the trigger trade within 10 minutes?**
Your rule (two 5-minute candles). Momentum setups are perishable. A setup that doesn't confirm quickly has a lower probability. After 10 minutes the calculator marks it STALE. This is a trading rule, not a TrendSpider limitation.

**25. What buffer should I use above the high?**
B = MAX($0.01, 0.02% × High), rounded to the cent (SHORT: 0.02% × Low). $45.80 → $0.01; $255.60 → $0.05; $484 → $0.10. The calculator computes it.

**26. Can I enter before the break to get a better price?**
That's a different strategy (anticipation). Not v1.

**27. What if the signal candle is tiny?**
In v1.1 the stop is never closer than 1 × ATR, so R becomes the ATR (rounded up to the cent) and the stop sits beyond the candle's extreme. The $20,000 cap usually sets the size.

## Risk and sizing

**28. How many positions should I hold?**
Hard maximum: **4** positions or pending orders, total planned risk (heat) ≤ 1% of equity, at most $80,000 allocated and $20,000 per ticker. Recommendation: max 2 during the first 20 trades.

**29. Why is share quantity an output?**
Because the risk is fixed first ($250), and the stop is fixed by structure. The quantity is whatever makes those two consistent.

**30. Why round down?**
Rounding up exceeds your risk limit.

**31. Should I risk more on "A+" setups?**
Not in v1. An ELITE score (90+) gets capital first, not a bigger size. Variable sizing requires evidence that the Opportunity score predicts outcomes (ranker analytics, after 100 trades).

**32. Does the 0.25% use starting or current equity?**
**Current equity**, recalculated at least daily (each morning).

**33. What is a daily loss limit?**
A pre-set loss at which you stop for the day (recommendation: −1% or 3 consecutive losses).

## Orders, brokers and accounts

**34. What is buying power?**
The maximum dollar amount the broker allows you to commit now. It isn't a target and doesn't change your risk rules.

**35. Why does paper trading differ from real trading?**
Simulated fills (no queue, no market impact, size not checked against liquidity), different data (IEX for paper-only accounts), no fees, and no real emotions [ALP].

**36. Why did my order not fill?**
A limit/stop price was never reached; a limit order was beyond the market; it was rejected (check Alpaca: buying power, sub-penny price, extended-hours rules [ALP]); or it was cancelled at end of day (TIF `day`).

**37. What is a stop-limit?**
A stop that, when triggered, sends a *limit* order instead of a market order. It protects price but may not fill. The TrendSpider widget documents only Market/Limit/Stop [TS].

**38. What does "market closed" mean?**
The regular session (09:30–16:00 ET) isn't running. Market orders may be rejected or queued. Extended-hours orders at Alpaca must be limit orders [ALP].

**39. Why did my order get rejected for price?**
Prices ≥ $1 must use at most 2 decimals [ALP]. $100.205 is invalid.

**40. Do short sales work in my paper account?**
Alpaca supports shorting in paper [ALP]. Whether the TrendSpider widget's "Sell" opens a short via SignalStack must be confirmed with the 1-share test (Chapter 35).

**41. What is the SSR?**
Short Sale Restriction (SEC Rule 201): after a ≥ 10% drop from the prior close, shorts may only execute above the national best bid for the rest of that day and the next [REG]. v1 recommendation: skip shorts in SSR names.

**42. Is the PDT rule still a problem?**
FINRA's amended Rule 4210 removed the PDT designation and the $25,000 minimum effective **June 4, 2026**, replaced by intraday margin requirements (brokers may phase in until Oct 20, 2027) [REG]. Confirm your broker's implementation before going live.

**43. Why don't I see my executed order in TrendSpider?**
The Trading widget does not display executed orders [TS]. Check Open Positions (may lag up to 1 minute) and the Alpaca dashboard.

**44. Does a paper order use SignalStack signals?**
SignalStack's pricing lists unlimited paper signals [SS]. VERIFY any TrendSpider-side limits.

## TrendSpider usage

**45. Why do scanner results change every few minutes?**
With Current Candle ON, the forming candle counts as if closed [TS]. Stocks drift in and out until the candle closes.

**46. Why doesn't my scanner update by itself?**
Scans don't auto-refresh. Use **Refresh Scan Results** [TS].

**47. Can Sidekick place trades?**
No. Sidekick cannot place, modify or close trades; its SignalStack connection is read-only [TS].

**48. How many alerts can I have?**
It depends on your plan (10 / 50 / 100 / 400 by tier on the pricing page checked 2026-10-28). VERIFY in your account.

**49. Can I alert on the 1-minute chart?**
No. The lowest alert timeframe is 5 minutes [TS].

**50. Can I backtest the exact v1 system?**
Not exactly: the Strategy Tester uses one timeframe and can't express the breakout entry or the candle-based stop natively. See Chapter 31 for the closest approximation.

**51. Why is the "Chg%" column different from my 1% condition?**
Columns may compute change against a different reference (e.g., including extended-hours prices, or relative to the open), and the scanner uses the price at scan time. Verify by comparing the daily chart's previous close.

**52. Should I trade the first 15 minutes, or the last 30?**
No. New entries are allowed only from **09:45 to before 15:30 ET** (hard rule). 09:30–09:45 is observe-only; from 15:30 the calculator shows NEW ENTRY WINDOW CLOSED; at or after 16:00, AFTER REGULAR SESSION.

**53. Can I trade pre-market with v1?**
No. v1 is regular-session only. A pre-market system would need different scanners (Chapter 25) and limit-only orders.

**54. What if TrendSpider and Alpaca prices differ slightly?**
Data feeds differ (Alpaca paper-only accounts use IEX data [ALP]). Small differences are normal. Base decisions on TrendSpider, confirm fills in Alpaca.

**55. How long until I know whether v1 works?**
Expect 100+ trades. At 2–3 trades per day, that's roughly 2–3 months of paper trading.

## The calculator and the ranker

**56. The calculator shows a full order ticket but says NOT ELIGIBLE. Can I place it?**
No. "Mathematically calculable" is not "eligible to trade". The greyed ticket is shown for learning only (INVALID — DO NOT PLACE). Read the listed reasons.

**57. A setup scores 83 and is ranked #1. Can I take it?**
No. 85 is the minimum. 80–84 is WATCHLIST / RESERVE; rank never overrides the threshold.

**58. A better setup appears while I hold a filled position. Should I close the old one?**
No. Filled positions are never displaced; their stop and target govern them. Only a *pending* order can be replaced, and only when the new candidate beats it by ≥ 5 points (STRONGER OPPORTUNITY AVAILABLE → KEEP or CANCEL & RESERVE).

**59. Which 15m candle do I type into the calculator?**
The last completed regular-session 15m candle at the alert time: 10:07 → 09:45–10:00; 14:52 → 14:30–14:45.

# Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| **Scanner returns too many stocks** | Strong market day; Current Candle mid-bar; thresholds loose | Rank and keep the top 10; re-scan after the candle closes; don't loosen v1 to fix it |
| **Scanner count increases after tightening a condition** | The scan ran at a different moment (Current Candle ON); or the edit changed AND to Any/OR; or a condition's timeframe changed | Check the group is **All of the following**; check each condition's timeframe; re-run twice at the same candle |
| **Displayed Chg% does not match the scanner condition** | Different reference price (extended-hours close, open), or timing | Trust the condition; verify on the daily chart |
| **Alert does not fire** | Expired; a condition not met at the 5m close; Use Extended Hours mismatch; plan alert limit hit; on the wrong symbol | Open the alert and check each condition on the chart at the last closed 5m candle |
| **SMS does not arrive** | Wrong number; do-not-disturb window; weekend setting; carrier delay | Account & Settings → Notifications; test with a throwaway alert |
| **Sidekick sees the wrong watchlist** | Ambiguous name; several lists with similar names | Use the exact list name; date-stamp lists; "my list" triggers a dropdown picker [TS] |
| **Sidekick created unexpected alerts** | Prompt too vague | Delete them; always use preview → create |
| **Trading widget shows the live account instead of paper** | Wrong brokerage selected; multiple Alpaca connections | Select the PAPER account; consider not connecting live until needed |
| **SignalStack cannot see Alpaca** | Authorisation not completed; expired token; wrong Alpaca login | Re-run SignalStack → Alpaca connect (Allow); check Brokers & Webhooks |
| **Order rejected** | Insufficient buying power; sub-penny price; extended-hours order not limit; shorting not available | Check the Alpaca order's rejection reason [ALP] |
| **Stop Loss field unavailable** | That order type/broker combination doesn't support attached exits; widget beta | Place the stop as a separate order in Alpaca; record in the Change Log |
| **VWAP parameter differs between chart and alert** | Edited one but not the other | Re-create the alert from a saved template with the correct parameters |
| **RVOL unexpectedly huge** | Opening/closing bars; news; halt; extended-hours bars | Ignore during 09:30–09:45 and after 15:30 (no new entries then anyway); check news |
| **Scanner results differ after hours** | Ext. Hours setting; data now includes post-market; Current Candle on a closed session | Run v1 scans during the regular session only |
| **Position shows but stop/target missing** | Exit legs not created or cancelled | Immediately add the stop in Alpaca; investigate |
| **Unexpected new position after a manual close** | An orphaned stop/target leg filled | Cancel all pending orders after every manual exit |
| **Chart and alert disagree on 15m** | 15m candle still forming at alert time | Use the **last completed** 15m candle at the alert time (Chapter 13); if it fails, the setup is NOT ELIGIBLE |
| **Calculator says NOT ELIGIBLE although the chart looks fine** | A hard rule failed (time window, candle colour, 15m, stale, chased, setup failed, existing position) | Read every listed reason; check the alert time and the 15m inputs |
| **Send to Ranker / Copy are greyed out** | A hard rule failed | By design: ineligible setups cannot be ranked or copied |
| **Ranker shows SCORING INCOMPLETE** | A required ranker input is missing | Enter the listed fields; missing values are never treated as 0 |
| **Ranker shows CAPITAL WAITLIST** | Higher-scoring candidates used the capital, slots or heat | Wait; or cancel a weaker *pending* order if STRONGER OPPORTUNITY is shown |
| **Paper P/L looks too good** | No slippage/queue modelling | Add a slippage estimate to the journal; be conservative |

# One-Page Cheat Sheets

## Sheet 1 — Trading terminology

| Term | One line |
|---|---|
| Bid / Ask / Spread | Best buy price / best sell price / the gap between them |
| Last | Most recent trade price |
| Long / Short | Profit if price rises / profit if price falls |
| Cover | Buy back to close a short |
| Market / Limit / Stop / Stop-limit | Now at any price / at this price or better / trigger then market / trigger then limit |
| Bracket / OCO | Entry + stop + target / two exits, one cancels the other |
| Slippage | Worse fill than planned |
| Equity / Buying power | Account value / allowed exposure |
| Realized / Unrealized P/L | Closed / still open |
| R | Risk per trade; results are measured in R |

## Sheet 2 — Indicator meanings

| Indicator | LONG wants | SHORT wants |
|---|---|---|
| VWAP | Close above | Close below |
| EMA9 vs EMA20 | 9 > 20 | 9 < 20 |
| RSI14 | > 55 (ideal 55–70) | < 45 (ideal 30–45) |
| RVOL20 | > 1.5 alert / > 2.0 scan | same |
| 15m Close vs EMA20 | above | below |
| ATR (5m, 14) | minimum stop = 1 ATR; chase limit 0.25 ATR; candle < 2× ATR; < 2.5 ATR from VWAP | same |

## Sheet 3 — LONG setup

Scanner: S&P 500 · $10–$500 · D Vol MA20 > 1M · 5m RVOL > 2 · Daily ≥ +1% · 5m Close > VWAP · EMA9 > EMA20 · RSI > 55 · 15m Close > EMA20.
Alert: 5m Close > VWAP · EMA9 > EMA20 · RSI14 > 55 · RVOL20 > 1.5 · Close > Open · 15m Close > EMA20.
Hard rules: Close > Open · last completed 15m Close > EMA20 · 09:45 ≤ time < 15:30 ET.

## Sheet 4 — SHORT setup

Scanner: same universe filters · Daily ≤ −1% · 5m Close < VWAP · EMA9 < EMA20 · RSI < 45 · 15m Close < EMA20.
Alert: 5m Close < VWAP · EMA9 < EMA20 · RSI14 < 45 · RVOL20 > 1.5 · Close < Open · 15m Close < EMA20.
Hard rules: Close < Open · last completed 15m Close < EMA20 · 09:45 ≤ time < 15:30 ET.

## Sheet 5 — Entry / stop / target

| | LONG | SHORT |
|---|---|---|
| Buffer B | MAX($0.01, 0.02% × High) | MAX($0.01, 0.02% × Low) |
| Entry E | Signal HIGH + B | Signal LOW − B |
| R | MAX(E − LOW, 1 × ATR) | MAX(HIGH − E, 1 × ATR) |
| Stop | E − R | E + R |
| Target | E + 2R | E − 2R |
| Stale | Trigger not hit within 10 minutes | same |
| Chased | > 0.25 ATR past E | same |
| Example | IBM: 255.65 / 255.24 / 256.47, 78 sh | NVDA: 212.53 / 212.97 / 211.65, 94 sh |

## Sheet 6 — Risk calculator

```
$R      = 0.0025 × equity                  (100,000 → 250, a maximum)
Shares  = floor($R / R)
Cap     = floor(20,000 / E)                ($20,000 per ticker)
Qty     = min(Shares, Cap)
Risk $  = Qty × R
Portfolio: ≤ 4 positions/orders · heat ≤ 1% · ≤ $80,000 allocated
```

## Sheet 7 — TrendSpider navigation

| Need | Where [TS] |
|---|---|
| Symbol | Symbol Search & Selection Field |
| Timeframe | Timeframe dropdown |
| Indicators | ⋮ next to Indicators → Indicator Manager |
| Scanner | Market Scanner → NEW SCANNER → Skip to Point & Click Editor |
| Alerts | ⋮ next to Alerts & Bots → Multi-Factor Alert |
| Templates | Visual Scripts → Script Manager |
| Notifications | Profile → Account & Settings → Notifications |
| Trading | Right sidebar → Trading Widget |
| Backtest | Strategy Tester (bottom-left) |
| AI | Sidekick AI |

## Sheet 8 — Scanner workflow

1. 09:40 Refresh both scanners (Current Candle ✓, Ext. Hours ☐, S&P 500).
2. Rank the scan (RVOL, VWAP distance in ATR, EMA separation, RSI zone, daily %, 15m, extension). Alerts that fire are scored later by the Opportunity Ranker.
3. Keep the top ≤ 10 per side → static lists `RB v1 LONG/SHORT <date>`.
4. Re-scan at 11:00 and 13:30; update the lists.

## Sheet 9 — Alert workflow

1. Preview, then create the LONG alerts on the LONG list and the SHORT alerts on the SHORT list (≤ 20 per Sidekick message).
2. Expiry: end of day. Regular hours only.
3. Spot-check 2 alerts' conditions.
4. When one fires → the 17-step procedure (Trade Calculator → Opportunity Ranker → order only on TRADE NOW).

## Sheet 10 — Paper-order workflow

1. Widget account = **Alpaca PAPER**.
2. Side: Buy (LONG) / Sell (SHORT).
3. Type: Market after the trigger trades and the late-entry review recalculates (Process A), or Stop at the trigger (Process B).
4. Qty = calculator (MIN of risk shares and $20,000 cap shares).
5. Stop Loss = E ∓ R; Take Profit = E ± 2R (from the calculator).
6. Read aloud → Submit → confirm in Alpaca → journal.

## Sheet 11 — Daily routine

08:45 setup → 09:00 context and $R → 09:15 verify charts, account and the app → 09:30 observe → 09:40 scan/rank/lists → 09:45 alerts; entry window opens → 11:00 and 13:30 re-scan → 15:30 entry window closes (hard rule) → 15:55 flat → 16:00 review.

## Sheet 12 — End-of-day review

* All trades journaled with screenshots? Rules followed?
* Today's R total, win/loss, exit reasons.
* Any skipped valid alerts (and why)?
* Mistakes by category; one lesson for tomorrow.
* Any software/configuration issue → Change Log.
* Equity → tomorrow's $R.

## Sheet 13 — Troubleshooting checklist

Alert silent? → expiry, conditions at the 5m close, ext-hours setting, plan limit. · No SMS? → number, DND, weekends. · Wrong account? → widget selector. · Order rejected? → Alpaca reason. · Orphan orders? → cancel all pending. · Chart ≠ alert? → parameters and 15m timing.

# Am I Ready for Live Trading?

::: {.warn custom-style="Box Warn"}
**This checklist requires EVIDENCE, not confidence.** Every box must be ticked from your journal. If any box is unticked, the answer is **no**: keep paper trading. Passing it does not guarantee live profitability.
:::

| # | Requirement | Evidence | ☐ |
|---|---|---|---|
| 1 | **≥ 100 paper trades** under the *same* rule version | Journal count | ☐ |
| 2 | Spanning **≥ 2 calendar months** and different market conditions (up, down and choppy days) | Dates, regime tags | ☐ |
| 3 | **Expectancy > +0.15R** per trade *after* a conservative slippage adjustment (e.g., subtract 0.1R per trade) | Spreadsheet | ☐ |
| 4 | **Profit factor ≥ 1.3** | Spreadsheet | ☐ |
| 5 | **Max drawdown ≤ 10R**, and you continued following rules through it | Equity curve | ☐ |
| 6 | **Rules followed on ≥ 95%** of trades in the last 50 | "Followed rules?" column | ☐ |
| 7 | **Zero** sizing errors and zero "wrong account" incidents in the last 50 trades | Journal | ☐ |
| 8 | Both LONG and SHORT reviewed separately. Trade only the side(s) that are positive on their own | Split stats | ☐ |
| 9 | Results not dependent on 1–3 outlier trades (remove the top 3 winners → still ≥ 0R) | Spreadsheet | ☐ |
| 10 | A written plan for live: starting size **¼ of paper risk** (e.g., 0.0625%), daily loss limit, max positions | Change Log entry | ☐ |
| 11 | Broker rules understood (intraday margin under amended FINRA 4210, short availability, fees) | Notes | ☐ |
| 12 | Order plumbing tested on the live account with minimum size | Test log | ☐ |
| 13 | No unresolved VERIFY items affecting execution (Chapter 35 tests passed) | Appendix C / Change Log | ☐ |
| 14 | You have pre-decided what result would make you **stop** live trading (e.g., −15R or 30 trades below expectations) | Written | ☐ |
