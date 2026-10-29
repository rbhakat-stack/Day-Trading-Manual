# APPENDICES {.unnumbered .part}

# Appendix A — Glossary {.unnumbered}

| Term | Definition |
|---|---|
| **ADR (Average Daily Range)** | Average of (daily high − daily low) over N days; how far a stock typically travels in a day. |
| **ADX** | Average Directional Index; measures trend *strength* (0–100), not direction. |
| **After-hours (post-market)** | 16:00–20:00 ET trading session. |
| **Alert** | A rule that watches a symbol and notifies you when its conditions are met. Not a trade. |
| **Alpaca** | Brokerage offering an API and a free paper-trading environment. |
| **Anchored VWAP (AVWAP)** | VWAP calculated from a user-chosen starting candle. |
| **AND logic** | All conditions must be true ("All of the following"). |
| **Ask (offer)** | Lowest price a seller currently accepts. |
| **ATR (Average True Range)** | Smoothed average of true range; a volatility measure. |
| **Average volume** | Mean volume over N periods. |
| **Backtest** | Simulating a strategy on historical data. |
| **Base (RVOL)** | Reference level of the Relative Volume indicator (1 = average volume). |
| **Bearish** | Expecting or showing falling prices. |
| **Bid** | Highest price a buyer currently pays. |
| **Body (candle)** | Part of a candle between open and close. |
| **Bracket order** | Entry order with attached stop-loss and take-profit; one exit cancels the other. |
| **Break-even stop** | Stop moved to the entry price after a gain. Not in v1. |
| **Breakdown** | Price moving below support. |
| **Breakout** | Price moving above resistance. |
| **Breakout candle** | Candle that closes beyond a key level. |
| **Buffer (breakout)** | Amount added above the signal high (LONG) or subtracted below the signal low (SHORT) to set the entry trigger. v1.1: MAX($0.01, 0.02% × price), rounded to the cent. |
| **Bullish** | Expecting or showing rising prices. |
| **Buy to cover** | Buying shares to close a short position. |
| **Buying power** | Maximum amount the broker lets you commit now. |
| **Candle (candlestick)** | Visual summary of open, high, low and close for one period. |
| **Candle range** | High − Low. |
| **Cash** | Uninvested account balance. |
| **Capital waitlist** | Ranker status for a candidate scoring ≥ 85 that does not fit because higher-scoring candidates used the capital, slots or heat. |
| **Chasing** | Entering after price has already moved well beyond the planned entry. v1.1 hard rule: more than 0.25 ATR past the entry = DO NOT CHASE. |
| **Close** | Last price of a period. |
| **Commission** | Broker fee per trade (Alpaca: commission-free stock trading; regulatory fees may apply live). |
| **Concentration** | Large exposure to one name, sector or theme. |
| **Condition group** | Set of conditions combined with All/Any/None logic in TrendSpider. |
| **Consolidation** | Sideways, range-bound price action. |
| **Constant value** | A fixed number used in a condition (e.g., RSI > 55). |
| **Correlation** | Tendency of two instruments to move together. |
| **Current Candle (scanner)** | TrendSpider option to evaluate the forming candle as if closed. |
| **Day trade** | Opening and closing a position in the same session. |
| **Depth (Strategy Tester)** | Number of candles or date range used in a backtest. |
| **Divergence** | Price and an indicator moving in opposite directions. |
| **Doji** | Candle with open ≈ close; indecision. |
| **Drawdown** | Decline from an equity peak to a subsequent trough. |
| **EMA (Exponential Moving Average)** | Moving average weighting recent prices more heavily; α = 2/(N+1). |
| **EMA alignment** | Relative position of EMAs (e.g., EMA9 above EMA20). |
| **EMA crossover** | Event when one EMA crosses another. |
| **Engulfing (bullish/bearish)** | Two-candle pattern in which the second body covers the first. |
| **Entry** | Price where a position is opened. |
| **Entry window** | v1.1 hard rule: new entries only from 09:45 to before 15:30 ET. |
| **Equity (portfolio value)** | Cash plus the market value of positions. |
| **Exit** | Price where a position is closed. |
| **Expectancy** | Average result per trade: Win% × AvgWin − Loss% × AvgLoss. |
| **Expiration (alert)** | When an alert stops being active (time or trigger count). |
| **Extended hours** | Pre-market and after-hours sessions. |
| **Fill** | Execution of an order (fully or partially). |
| **FOMO** | Fear of missing out; leads to chasing. |
| **Gap** | Open far from the prior close, leaving empty space on the chart. |
| **Gap risk** | Risk that price jumps past your stop. |
| **Hammer** | Small body near the top with a long lower wick; potential reversal at support. |
| **Happened / Happened Within** | TrendSpider condition timing: exact candle vs within N candles. |
| **Hard rule** | A rule whose failure makes a setup NOT ELIGIBLE regardless of score, rank or how good the chart looks. Listed in Chapters 16 and 21. |
| **Heat (portfolio heat)** | Total planned risk (shares × R) of all open positions and pending orders. v1.1 limit: 1% of equity. |
| **High** | Highest price of a period. |
| **HLC3** | (High + Low + Close) ÷ 3; typical price. |
| **Inside bar** | Candle whose range lies within the prior candle's range. |
| **Intraday margin** | FINRA 4210 standard (effective 2026-06-04) replacing PDT rules for margin accounts. |
| **Inverted hammer** | Small body near the bottom with a long upper wick after a decline. |
| **Last** | Most recent trade price. |
| **Last completed 15m candle** | The most recent fully closed regular-session 15-minute candle at the alert time (10:07 → 09:45–10:00). Used for the 15m confirmation. |
| **Late entry review** | Calculator state when price has crossed the trigger by ≤ 0.25 ATR; a market entry is allowed only after a full recalculation at the current price. |
| **Length** | Number of periods used by an indicator. |
| **Limit order** | Order to trade at a specified price or better. |
| **Liquidity** | Ease of trading without moving the price. |
| **Locate** | Broker confirmation that shares can be borrowed for a short sale. |
| **Long** | Owning shares; profits if price rises. |
| **Look-ahead bias** | Using information not yet available at decision time. |
| **Low** | Lowest price of a period. |
| **MA Type** | Averaging method (SMA, EMA, HullMA…). |
| **MACD** | EMA12 − EMA26 with a signal line; momentum indicator. |
| **MAE** | Maximum adverse excursion: worst unrealised loss during a trade. |
| **Margin** | Borrowing from the broker; required for shorting. |
| **Market order** | Order to trade immediately at the best available price. |
| **Market Scanner** | TrendSpider tool that screens many symbols against conditions. |
| **Mean reversion** | Tendency of stretched prices to return toward an average. |
| **MFE** | Maximum favourable excursion: best unrealised gain during a trade. |
| **Momentum** | Speed and persistence of price movement. |
| **Multi-Factor Alert** | TrendSpider alert combining several conditions/timeframes. |
| **NBBO** | National Best Bid and Offer. |
| **Notional** | Shares × price; the position's dollar size. |
| **OCO** | One-Cancels-Other pair of exit orders. |
| **Offset** | Candle reference: 0 current, −1 previous. |
| **OHLC** | Open, High, Low, Close. |
| **Open** | First price of a period. |
| **Open risk** | Sum of the risk of all open positions (see Heat). |
| **Opportunity score** | The Opportunity Ranker's 0–100 score: Setup Quality (70) + Portfolio Fit (30). 85 is the minimum to trade. |
| **OR logic** | Any condition true ("Any of the following"). |
| **Overextension** | Price stretched far from its averages. |
| **Overfitting** | Tuning rules to past noise. |
| **Paper trading** | Simulated trading with no real money. |
| **Partial profit** | Closing part of a position early. Not in v1. |
| **Payoff ratio** | Average win ÷ average loss. |
| **PDT (Pattern Day Trader)** | Former FINRA designation with a $25,000 minimum; removed effective 2026-06-04. |
| **Pivot points** | Levels calculated from the prior day's H, L, C. |
| **Position** | Current holding in a symbol (+ long, − short). |
| **Position Tool** | TrendSpider drawing showing entry/stop/target zones. |
| **Pre-market** | 04:00–09:30 ET session. |
| **Price Source** | Candle value an indicator uses (Close, HLC3…). |
| **Profit factor** | Gross profit ÷ gross loss. |
| **Pullback** | Temporary move against the prevailing trend. |
| **R (R-multiple)** | Result expressed in units of initial risk. |
| **Realized P/L** | Profit/loss on closed positions. |
| **Regular market hours** | 09:30–16:00 ET. |
| **Rejection candle** | Candle that pierces a level but closes back on the original side. |
| **Relative Strength (RS)** | Performance vs a benchmark (not RSI). |
| **Resistance** | Zone where rallies have repeatedly stalled. |
| **Retest** | Return to a broken level from the other side. |
| **Reversal** | Change in trend direction. |
| **Revenge trading** | Impulsive trading to recover losses. |
| **Risk per share (R)** | Distance from entry to stop. v1.1: R = MAX(structural risk, 1 × ATR). |
| **Risk/reward** | Potential reward ÷ potential risk. |
| **RSI (Relative Strength Index)** | 0–100 momentum oscillator: 100 − 100/(1 + RS). |
| **RVOL (Relative Volume)** | Volume ÷ its moving average. |
| **Scanner** | Tool that finds candidates across many symbols. |
| **Setup failed** | Hard rule: price has already traded at or through the planned stop before entry. |
| **Stale setup** | Hard rule: the trigger has not traded within 10 minutes (two 5m candles) of the alert. |
| **Structural risk** | Distance from the entry to the far end of the signal candle: E − Low (LONG) or High − E (SHORT). |
| **Sharpe ratio** | Excess return ÷ volatility of returns. |
| **Short (short sale)** | Selling borrowed shares; profits if price falls. |
| **Shooting star** | Long upper wick and small low body after an advance. |
| **Sidekick** | TrendSpider's AI assistant. |
| **Signal (SignalStack)** | An order successfully sent to a linked broker. |
| **Signal candle** | The completed 5m candle that satisfied the alert. |
| **SignalStack** | Order-routing service connecting TrendSpider to brokers. |
| **Slippage** | Difference between the planned and actual fill. |
| **SMA (Simple Moving Average)** | Equal-weighted average of N closes. |
| **Smart Watchlist** | Saved scan used as a re-runnable watchlist. |
| **Spread** | Ask − Bid. |
| **SSR (Short Sale Restriction)** | Rule 201 restriction after a ≥ 10% drop from the prior close. |
| **Static watchlist** | Fixed list of symbols. |
| **Stochastic** | Oscillator showing the close's position within the recent range. |
| **Stop order** | Becomes a market order when the stop price trades. |
| **Stop-limit order** | Becomes a limit order when the stop price trades. |
| **Stop-loss** | Pre-set exit that limits the loss. |
| **Strategy Tester** | TrendSpider's backtesting tool. |
| **Support** | Zone where declines have repeatedly stalled. |
| **Survivorship bias** | Ignoring instruments that disappeared. |
| **Take-profit** | Pre-set exit that captures a gain. |
| **TIF (Time in Force)** | How long an order stays active (day, gtc, ioc, fok…). |
| **Time stop** | Exit after a set time without sufficient progress. |
| **Timeframe** | Period that one candle represents. |
| **Trading widget** | TrendSpider's order ticket using SignalStack. |
| **Trailing stop** | Stop that follows price at a set distance. Not in v1. |
| **Trend** | Persistent directional movement. |
| **True Range** | max(H − L, \|H − prev C\|, \|L − prev C\|). |
| **Unrealized P/L** | Profit/loss on open positions. |
| **Visual Scripts** | TrendSpider's condition-building and template system. |
| **Volatility** | Size of price fluctuations. |
| **Volume** | Number of shares traded. |
| **VWAP** | Volume Weighted Average Price: Σ(TP × V) ÷ ΣV. |
| **VWAP reclaim / rejection** | Close back above VWAP / failure at VWAP. |
| **Watchlist** | List of symbols to monitor. |
| **Webhook** | Automated HTTP message sent when an alert fires. Not used in v1. |
| **Whipsaw** | Rapid false signals in choppy markets. |
| **Win rate** | Winning trades ÷ total trades. |

