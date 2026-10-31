# RB v1.1 vs RB v1.2 (shadow) score replay

Generated 2026-10-31T18:36:12.284Z · Phase 2 master sample, real Alpaca SIP · candles closing ≤ 15:30 · TEST/HYPOTHETICAL rule sets.

## ALL (hypothetical + genuine)

Candidates: 38 · scored in both: 20 · v1.1 unscored → v1.2 scored: 18 · unscored in both: 0

| Delta (v1.2 − v1.1) | min | P10 | median | P90 | max | mean |
|---|---|---|---|---|---|---|
| points | -6.0 | -6.0 | 6.0 | 6.0 | 6.0 | 3.0 |

| Crossing | count |
|---|---|
| v1.1 ≥ 85 → v1.2 < 85 | 0 |
| v1.1 ≥ 90 → v1.2 < 90 | 0 |
| v1.1 < 85 → v1.2 ≥ 85 | 0 |
| v1.1 < 90 → v1.2 ≥ 90 | 0 |
| tier unchanged | 14 |
| tier increased | 3 |
| tier decreased | 3 |

RVOL points v1.1 (SIP bands): 0:13 6:4 9:0 12:3 15:0 · v1.2: always 6

## GENUINE alert-linked

Candidates: 1 · scored in both: 1 · v1.1 unscored → v1.2 scored: 0 · unscored in both: 0

| Delta (v1.2 − v1.1) | min | P10 | median | P90 | max | mean |
|---|---|---|---|---|---|---|
| points | 6.0 | 6.0 | 6.0 | 6.0 | 6.0 | 6.0 |

| Crossing | count |
|---|---|
| v1.1 ≥ 85 → v1.2 < 85 | 0 |
| v1.1 ≥ 90 → v1.2 < 90 | 0 |
| v1.1 < 85 → v1.2 ≥ 85 | 0 |
| v1.1 < 90 → v1.2 ≥ 90 | 0 |
| tier unchanged | 0 |
| tier increased | 1 |
| tier decreased | 0 |

RVOL points v1.1 (SIP bands): 0:1 6:0 9:0 12:0 15:0 · v1.2: always 6

## HYPOTHETICAL, TrendSpider RVOL > 1.5 (would-be alerts)

Candidates: 15 · scored in both: 9 · v1.1 unscored → v1.2 scored: 6 · unscored in both: 0

| Delta (v1.2 − v1.1) | min | P10 | median | P90 | max | mean |
|---|---|---|---|---|---|---|
| points | -6.0 | -6.0 | 0.0 | 6.0 | 6.0 | -0.7 |

| Crossing | count |
|---|---|
| v1.1 ≥ 85 → v1.2 < 85 | 0 |
| v1.1 ≥ 90 → v1.2 < 90 | 0 |
| v1.1 < 85 → v1.2 ≥ 85 | 0 |
| v1.1 < 90 → v1.2 ≥ 90 | 0 |
| tier unchanged | 6 |
| tier increased | 0 |
| tier decreased | 3 |

RVOL points v1.1 (SIP bands): 0:2 6:4 9:0 12:3 15:0 · v1.2: always 6

## HYPOTHETICAL, all

Candidates: 37 · scored in both: 19 · v1.1 unscored → v1.2 scored: 18 · unscored in both: 0

| Delta (v1.2 − v1.1) | min | P10 | median | P90 | max | mean |
|---|---|---|---|---|---|---|
| points | -6.0 | -6.0 | 6.0 | 6.0 | 6.0 | 2.8 |

| Crossing | count |
|---|---|
| v1.1 ≥ 85 → v1.2 < 85 | 0 |
| v1.1 ≥ 90 → v1.2 < 90 | 0 |
| v1.1 < 85 → v1.2 ≥ 85 | 0 |
| v1.1 < 90 → v1.2 ≥ 90 | 0 |
| tier unchanged | 14 |
| tier increased | 2 |
| tier decreased | 3 |

RVOL points v1.1 (SIP bands): 0:12 6:4 9:0 12:3 15:0 · v1.2: always 6

## Phase 3C.1 — threshold options (raw v1.2 scores on the 0–91 scale)

