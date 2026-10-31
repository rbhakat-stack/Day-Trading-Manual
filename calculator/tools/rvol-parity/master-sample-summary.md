# RVOL parity study — master-sample

Generated 2026-10-31T06:35:15.497Z from historical Alpaca SIP 5m bars (feed=sip). Diffs are SIP relative to TrendSpider: (SIP − TS) / TS.

Sample rows: 48 · tickers: 20 · days: 2026-10-30, 2026-10-28, 2026-10-29 · SIP computed: 48 · with TrendSpider RVOL: 48 (20 tickers) · pending TrendSpider capture: 0

## Secondary metrics (full sample)

| Statistic | Value |
|---|---|
| Volume diff % (SIP vs TS), mean / median (n=48) | 163.9% / 132.0% |
| Volume diff %, min / max · P90 of absolute | 50.1% / 496.6% · 313.3% |
| Volume within 10% / 20% / 30% / 50% | 0 (0.0%) / 0 (0.0%) / 0 (0.0%) / 0 (0.0%) |
| RVOL diff %, mean / median (n=48) | 12.6% / 5.9% |
| RVOL diff %, min / max | -31.0% / 117.9% |
| RVOL diff %, P90 of absolute | **⚑ 57.1% (> 20%)** |
| RVOL within 5% / 10% / 15% / 20% / 30% | 6 (12.5%) / 15 (31.3%) / 20 (41.7%) / 27 (56.3%) / 35 (72.9%) |
| SIP RVOL above / below TrendSpider | 27 / 21 |
| TrendSpider internally consistent (observed prior SMA only) | 5 of 5 |

## Primary metric — gate agreement (RVOL > 1.5)

| Group | n | PASS/PASS | FAIL/FAIL | TS PASS / SIP FAIL | TS FAIL / SIP PASS | Disagreement |
|---|---|---|---|---|---|---|
| All candles | 48 | 19 | 21 | 4 | 4 | 16.7% |
| **Near threshold (TS RVOL 1.2–2.5)** | 20 | 12 | 4 | 4 | 0 | 20.0% ⚑ > 5% |
| Below threshold (1.2 ≤ TS < 1.5) | 4 | 0 | 4 | 0 | 0 | 0.0% |
| Just above (1.5 ≤ TS < 1.8) | 6 | 4 | 0 | 2 | 0 | 33.3% |
| Moderate pass (1.8 ≤ TS ≤ 2.5) | 10 | 8 | 0 | 2 | 0 | 20.0% |
| Far below (TS < 1.2) | 21 | 0 | 17 | 0 | 4 | 19.0% |
| Far above (TS > 2.5) | 7 | 7 | 0 | 0 | 0 | 0.0% |

TrendSpider RVOL bands inside 1.2–2.5: 1.20–1.39: 3 · 1.40–1.49: 1 · 1.50–1.69: 6 · 1.70–1.99: 4 · 2.00–2.50: 6

## Genuine RB alert candles

| Group | n | PASS/PASS | FAIL/FAIL | TS PASS / SIP FAIL | TS FAIL / SIP PASS | Disagreement |
|---|---|---|---|---|---|---|
| All genuine alerts | 6 | 5 | 0 | 1 | 0 | 16.7% ⚑ > 5% |
| LONG | 5 | 4 | 0 | 1 | 0 | 20.0% |
| SHORT | 1 | 1 | 0 | 0 | 0 | 0.0% |

Median absolute RVOL diff (genuine alerts): 25.6% · test alerts excluded from this subset: 1

## Every gate disagreement

| Date | Ticker | Candle | Alert-linked | Direction | Liquidity | Segment | TS RVOL | SIP RVOL | RVOL diff | Outcome |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-30 | VRSK | 12:25 | YES | LONG | LOW | MIDDAY | 2.009 | 1.413 | -29.7% | TS PASS / SIP FAIL |
| 2026-10-28 | HCA | 15:45 | UNKNOWN | — | LOW | AFTERNOON | 1.536 | 1.393 | -9.3% | TS PASS / SIP FAIL |
| 2026-10-29 | AMD | 09:50 | UNKNOWN | — | HIGH | MORNING | 1.652 | 1.489 | -9.9% | TS PASS / SIP FAIL |
| 2026-10-29 | ROP | 15:15 | UNKNOWN | — | LOW | AFTERNOON | 1.877 | 1.465 | -21.9% | TS PASS / SIP FAIL |
| 2026-10-29 | AEP | 15:30 | UNKNOWN | — | MEDIUM | AFTERNOON | 1.101 | 1.540 | 39.8% | TS FAIL / SIP PASS |
| 2026-10-30 | AVGO | 15:00 | NO | — | HIGH | AFTERNOON | 0.994 | 2.166 | 117.9% | TS FAIL / SIP PASS |
| 2026-10-30 | DLTR | 15:30 | NO | — | MEDIUM | AFTERNOON | 0.975 | 1.633 | 67.5% | TS FAIL / SIP PASS |
| 2026-10-30 | IQV | 15:40 | NO | — | MEDIUM | AFTERNOON | 1.112 | 1.838 | 65.3% | TS FAIL / SIP PASS |