# Appendix B — Index {.unnumbered}

*Chapter numbers refer to the numbered chapters. "App." = appendix.*

| Topic | Chapter(s) |
|---|---|
| 0.25% risk rule | 18, 37, 44 (sheet 6) |
| 2R target | 19, 20, 37 |
| ADR | 8 |
| ADX | 8 |
| Alert capacity / plan limits | 28, 42 (Q48) |
| Alert vs scanner | Front matter, 13, 42 (Q5) |
| Alerts — building LONG/SHORT | 13, 14, 28 |
| Alerts — evaluation timing | 2, 9, 28 |
| Alpaca paper account | 34 |
| Anchored VWAP | 3 |
| AND / OR logic | 13, 25 |
| Architecture (TrendSpider → SignalStack → Alpaca) | 32 |
| ATR | 7, 15, 17, 18, 21 |
| Backtesting | 31, 40 |
| Bid / ask / spread | 1 |
| Bollinger Bands | 8 |
| Bracket / OCO orders | 1, 35 |
| Break-even stop | 20, 22 |
| Buffer (breakout) | 16, 37 |
| Buying power | 1, 34, 42 (Q34) |
| Candidate ranking | 15, 27, 38 |
| Candle anatomy | 2 |
| Candle direction (hard rule) | 13, 14, 16, 21 |
| Candle patterns | 2 |
| Change Log | App. E |
| Chasing (0.25 ATR rule) | 7, 16, 21 |
| Cheat sheets | 37, 44 |
| Correlation / concentration | 18, 38 |
| Current Candle setting | 2, 25 |
| Daily loss limit | 18, 41 |
| Do-Not-Take checklist | 21 |
| EMA | 4 |
| Entry rules | 16 |
| Entry window 09:45–15:30 | 10, 16, 21, 36 |
| Exit rules A–D | 20 |
| Expectancy | 19, 40 |
| Extended hours | 1, 25, 28 |
| FAQ | 42 |
| Glossary | App. A |
| Hard rules | 13, 16, 21, 38 |
| Indicator Manager | 24 |
| Investment cap ($20,000) | 18, 37, 38 |
| Journal | 39 |
| Last completed 15m candle | 9, 13, 36, 42 (Q59) |
| Late entry review | 16, 35, 38 |
| Live-trading readiness | 45 |
| Long vs short | 1 |
| MACD | 8 |
| Market regime | 21, 22 |
| Multi-timeframe analysis | 9 |
| Notifications | 29 |
| Opportunity Ranker | 15, 38 |
| Opportunity score thresholds (90/85/80/75) | 38 |
| Order types | 1, 35 |
| Overextension | 15, 21 |
| Overfitting | 31, 40 |
| Paper vs live | 34, 42 (Q35) |
| PDT rule / intraday margin | 1, 42 (Q42) |
| Pending-order replacement | 38 |
| Performance metrics | 40 |
| Portfolio heat / position limits | 18, 38 |
| Position size table | 37 |
| Position sizing examples | 18 |
| Position Tool | 30 |
| Pre-market scanner | 25 |
| R = MAX(structural, 1 ATR) | 17, 18, 37 |
| R-multiples | 19 |
| RSI | 5 |
| Runbook (daily) | 36, 44 |
| RVOL | 6, 13 |
| Safety / discipline | 41 |
| Scanner — bearish | 12, 25 |
| Scanner — bullish | 11, 25 |
| Screenshot register | App. C |
| Setup failed | 16, 21 |
| Short selling, SSR, locate | 1, 21, 42 |
| Sidekick | 27 |
| SignalStack | 33 |
| Slippage | 1, 18, 34 |
| SMA | 4 |
| Smart / static watchlists | 26 |
| Sources | App. D |
| Stale setup (10-minute rule) | 16, 21, 36, 42 (Q24) |
| Stop-loss methods | 17 |
| Strategy Tester | 31 |
| Support / resistance | 1, 8 |
| Time stop | 20 |
| Trade Calculator (app) | 38 |
| Trading widget | 35 |
| Troubleshooting | 43 |
| v2 improvements | 22 |
| Volume | 6 |
| VWAP | 3 |
| VWAP Length 14 question | 3, 22 |

