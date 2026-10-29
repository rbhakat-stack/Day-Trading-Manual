# RB v1 Trade Execution Calculator + Opportunity Ranker

**Calculator rules: RB v1.1 · Opportunity score: RB v1.1**

A local web app for **paper trading**. It answers two separate questions:

1. **Trade Calculator**: is this TrendSpider alert *eligible to trade*, and what are the exact order numbers?
2. **Opportunity Ranker**: among eligible setups, which deserve your limited capital?

It does **not** predict direction, it never claims a high score will win, and it **never sends orders** to
Alpaca, SignalStack, TrendSpider or any broker.

> **Product principle.** *Mathematically calculable* ≠ *eligible to trade*. A setup can have a perfectly valid
> entry, stop, target and quantity and still be **NOT ELIGIBLE** because of time, candle direction, the 15m trend,
> staleness, chasing, or portfolio rules. When in doubt the app says **DO NOT TRADE**: false negatives are
> preferred over false positives during paper testing.

---

## Install, run, test

Requires Node.js 20+ (tested with Node 24).

```bash
cd calculator
npm install
npm run dev          # http://localhost:5173
npm test             # all unit tests
npm run build        # type-check + production bundle in dist/
```

Journal, settings, ranker queue and positions are stored in your browser (localStorage). Use **Journal → Backup JSON** regularly.

## Folder structure

```
calculator/src/
├─ engine/                      ← ALL business logic (pure TypeScript, no UI)
│  ├─ rules.ts                  ← THE central hard-rule hierarchy (codes, labels, priority, time window,
│  │                              candle direction, 15m confirmation, chase, stale, structure, 15m candle)
│  ├─ tradeCalculator.ts        ← formulas + evaluateTrade() (uses rules.ts)
│  ├─ rounding.ts               ← the single price-rounding module
│  ├─ settings.ts / validation.ts / journal.ts / scenarios.ts
│  ├─ ranker/
│  │  ├─ candidateRanker.ts     ← classifyScore() + decide() (central) + rankCandidates()
│  │  ├─ opportunityScorer.ts   ← the 10 scoring components (formulas documented in code)
│  │  ├─ portfolioAllocator.ts  ← capital, reservation, heat, best-first allocation
│  │  ├─ correlationRules.ts · rankerSettings.ts · rankerAnalytics.ts · rankerSamples.ts · opportunityTypes.ts
│  └─ __tests__/ and ranker/__tests__/
├─ components/                  ← UI only (renders engine results; no business logic)
└─ App.tsx
```

---

## Trade Calculator

### Inputs (all required unless marked)

Direction (LONG/SHORT, from the alert, never inferred) · signal candle **O H L C** · **ATR(14)** (5-min) ·
**current price** · **alert time (ET, 24h)** (a **Now** button fills it) · **last completed 15m Close** and
**last completed 15m EMA20** · investment cap ($20,000) · account equity ($100,000) · risk % (0.25%) ·
minutes since alert (optional) · existing position in the ticker.

**Last completed 15m candle.** Use the last *fully completed regular-session* 15-minute candle at the alert time.
Never use the still-forming candle, a post-market candle, or a later one. The app shows which candle to use:
10:07 → 09:45–10:00 · 10:18 → 10:00–10:15 · 14:52 → 14:30–14:45 · 15:29 → 15:00–15:15 (`lastCompleted15mCandle()`).

### Formulas

```
LONG                                         SHORT
B  = MAX($0.01, 0.0002 × H)                  B  = MAX($0.01, 0.0002 × L)
E  = H + B                                   E  = L − B
SR = E − L                                   SR = H − E
AR = 1.0 × ATR                               AR = 1.0 × ATR
R  = MAX(SR, AR)                             R  = MAX(SR, AR)
Stop   = E − R                               Stop   = E + R
Target = E + 2R                              Target = E − 2R

MaxRisk$ = Equity × Risk%                    ($100,000 × 0.25% = $250 — a MAXIMUM, never a target)
Shares   = MIN(FLOOR(MaxRisk$ ÷ R), FLOOR(MaxInvestment ÷ E))      (always rounded DOWN)
PositionValue = Shares × E · MaxPlannedLoss = Shares × R · PotentialGrossProfit = Shares × 2R · Reward:Risk = 2.00
```

**Rounding** (`rounding.ts`): tick = $0.01 at or above $1, $0.0001 below $1. B is rounded to the nearest cent. For cent-priced
H/L that is identical to rounding E = H + B at full precision. R is rounded **up** to the next cent only when ATR
controls (so the stop is never closer than the rule). Shares are always floored.

### Hard rules (central, `rules.ts`) — evaluated in this priority order; **all** failures are listed