Directional asymmetry: TS PASS / SIP FAIL (false rejection) = 4 of 23 TrendSpider passes (17.4%); TS FAIL / SIP PASS (false validation) = 4 of 25 TrendSpider fails (16.0%).

## By liquidity

| Group | n | Median abs volume diff | Median abs RVOL diff | SIP above / below | Gate disagreement | Near-threshold n | Near-threshold disagreement | Note |
|---|---|---|---|---|---|---|---|---|
| HIGH | 21 | 91.5% | 10.0% | 10 / 11 | 2/21 (9.5%) | 9 | 1/9 (11.1%) |  |
| LOW | 14 | 142.4% | 17.4% | 7 / 7 | 3/14 (21.4%) | 9 | 3/9 (33.3%) |  |
| MEDIUM | 13 | 259.2% | 32.5% | 10 / 3 | 3/13 (23.1%) | 2 | 0/2 (0.0%) |  |

## By time of day

| Group | n | Median abs volume diff | Median abs RVOL diff | SIP above / below | Gate disagreement | Near-threshold n | Near-threshold disagreement | Note |
|---|---|---|---|---|---|---|---|---|
| AFTERNOON | 18 | 174.6% | 22.0% | 12 / 6 | 6/18 (33.3%) | 7 | 2/7 (28.6%) |  |
| MIDDAY | 16 | 144.5% | 19.5% | 11 / 5 | 1/16 (6.3%) | 7 | 1/7 (14.3%) |  |
| MORNING | 14 | 88.6% | 10.4% | 4 / 10 | 1/14 (7.1%) | 6 | 1/6 (16.7%) |  |

## By time of day, VRSK separated

| Group | n | Median abs volume diff | Median abs RVOL diff | SIP above / below | Gate disagreement | Near-threshold n | Near-threshold disagreement | Note |
|---|---|---|---|---|---|---|---|---|
| AFTERNOON | 17 | 180.3% | 21.9% | 11 / 6 | 6/17 (35.3%) | 6 | 2/6 (33.3%) |  |
| MIDDAY | 10 | 146.6% | 17.6% | 8 / 2 | 0/10 (0.0%) | 4 | 0/4 (0.0%) |  |
| MORNING | 14 | 88.6% | 10.4% | 4 / 10 | 1/14 (7.1%) | 6 | 1/6 (16.7%) |  |
| VRSK (all segments) | 7 | 145.6% | 29.6% | 4 / 3 | 1/7 (14.3%) | 4 | 1/4 (25.0%) | DIRECTIONAL ONLY |

## By trading day

| Group | n | Median abs volume diff | Median abs RVOL diff | SIP above / below | Gate disagreement | Near-threshold n | Near-threshold disagreement | Note |
|---|---|---|---|---|---|---|---|---|
| 2026-10-28 | 10 | 148.8% | 11.7% | 7 / 3 | 1/10 (10.0%) | 4 | 1/4 (25.0%) |  |
| 2026-10-29 | 10 | 97.9% | 18.4% | 5 / 5 | 3/10 (30.0%) | 6 | 2/6 (33.3%) |  |
| 2026-10-30 | 28 | 132.0% | 19.5% | 15 / 13 | 4/28 (14.3%) | 10 | 1/10 (10.0%) |  |

## By alert linkage / direction

| Group | n | Median abs volume diff | Median abs RVOL diff | SIP above / below | Gate disagreement | Near-threshold n | Near-threshold disagreement | Note |
|---|---|---|---|---|---|---|---|---|
| GENUINE LONG | 5 | 223.8% | 27.1% | 2 / 3 | 1/5 (20.0%) | 2 | 1/2 (50.0%) | DIRECTIONAL ONLY |
| GENUINE SHORT | 1 | 204.3% | 24.1% | 1 / 0 | 0/1 (0.0%) | 1 | 0/1 (0.0%) | DIRECTIONAL ONLY |
| NON-ALERT | 21 | 124.8% | 17.5% | 12 / 9 | 3/21 (14.3%) | 6 | 0/6 (0.0%) |  |
| TEST ALERT | 1 | 76.2% | 10.0% | 0 / 1 | 0/1 (0.0%) | 1 | 0/1 (0.0%) | DIRECTIONAL ONLY |
| UNKNOWN (no alert history) | 20 | 127.9% | 14.4% | 12 / 8 | 4/20 (20.0%) | 10 | 3/10 (30.0%) |  |