# Appendix C — Screenshot Placeholder Register {.unnumbered}

Capture each screenshot in your own account, save it as `manual/screenshots/SS-xx.png`, and replace the placeholder box in the text with `![caption](screenshots/SS-xx.png)`. For every workflow capture a **full-screen** image *and* a **cropped** image (`SS-xx-crop.png`), and add numbered callouts matching the steps (any annotation tool works: Snagit, Windows Snipping Tool + Paint, Greenshot).

| ID | Screen | Chapter | Annotate | Status |
|---|---|---|---|---|
| SS-01 | Full TrendSpider workspace, AAPL 5m | 23 | ① – ⑪ main areas | ☐ |
| SS-02 | Top toolbar (crop) | 23 | Each toggle's name | ☐ |
| SS-03 | Symbol Search with AAPL | 24 | Field | ☐ |
| SS-04 | Timeframe dropdown → 5 min; chart extended-hours toggle | 24 | Dropdown, option, toggle | ☐ |
| SS-05 | Indicator Manager | 24 | ⋮, search, Apply, active list | ☐ |
| SS-06 | VWAP settings (14, 0, HLC3) | 24 | Each field | ☐ |
| SS-07 | EMA9 settings | 24 | Each field | ☐ |
| SS-08 | EMA20 settings | 24 | Each field | ☐ |
| SS-09 | RSI settings | 24 | Length, bands, source | ☐ |
| SS-10 | Relative Volume settings | 24 | Length, MA Type, Base | ☐ |
| SS-11 | Volume settings | 24 | MA Length, MA Type | ☐ |
| SS-12 | Final configured chart | 24 | All indicators + legend | ☐ |
| SS-13 | Market Scanner → NEW SCANNER, AI vs Point & Click | 25 | Buttons | ☐ |
| SS-14 | Point & Click editor with 9 bullish conditions; crop of condition 5 ("1 candle ago", "by at least 1%") | 11, 25 | Conditions 1–9 | ☐ |
| SS-15 | Search In → S&P 500 | 25 | Dropdown | ☐ |
| SS-16 | Current Candle ✓ / Ext. Hours ☐ | 25 | Both checkboxes | ☐ |
| SS-17 | Scan results + three-dot menu | 25 | Refresh, clone to watchlist, columns | ☐ |
| SS-18 | Saved bearish scanner | 25 | Changed conditions 5–9 | ☐ |
| SS-19 | Watch Lists widget selecting a saved scan (and how widgets are added) | 23, 26 | Steps | ☐ |
| SS-20 | Add or Remove From Watch Lists → new static list | 26 | Steps | ☐ |
| SS-21 | Sidekick ranking prompt + answer | 27 | Prompt, table | ☐ |
| SS-22 | Sidekick alert creation result + alert list | 27 | Created alerts | ☐ |
| SS-23 | Alerts & Bots ⋮ → Multi-Factor Alert | 28 | Menu | ☐ |
| SS-24 | Alert settings: name, note, expiration choices, ext. hours | 28 | ① – ⑤; record trigger-count options | ☐ |
| SS-25 | LONG alert conditions | 28 | 1–6 | ☐ |
| SS-26 | SHORT alert conditions / template save | 28 | 1–6, Save as template | ☐ |
| SS-27 | Notifications widget with a trigger | 28, 29 | Entry, timestamp | ☐ |
| SS-28 | Account & Settings → Notifications | 29 | ① – ⑥ | ☐ |
| SS-29 | Mobile app push + Alerts tab | 29 | Notification, tab | ☐ |
| SS-30 | Position Tool on chart | 30 | Entry, stop, target | ☐ |
| SS-31 | Position Tool properties | 30 | Level fields; R:R if shown | ☐ |
| SS-32 | Strategy Tester settings, entry and exits | 31 | ① – ⑥ | ☐ |
| SS-33 | Strategy Tester results + Download | 31 | Curve, metrics, export | ☐ |
| SS-34 | Trading widget → Enable Trading | 33 | Button | ☐ |
| SS-35 | Alpaca "Allow" for SignalStack | 33 | Allow | ☐ |
| SS-36 | SignalStack Brokers & Webhooks with Alpaca | 33 | Paper account label | ☐ |
| SS-37 | Trading widget brokerage selector showing Alpaca PAPER | 33, 35 | Exact label | ☐ |
| SS-38 | Trading widget LONG order filled in | 35 | Every field | ☐ |
| SS-39 | Trading widget SHORT order filled in | 35 | Every field | ☐ |
| SS-40 | Open Positions / Pending Orders, X to cancel | 35 | Lists, X | ☐ |
| SS-41 | Alpaca paper dashboard | 34 | Paper selector, equity, cash, BP | ☐ |
| SS-42 | Alpaca orders/positions (bracket legs visible) | 34, 35 | Legs, status | ☐ |
| SS-43 | Trade Calculator with the IBM example | 38 | Inputs, decision, ticket, Show Calculation | ☐ |
| SS-44 | Opportunity Ranker queue and score card | 38 | Score, tier, rank, capital/heat, replacement prompt | ☐ |