| Code | UI label | Rule |
|---|---|---|
| `INVALID_INPUT` | INVALID INPUT | any required input missing or nonsensical; 0 shares |
| `EXISTING_SAME_TICKER_POSITION` | DO NOT ADD — POSITION/ORDER ALREADY EXISTS | one position or pending order per ticker; opposite alert → MANAGE EXISTING TRADE FIRST (never reverse) |
| `INVALID_CANDLE_DIRECTION` | NOT ELIGIBLE — LONG/SHORT SIGNAL CANDLE INVALID | LONG needs Close > Open; SHORT needs Close < Open (a doji fails both) |
| `AFTER_HOURS` | NOT ELIGIBLE — AFTER (or BEFORE) REGULAR SESSION | alert ≥ 16:00 or < 09:30 ET |
| `OUTSIDE_ENTRY_WINDOW` | NOT ELIGIBLE — TOO EARLY / NEW ENTRY WINDOW CLOSED | before 09:45, or at/after 15:30 ET |
| `HTF_CONFIRMATION_FAILED` | NOT ELIGIBLE — 15M TREND CONFIRMATION FAILED | LONG 15m Close ≤ EMA20 · SHORT 15m Close ≥ EMA20 |
| `INVALID_TRADE_STRUCTURE` | INVALID TRADE STRUCTURE | LONG Stop < Entry < Target · SHORT Target < Entry < Stop |
| `RISK_LIMIT` | NOT ELIGIBLE — RISK ABOVE PER-TRADE MAXIMUM | (ranker re-check) |
| `SETUP_FAILED` | NOT ELIGIBLE — SETUP FAILED | price already at/through the planned stop |
| `STALE_SETUP` | NOT ELIGIBLE — STALE SETUP | trigger not crossed within 10 min (2 five-minute candles) |
| `CHASED_SETUP` | NOT ELIGIBLE — DO NOT CHASE | trigger crossed and price > 0.25 ATR beyond entry |
| `NO_POSITION_SLOT` · `CAPITAL_LIMIT` · `PORTFOLIO_HEAT_LIMIT` · `CORRELATION_LIMIT` | BLOCKED — … | ranker portfolio rules |

The time window is checked at the alert time **and** at alert time + minutes since alert (the moment an entry would
happen). 15:30 itself counts as closed, because a minute-resolution "15:30" can be 15:30:59.

**When any hard rule fails** the calculator shows **NOT ELIGIBLE** with every reason. The math stays visible in a
greyed **INVALID — DO NOT PLACE** ticket and in Show Calculation, for learning. **Copy**, **Save as active trade** and
**Send to Opportunity Ranker** are disabled.

### Trigger states (only when every hard rule passes)

* LONG price < E → **BUY STOP**; SHORT price > E → **SELL STOP**. The distance to trigger is informational; chase logic
  does not apply before the trigger is crossed.
* Crossed by ≤ 0.25 ATR → **MARKET — LATE ENTRY REVIEW**. Not a trade until you tick *Use current price as market entry*,
  which **recalculates everything** (SR, R, stop, target, shares, value, loss, profit) from the new entry.
* Limit or pullback orders are never suggested.

---

## Opportunity Ranker

### Decision order (`decide()` — one central function)

1. **Strategy hard rules** (the same `rules.ts` functions, plus the calculator's own result, a chase re-check, the
   duplicate-ticker check and per-trade risk). Any failure → **NOT ELIGIBLE — CANNOT BE RANKED**. The candidate is
   **not scored and not ranked**.
2. **Required inputs** (RVOL, RSI, VWAP, EMA9, EMA20, last completed 15m Close / EMA20, sector). Anything missing →
   **SCORING INCOMPLETE**, with the missing fields listed. No score is fabricated, and missing values are never treated as 0.
3. **Score** = Setup Quality /70 + Portfolio Fit /30 (each capped; total ≤ 100).
4. **Portfolio hard rules** → BLOCKED — NO POSITION SLOT / CAPITAL / PORTFOLIO HEAT / CORRELATED EXPOSURE.
5. **Absolute threshold** (`classifyScore()`), which is applied before any relative ranking:

| Score | Tier | Recommendation |
|---|---|---|
| 90–100 | ELITE — PREFERRED CAPITAL ALLOCATION | **TRADE NOW — ELITE** (if capital is allocated) |
| 85–89 | HIGH PRIORITY — TRADE CONSIDERATION | **TRADE NOW — HIGH PRIORITY** (if capital is allocated) |
| 80–84 | WATCHLIST / RESERVE | not a trade candidate |
| 75–79 | LOW PRIORITY | normally skip |
| < 75 | SKIP — QUALITY BELOW THRESHOLD | — |

6. **Capital allocation**: candidates scoring ≥ 85 are taken **highest score first** (never by arrival order). Each one
   uses up capital, a slot and heat, and counts as a correlation exposure for the candidates below it. Candidates that
   don't fit → **CAPITAL WAITLIST**, or **BLOCKED — CORRELATED EXPOSURE** (correlated with a higher-ranked candidate).
