# RVOL parity study — pilot-sample

Generated 2026-10-31T05:36:39.674Z from historical Alpaca SIP 5m bars (feed=sip). Diffs are SIP relative to TrendSpider: (SIP − TS) / TS.

Sample rows: 20 · tickers: 12 · SIP computed: 20 · with TrendSpider RVOL: 20 (12 tickers) · with TrendSpider volume: 20

| Statistic | Value |
|---|---|
| Volume diff % (SIP vs TS), mean / median (n=20) | 168.5% / 134.0% |
| Volume diff %, min / max | 63.6% / 470.0% |
| Volume diff %, P90 of absolute | 295.7% |
| Volume within 5% / 10% / 15% / 20% / 30% | 0 (0.0%) / 0 (0.0%) / 0 (0.0%) / 0 (0.0%) / 0 (0.0%) |
| RVOL diff (SIP − TS), mean / median (n=20) | 0.064 / 0.003 |
| RVOL diff %, mean / median | 8.1% / 0.5% |
| RVOL diff %, min / max | -29.7% / 115.1% |
| RVOL diff %, P90 of absolute | 43.5% |
| RVOL within 5% / 10% / 15% / 20% / 30% | 3 (15.0%) / 6 (30.0%) / 6 (30.0%) / 10 (50.0%) / 16 (80.0%) |
| SIP RVOL above / below TrendSpider | 10 / 10 |
| TrendSpider internally consistent (observed prior SMA only) | 5 of 5 |

Hard gate (RVOL > 1.5):

| Outcome | Count |
|---|---|
| AGREE PASS / PASS | 7 |
| AGREE FAIL / FAIL | 12 |
| TS PASS / SIP FAIL | 1 |
| TS FAIL / SIP PASS | 0 |
| Gate disagreement rate | 1 / 20 = 5.0% |

Gate disagreements:

| Ticker | Candle | TS RVOL | SIP RVOL | Outcome |
|---|---|---|---|---|
| VRSK | 12:25 | 2.009 | 1.413 | TS_PASS_SIP_FAIL |

By ticker:

| Group | n | Median volume diff % | Median RVOL diff % | Median abs RVOL diff % | SIP above / below | Gate agree |
|---|---|---|---|---|---|---|
| AAPL | 2 | 91.1% | -3.8% | 11.7% | 1 / 1 | 2/2 |
| MSFT | 1 | 150.0% | 30.3% | 30.3% | 1 / 0 | 1/1 |
| NVDA | 1 | 76.2% | -10.0% | 10.0% | 0 / 1 | 1/1 |
| AMZN | 2 | 82.1% | -3.5% | 4.7% | 1 / 1 | 2/2 |
| AVGO | 1 | 79.4% | -27.1% | 27.1% | 0 / 1 | 1/1 |
| IBM | 2 | 203.4% | -11.5% | 11.5% | 0 / 2 | 2/2 |
| VRSK | 5 | 84.6% | -19.1% | 29.6% | 2 / 3 | 4/5 |
| IQV | 1 | 419.6% | 42.9% | 42.9% | 1 / 0 | 1/1 |
| GM | 2 | 202.2% | 7.1% | 8.2% | 1 / 1 | 2/2 |
| Q | 1 | 223.8% | 22.1% | 22.1% | 1 / 0 | 1/1 |
| NEE | 1 | 204.3% | 24.1% | 24.1% | 1 / 0 | 1/1 |
| F | 1 | 143.3% | 48.2% | 48.2% | 1 / 0 | 1/1 |

By liquidity:

| Group | n | Median volume diff % | Median RVOL diff % | Median abs RVOL diff % | SIP above / below | Gate agree |
|---|---|---|---|---|---|---|
| HIGH | 11 | 100.6% | 1.2% | 15.3% | 6 / 5 | 11/11 |
| MEDIUM | 4 | 252.9% | 11.0% | 22.5% | 2 / 2 | 4/4 |
| LOW | 5 | 84.6% | -19.1% | 29.6% | 2 / 3 | 4/5 |

By price band:

| Group | n | Median volume diff % | Median RVOL diff % | Median abs RVOL diff % | SIP above / below | Gate agree |
|---|---|---|---|---|---|---|
| ≥$300 | 4 | 91.1% | -3.8% | 21.3% | 2 / 2 | 4/4 |
| $100–300 | 12 | 112.7% | -4.2% | 20.6% | 5 / 7 | 11/12 |
| $20–100 | 3 | 204.3% | 15.3% | 15.3% | 2 / 1 | 3/3 |
| <$20 | 1 | 143.3% | 48.2% | 48.2% | 1 / 0 | 1/1 |

By time of day:

| Group | n | Median volume diff % | Median RVOL diff % | Median abs RVOL diff % | SIP above / below | Gate agree |
|---|---|---|---|---|---|---|
| MORNING | 5 | 124.7% | -1.2% | 8.3% | 2 / 3 | 5/5 |
| AFTERNOON | 8 | 152.4% | 0.5% | 18.8% | 4 / 4 | 8/8 |
| MIDDAY | 7 | 143.3% | 15.3% | 29.6% | 4 / 3 | 6/7 |

By alert-linked vs non-alert:

| Group | n | Median volume diff % | Median RVOL diff % | Median abs RVOL diff % | SIP above / below | Gate agree |
|---|---|---|---|---|---|---|
| NON-ALERT | 13 | 124.7% | 1.2% | 17.3% | 7 / 6 | 13/13 |
| ALERT-LINKED | 7 | 204.3% | -0.2% | 24.1% | 3 / 4 | 6/7 |

By VRSK vs rest of sample:

| Group | n | Median volume diff % | Median RVOL diff % | Median abs RVOL diff % | SIP above / below | Gate agree |
|---|---|---|---|---|---|---|
| REST | 15 | 143.3% | 1.2% | 15.5% | 8 / 7 | 15/15 |
| VRSK | 5 | 84.6% | -19.1% | 29.6% | 2 / 3 | 4/5 |