# Appendix D — Sources and Verification Log {.unnumbered}

All accessed **2026-10-28**. Tier 1 = official product documentation.

| # | Source | Used for |
|---|---|---|
| 1 | TrendSpider KB — Volume Weighted Average Price (help.trendspider.com/kb/indicators/volume-weighted-average-price) | VWAP inputs (Length, Offset, Price Source) |
| 2 | TrendSpider KB — Relative Volume (…/kb/indicators/relative-volume) | Length, MA Type, Base |
| 3 | TrendSpider KB — How to Create Multi-Factor Alerts (…/kb/alerts/create-a-new-multi-factor-alert-from-scratch) | Alert UI steps, All/Any/None, Happened Within, Create Alert |
| 4 | TrendSpider KB — Multi-Factor Alerts Overview (…/kb/alerts/multi-factor-alerts-overview) | Checked at the smallest-timeframe candle close; larger-TF caveat |
| 5 | TrendSpider KB — Alerts FAQ (…/kb/alerts/alerts-faq-markdown-html) | 5-minute minimum, calendar-day expiry, 20 alerts/Sidekick message |
| 6 | TrendSpider KB — Extended Hours Support in MFA (…/kb/alerts/extended-hours-support-in-multi-factor-and-dynamic-price-alerts) | Use Extended Hours, Fire During, session times |
| 7 | TrendSpider KB — Alert Notification Settings (…/kb/alerts/alert-notification-settings) | Notifications panel |
| 8 | TrendSpider KB — Market Scanner (…/kb/scanner/market-scanner) | NEW SCANNER, Point & Click, Ext. Hours, Current Candle, Save |
| 9 | TrendSpider KB — Multiple Timeframes & the Current Candle (…/kb/scanner/multiple-timeframes-and-the-current-candle) | 3-timeframe limit, Current Candle |
| 10 | TrendSpider KB — Scanner FAQ (…/kb/scanner/market-scanner-faq-markdown-html) | Search In, refresh, clone results, All/Any/None |
| 11 | TrendSpider KB — Using Smart Watchlists (…/kb/scanner/using-smart-watchlists) | Smart Watchlist steps |
| 12 | TrendSpider KB — Interface Overview (…/kb/charting/interface-overview) | Toolbar names |
| 13 | TrendSpider KB — Indicator Manager / Customize Indicators | Adding/editing indicators |
| 14 | TrendSpider KB — TrendSpider Sidekick AI; Sidekick Prompting Guide | Capabilities, limits, prompt structure |
| 15 | TrendSpider KB — Strategy Tester: Creating a New Strategy; Strategy Tester FAQ | Settings, exits, limitations, export |
| 16 | TrendSpider KB — Trading Widget (…/kb/right-sidebar/trading-on-platform) | Setup, fields, limitations |
| 17 | TrendSpider pricing page (trendspider.com/pricing) | Alert limits by plan, Sidekick messages, trades allowance |
| 18 | TrendSpider blog — drawing tools release note | Position Tool (older; verify) |
| 19 | TrendSpider Mobile Companion App introduction / 1.0.3 release | Push notifications (older; verify) |
| 20 | SignalStack — Connect Alpaca (help.signalstack.com/kb/brokers-and-exchanges/connect-alpaca) | OAuth steps |
| 21 | SignalStack — Overview; TrendSpider Alerts integration | Router concept, webhooks |
| 22 | SignalStack pricing (signalstack.com/pricing) | Signal definition, quotas, unlimited paper signals |
| 23 | Alpaca — Paper Trading (docs.alpaca.markets/docs/paper-trading) | $100k default, fill simulation, limitations |
| 24 | Alpaca — Orders at Alpaca (…/docs/orders-at-alpaca) | Order types, bracket/OCO/OTO, TIF, extended hours, rejections, short BP |
| 25 | Alpaca — User Protection; changelog 2026-06-04 PDT; Alpaca forum staff post | PDT removal implementation |
| 26 | FINRA Rule 4210 amendments — SEC approval April 2026, effective 2026-06-04 (law-firm client alerts summarising the SEC approval order) | PDT replacement |
| 27 | SEC Regulation SHO Rule 201 | Short Sale Restriction (SSR) |
| 28 | RB v1 Trade Calculator + Opportunity Ranker: `calculator/README.md` and `calculator/src/engine/` (rules.ts, tradeCalculator.ts, settings.ts, ranker/), checked 2026-10-29 | RB v1.1 formulas, hard rules, scoring, thresholds and portfolio policy (Chapters 10–21, 35–38) |