7. **Rank is shown separately** ("Rank #1 of 1 active candidates") from **Eligibility**. A #1 rank never makes a
   below-threshold setup tradeable.

**TRADE NOW** therefore requires: no hard-rule failure · score ≥ 85 · capital · a free slot · heat within limit ·
correlation satisfied · entry still valid · no better candidate takes the slot.

### Scoring components (unchanged formulas; all distances ÷ 5-min ATR; d = +1 LONG / −1 SHORT)

| Component | Max | Rule |
|---|---|---|
| Trend | 15 | sep = d(EMA9−EMA20)/ATR → 0/1/3/5/6 · p20 = d(Price−EMA20)/ATR → 0/1/3/4 · t15 = d(15m Close−15m EMA20)/ATR → 0/2/4/5 · capped at 4 if misaligned |
| RVOL | 15 | <1.5: 0 · 1.5: 6 · 2.0: 9 · 2.5: 12 · ≥3.5: 15 (never more) |
| Momentum | 10 | LONG [55,60) 6 · [60,65) 9 · [65,70) 10 · [70,75) 7 · ≥75 4 · SHORT uses 100 − RSI |
| Candle | 10 | ROUND(10 × (0.5 × body/range + 0.5 × close location)); opposing wick ≥ 50% → 2; wrong colour ≤ 2; H = L → 0 |
| Location | 10 | ext = MAX(dVWAP, dEMA20) in ATR → 10/9/7/5/3/1; −1 if > 1 ATR from EMA9; −ROUND(8 × ATR beyond entry) |
| Time | 10 | 09:45–11:30: 10 · 11:30–14:00: 6 · 14:00–15:30: 8 · outside the window: **hard fail, no score** |
| Capital efficiency | 10 | reward ÷ position value, percentile among ≥ 3 peers → ROUND(2 + 8p); otherwise neutral 6 |
| Capital availability | 8 | ≤ 50% of available: 8 · ≤ 80%: 5 · more: 2 · doesn't fit: 0 |
| Diversification | 7 | none 7 · same sector 4 · same industry/theme allowed 1 · blocked 0 |
| Portfolio risk | 5 | projected heat ÷ limit: ≤ 50% 5 · ≤ 75% 4 · ≤ 90% 3 · ≤ 100% 2 · over 0 |

### Portfolio policy (defaults)

Equity $100,000 · liquidity reserve 20% → **allocatable $80,000** · max position $20,000 · max 4 positions (open + pending) ·
risk per trade 0.25% ($250) · portfolio heat 1% ($1,000) · max 1 highly correlated same-direction position per theme ·
replacement advantage 5 points. **Broker buying power is never the budget.** Pending stop orders reserve capital, so the
same capital cannot be allocated twice.

### Pending-order replacement

If a pending (unfilled) order holds capital and a candidate scoring ≥ 85 beats it by ≥ 5 points (re-scored as if the
pending capital were released), the app shows **STRONGER OPPORTUNITY AVAILABLE** with **KEEP** / **CANCEL & RESERVE**.
Nothing is automatic. **Filled positions are never displaced.** Their stop and target govern them.

### Audit trail and versioning

Every candidate stores frozen snapshots: **initial** (first complete scoring), **entry** (when FILLED) and **final**
(at a terminal status). Each snapshot holds the rules and scoring versions (**RB v1.1**), the full settings, every hard-rule
result, missing inputs, components, total, tier, decision and timestamp. Later rule or weight changes never alter old
decisions. Future rule changes must bump the version (v1.2, v2.0, …).

---

## RB v1.1 paper-testing assumptions (not proven edges)

Every one of these is a hypothesis to validate with the journal and the ranker analytics:

* the 0.02% / $0.01 breakout buffer · the 1.0 ATR minimum stop · the 2R target
* the 0.25 ATR chase limit · the 10-minute (2-candle) stale window
* the 09:45–15:30 entry window and the time-of-day scores (10 / 6 / 8)
* the 15m EMA20 confirmation as a hard rule
* every scoring weight and band (RVOL, RSI, candle, location, trend, time, capital efficiency, availability, diversification, heat)
* the thresholds 90 / 85 / 80 / 75 and the 5-point replacement advantage
* the portfolio policy: 20% reserve, $20k max position, 4 positions, 0.25% risk per trade, 1% heat, 1 correlated position per theme
* "capital efficiency" (reward ÷ position value): with the $20k cap this equals 2R ÷ entry and favours stops that are wide relative to price
* sector / industry / theme labels as a proxy for correlation

## Not in this version (by design)

No broker API, webhooks or automation · no pullback/limit-entry mode · no trailing stops, partial exits or break-even stops.

*Calculations and scores are planning tools, not predictions. Stop orders may fill at prices different from the
trigger. Paper-trading fills may differ from live-market execution.*