## By ticker

| Group | n | Median abs volume diff | Median abs RVOL diff | SIP above / below | Gate disagreement | Near-threshold n | Near-threshold disagreement | Note |
|---|---|---|---|---|---|---|---|---|
| AAPL | 4 | 79.2% | 6.5% | 1 / 3 | 0/4 (0.0%) | 2 | 0/2 (0.0%) | DIRECTIONAL ONLY |
| AEP | 2 | 216.8% | 46.7% | 2 / 0 | 1/2 (50.0%) | 0 | — | DIRECTIONAL ONLY |
| AMD | 3 | 85.7% | 9.9% | 1 / 2 | 1/3 (33.3%) | 1 | 1/1 (100.0%) | DIRECTIONAL ONLY |
| AMZN | 2 | 82.1% | 4.7% | 1 / 1 | 0/2 (0.0%) | 1 | 0/1 (0.0%) | DIRECTIONAL ONLY |
| AVGO | 2 | 231.7% | 72.5% | 1 / 1 | 1/2 (50.0%) | 0 | — | DIRECTIONAL ONLY |
| DLTR | 3 | 287.5% | 67.5% | 3 / 0 | 1/3 (33.3%) | 1 | 0/1 (0.0%) | DIRECTIONAL ONLY |
| F | 2 | 97.7% | 35.8% | 1 / 1 | 0/2 (0.0%) | 0 | — | DIRECTIONAL ONLY |
| FDS | 2 | 150.6% | 14.1% | 1 / 1 | 0/2 (0.0%) | 1 | 0/1 (0.0%) | DIRECTIONAL ONLY |
| GM | 2 | 202.2% | 8.2% | 1 / 1 | 0/2 (0.0%) | 0 | — | DIRECTIONAL ONLY |
| HCA | 1 | 180.3% | 9.3% | 0 / 1 | 1/1 (100.0%) | 1 | 1/1 (100.0%) | DIRECTIONAL ONLY |
| IBM | 2 | 203.4% | 11.5% | 0 / 2 | 0/2 (0.0%) | 1 | 0/1 (0.0%) | DIRECTIONAL ONLY |
| IQV | 2 | 458.1% | 54.1% | 2 / 0 | 1/2 (50.0%) | 0 | — | DIRECTIONAL ONLY |
| MSCI | 1 | 102.6% | 6.7% | 1 / 0 | 0/1 (0.0%) | 1 | 0/1 (0.0%) | DIRECTIONAL ONLY |
| MSFT | 4 | 109.0% | 12.0% | 3 / 1 | 0/4 (0.0%) | 3 | 0/3 (0.0%) | DIRECTIONAL ONLY |
| NEE | 1 | 204.3% | 24.1% | 1 / 0 | 0/1 (0.0%) | 1 | 0/1 (0.0%) | DIRECTIONAL ONLY |
| NVDA | 1 | 76.2% | 10.0% | 0 / 1 | 0/1 (0.0%) | 1 | 0/1 (0.0%) | DIRECTIONAL ONLY |
| Q | 2 | 262.1% | 27.3% | 2 / 0 | 0/2 (0.0%) | 0 | — | DIRECTIONAL ONLY |
| ROP | 3 | 74.8% | 17.5% | 1 / 2 | 1/3 (33.3%) | 2 | 1/2 (50.0%) | DIRECTIONAL ONLY |
| TRMB | 2 | 80.1% | 22.9% | 1 / 1 | 0/2 (0.0%) | 0 | — | DIRECTIONAL ONLY |
| VRSK | 7 | 145.6% | 29.6% | 4 / 3 | 1/7 (14.3%) | 4 | 1/4 (25.0%) | DIRECTIONAL ONLY |

## Ticker concentration

Largest ticker share: VRSK 7/48 = 14.6% (≤ 20%).
Disagreements by ticker: VRSK: 1, HCA: 1, AMD: 1, ROP: 1, AEP: 1, AVGO: 1, DLTR: 1, IQV: 1.

## Phase 3 evidence flags (decision aids only — no live change)

- Near-threshold disagreement > 5%: **YES (20.0%)**
- Genuine-alert disagreement > 5%: **YES (16.7%)**
- Repeated disagreement in one direction: TS PASS / SIP FAIL 4, TS FAIL / SIP PASS 4 — **YES**
- P90 RVOL error > 20%: **YES (57.1%)**