**Open verification items** (also flagged in the text): VWAP Length behaviour (Ch. 3); "by at least" wording (Ch. 11); bar timestamp convention (Ch. 2); alert trigger-count options (Ch. 28); sidebar widget adding (Ch. 23); push notification settings (Ch. 29); Position Tool features (Ch. 30); paper account label and selection in SignalStack (Ch. 33); widget short/bracket/stop-entry behaviour (Ch. 35); Alpaca paper PDT behaviour (Ch. 1); plan alert limit (Ch. 28); whether Sidekick has news data (Ch. 27).

# Appendix E — Change Log {.unnumbered}

| Version | Date | Area (Strategy / Software / Manual) | Change | Reason / evidence | Approved by |
|---|---|---|---|---|---|
| 1.0 | 2026-10-28 | Manual | Initial release documenting RB System v1 | — | Ranabir |
| 1.1 | 2026-10-29 | Strategy + Software + Manual | **RB v1.1**, matching the Trade Calculator and Opportunity Ranker (`calculator/`). (1) **Stop/risk:** R = MAX(structural risk, 1 × ATR(14) 5m), rounded up to the cent when ATR controls; Stop = E ∓ R; Target = E ± 2R (Ch. 7, 17–20, 35–37, 44). (2) **Buffer:** MAX($0.01, 0.02% × High (LONG) / Low (SHORT)), replacing the price-band table (Ch. 16). (3) **Investment cap:** $20,000 per ticker, replacing 50% of equity; size = MIN(floor($R ÷ R), floor($20,000 ÷ E)); new size table (Ch. 18, 37); journal spreadsheet regenerated. (4) **Hard rules:** candle direction (LONG C > O, SHORT C < O); new-entry window 09:45 to before 15:30 ET (≥ 16:00 or < 09:30 = outside the session); last completed 15m Close vs EMA20 (with the last-completed-candle rule); chase > 0.25 ATR; stale after 10 min; setup failed through the stop; one position or order per ticker (Ch. 9, 13–16, 21, 36). (5) **New Chapter 38** on the app: Trade Calculator and Opportunity Ranker (100-point score; 90/85/80/75 tiers, 85 = minimum to trade; best-score-first allocation; $80k allocatable; 4 positions; 1% heat; correlation cap; pending-order replacement at +5; filled positions never displaced; audit snapshots). Chapters 38–44 renumbered 39–45. (6) Time-of-day guidance: the 15:30–16:00 caution is now a hard rule; observe-only 09:30–09:45 (Ch. 3, 10, 16, 21, 36, 42–44). Portfolio limits (heat 1%, 4 positions, correlation) moved from recommendation to rule (Ch. 18); the 0–2 ranking rubric is replaced by the Opportunity score (Ch. 15, 39). | Rules implemented and unit-tested in the calculator (275 passing tests). All v1.1 values remain paper-testing assumptions, not proven edges | Ranabir |
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |

*Rules for this log:* (1) every change to v1 rules gets a new version number; (2) record the evidence (journal trade count, backtest ID); (3) record software discoveries (VERIFY results) with the date; (4) never change rules mid-session.