| Grade | v1.1 (share of 100) | exact × 91/100 | A (current) | B_ROUND | B_CEIL |
|---|---|---|---|---|---|
| elite | 90 (90%) | 81.9 | 90 (98.9%) | 82 (90.1%) | 82 (90.1%) |
| high | 85 (85%) | 77.35 | 85 (93.4%) | 77 (84.6%) | 78 (85.7%) |
| watchlist | 80 (80%) | 72.8 | 80 (87.9%) | 73 (80.2%) | 73 (80.2%) |
| low | 75 (75%) | 68.25 | 75 (82.4%) | 68 (74.7%) | 69 (75.8%) |

### GENUINE alert-linked (1 scored in v1.2)

| Candle | Dir | TS RVOL | v1.1 total / tier | v1.2 raw | Δ vs v1.1 | A tier | B_ROUND tier | B_CEIL tier | TS-informed ref (v1.1 grades) | tier changed vs v1.1 (A / BR / BC) |
|---|---|---|---|---|---|---|---|---|---|---|
| VRSK 10-30 12:25 | L | 2.009 | 72 / SKIP | 78 | +6 | LOW | HIGH | HIGH | 81 / WATCH | up / up / up |

| Option | ELITE | HIGH | WATCH | LOW | SKIP | = v1.1 tier (of 1) | up | down | = TS-informed ref tier (of 1) |
|---|---|---|---|---|---|---|---|---|---|
| A_CURRENT | 0 | 0 | 0 | 1 | 0 | 0 | 1 | 0 | 0 |
| B_ROUND | 0 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 |
| B_CEIL | 0 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 |

### HYPOTHETICAL / TEST (37 scored in v1.2)

| Candle | Dir | TS RVOL | v1.1 total / tier | v1.2 raw | Δ vs v1.1 | A tier | B_ROUND tier | B_CEIL tier | TS-informed ref (v1.1 grades) | tier changed vs v1.1 (A / BR / BC) |
|---|---|---|---|---|---|---|---|---|---|---|
| TRMB 10-28 10:40 | L | 3.043 | 80 / WATCH | 80 | +0 | WATCH | HIGH | HIGH | 86 / HIGH | — / up / up |
| VRSK 10-30 12:00 | L | 0.034 | 73 / SKIP | 79 | +6 | LOW | HIGH | HIGH | — / — | up / up / up |
| AAPL 10-29 09:50 | L | 1.295 | 69 / SKIP | 75 | +6 | LOW | WATCH | WATCH | — / — | up / up / up |
| AAPL 10-30 14:30 | S | 0.946 | 67 / SKIP | 73 | +6 | SKIP | WATCH | WATCH | — / — | — / up / up |
| MSCI 10-28 11:25 | L | 1.603 | 73 / SKIP | 73 | +0 | SKIP | WATCH | WATCH | 73 / SKIP | — / up / up |
| GM 10-30 11:00 | L | 0.889 | 66 / SKIP | 72 | +6 | SKIP | LOW | LOW | — / — | — / up / up |
| F 10-29 11:00 | L | 1.003 | 66 / SKIP | 72 | +6 | SKIP | LOW | LOW | — / — | — / up / up |
| MSFT 10-30 13:35 | S | 1.624 | 72 / SKIP | 72 | +0 | SKIP | LOW | LOW | 72 / SKIP | — / up / up |
| AAPL 10-30 10:00 | S | 0.628 | 65 / SKIP | 71 | +6 | SKIP | LOW | LOW | — / — | — / up / up |
| VRSK 10-29 14:00 | S | 2.325 | 77 / LOW | 71 | -6 | SKIP | LOW | LOW | 74 / SKIP | down / — / — |
| TRMB 10-29 12:00 | L | 2.798 | 76 / LOW | 70 | -6 | SKIP | LOW | LOW | 76 / LOW | down / — / — |
| DLTR 10-29 13:35 | L | 1.274 | 64 / SKIP | 70 | +6 | SKIP | LOW | LOW | — / — | — / up / up |
| AMD 10-30 09:40 | S | 2.646 | 76 / LOW | 70 | -6 | SKIP | LOW | LOW | 76 / LOW | down / — / — |
| IBM 10-30 10:30 | S | 0.582 | — / — | 66 | n/a | SKIP | SKIP | SKIP | — / — | new / new / new |
| ROP 10-29 15:15 | L | 1.877 | 60 / SKIP | 66 | +6 | SKIP | SKIP | SKIP | 66 / SKIP | — / — / — |
| VRSK 10-28 13:05 | L | 1.862 | 65 / SKIP | 65 | +0 | SKIP | SKIP | SKIP | 65 / SKIP | — / — / — |
| GM 10-30 13:45 | L | 1.036 | — / — | 63 | n/a | SKIP | SKIP | SKIP | — / — | new / new / new |
| AMD 10-28 09:50 | L | 1.172 | 57 / SKIP | 63 | +6 | SKIP | SKIP | SKIP | — / — | — / — / — |
| AMD 10-29 09:50 | S | 1.652 | — / — | 63 | n/a | SKIP | SKIP | SKIP | 63 / SKIP | new / new / new |
| AEP 10-29 12:15 | S | 0.698 | 57 / SKIP | 63 | +6 | SKIP | SKIP | SKIP | — / — | — / — / — |
| ROP 10-30 10:35 | S | 1.897 | — / — | 62 | n/a | SKIP | SKIP | SKIP | 62 / SKIP | new / new / new |
| AMZN 10-30 15:00 | S | 0.789 | 55 / SKIP | 61 | +6 | SKIP | SKIP | SKIP | — / — | — / — / — |
| VRSK 10-30 12:05 | S | 0.242 | — / — | 57 | n/a | SKIP | SKIP | SKIP | — / — | new / new / new |
| Q 10-28 13:35 | S | 0.429 | — / — | 57 | n/a | SKIP | SKIP | SKIP | — / — | new / new / new |
| AMZN 10-30 09:45 | L | 2.135 | — / — | 55 | n/a | SKIP | SKIP | SKIP | 58 / SKIP | new / new / new |
| VRSK 10-30 12:30 | S | 1.246 | — / — | 55 | n/a | SKIP | SKIP | SKIP | — / — | new / new / new |
| F 10-30 12:45 | L | 0.905 | — / — | 55 | n/a | SKIP | SKIP | SKIP | — / — | new / new / new |
| FDS 10-28 14:05 | L | 0.697 | — / — | 55 | n/a | SKIP | SKIP | SKIP | — / — | new / new / new |
| MSFT 10-30 11:15 | L | 0.44 | — / — | 54 | n/a | SKIP | SKIP | SKIP | — / — | new / new / new |
| AAPL 10-30 12:10 | L | 1.677 | — / — | 54 | n/a | SKIP | SKIP | SKIP | 54 / SKIP | new / new / new |
| NVDA 10-30 14:55 | L | 1.468 | — / — | 52 | n/a | SKIP | SKIP | SKIP | — / — | new / new / new |
| MSFT 10-29 13:30 | S | 1.579 | 46 / SKIP | 52 | +6 | SKIP | SKIP | SKIP | 52 / SKIP | — / — / — |
| VRSK 10-30 12:20 | S | 4.354 | — / — | 51 | n/a | SKIP | SKIP | SKIP | 60 / SKIP | new / new / new |
| DLTR 10-28 13:55 | S | 0.613 | — / — | 51 | n/a | SKIP | SKIP | SKIP | — / — | new / new / new |
| ROP 10-28 14:35 | S | 1.006 | — / — | 51 | n/a | SKIP | SKIP | SKIP | — / — | new / new / new |
| AVGO 10-30 15:00 | L | 0.994 | — / — | 50 | n/a | SKIP | SKIP | SKIP | — / — | new / new / new |
| FDS 10-30 11:20 | S | 2.228 | — / — | 48 | n/a | SKIP | SKIP | SKIP | 51 / SKIP | new / new / new |

| Option | ELITE | HIGH | WATCH | LOW | SKIP | = v1.1 tier (of 19) | up | down | = TS-informed ref tier (of 15) |
|---|---|---|---|---|---|---|---|---|---|
| A_CURRENT | 0 | 0 | 1 | 2 | 34 | 14 | 2 | 3 | 12 |
| B_ROUND | 0 | 2 | 3 | 8 | 24 | 9 | 10 | 0 | 12 |
| B_CEIL | 0 | 2 | 3 | 8 | 24 | 9 | 10 | 0 | 12 |

