# RB Authoritative Settings Architecture — Assessment

Research and design only. Nothing here is implemented in the Defect 3 change. Source: production commit `7122934` (deploy `6aee715816e7ee46a30bab41`). Line references are to that commit.

## 1. Summary

- There are **three configuration stores**, all browser `localStorage`. Each is edited on its own screen:

  | Screen | Storage key | Type / defaults |
  |---|---|---|
  | **Settings** | `rbv1.settings.v1` | `RbSettings` — trade construction (`engine/settings.ts`) |
  | **Ranker → Portfolio policy** | `rbv1.ranker.settings.v1` | `RankerSettings` — scoring and portfolio (`engine/ranker/rankerSettings.ts`) |
  | **Live → Automation settings** | `rbv1.automation.config.v1`, plus `rbv1.automation.classifications.v1` | `AutomationConfig` — alert processing and data freshness (`engine/automation/alertDecision.ts:134`), plus sector map |

- The **server** (`netlify/lib/processAlert.ts`) never reads browser settings. It uses the frozen code defaults (`RB_V1_DEFAULTS`, `DEFAULT_SNAPSHOT_CONFIG`, `DEFAULT_AUTOMATION.parity`) and Netlify env feature flags.
- **Strategy-version lock** (`engine/strategyVersion.ts:29-60`): every setting that changes eligibility, sizing or scoring is "core". It is read-only while RB v1.1 is frozen; changing it requires a new named version. Only account equity (both copies) and broker buying power are editable while frozen.
- **The Automation Settings tab contains no capital, risk or portfolio parameter.** Adding them there would duplicate existing fields. Recommendation: **no new Automation Settings fields.**
- **Defects in the current model:**
  1. *Duplicated values*:

     | Value | Copy in Settings | Copy in Ranker |
     |---|---|---|
     | Account equity | `accountEquity` | `portfolio.accountEquity` |
     | Risk per trade | `riskPct` | `riskPerTradePct` |
     | Per-ticker cap | `investmentCap` | `maxPositionValue` |

     Equity can diverge today (Defect 1). Risk % and the cap can diverge only after an unlocked strategy-version change, but nothing prevents it then.
  2. *Settings bypassed by hardcoded defaults*: `alertWindowMinutes`, the entry window and the chase threshold are editable in Settings. But about 15 consumers read `RB_V1_DEFAULTS` directly (lifecycle, ranker peer window, terminal events, ticker reservation, snapshot expiry, server). While frozen the values are equal. After any version change they would silently diverge.
  3. *Browser vs server*: parity tolerances are editable per browser, but the server's v1.2 reconstruction uses `DEFAULT_AUTOMATION.parity` (`processAlert.ts:275`).

## 2. Parameter inventory

Legend: **Edit** = editable while RB v1.1 is frozen. **Core** = strategy-version locked. **Const** = code constant (not user-configurable). **Env** = Netlify environment flag.

### 2.1 Account and sizing

| # | Parameter | Purpose | UI location | Storage key → path | Default | Lock | Consumers (calculation / rule) | Other copies | Can diverge? | Recommended authoritative source | Supabase id |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Account equity | Basis for dollar risk, heat limit, usable capital | Settings "Default account equity"; Ranker → Portfolio policy "Account equity $"; Calculator input (per trade, prefilled) | `rbv1.settings.v1`→`accountEquity`; `rbv1.ranker.settings.v1`→`portfolio.accountEquity`; per-trade form | 100,000 | Edit (both) | Sizing `maxDollarRisk` (`tradeCalculator.ts:227`) via `autoCandidate.ts:36`, `historicalParity.ts:325`. Usable allocation, heat limit, per-trade risk limit (`portfolioAllocator.ts:73,93,94`). Broker-only conservative risk (`App.tsx:338`, `liveQueue.ts:204`). Server reference `calcAtAlert` uses 100,000 (`processAlert.ts:190`) | **2 stores + form** | **YES (Defect 1)** | **One value `account.equity`**, edited in either screen (same value), shown in both. Calculator form prefilled from it; a per-trade override stays local to that calculation | `account.equity` |
| 2 | Broker buying power | Information only | Ranker → Portfolio policy | ranker →`portfolio.brokerBuyingPower` | null | Edit | Display only (`PortfolioBar.tsx:48`); never a budget | — | — | Keep as display. Better: remove the manual field once a verified broker value exists (not today: `/v2/account` is blocked by design) | `account.brokerBuyingPowerNote` (optional) |
| 3 | Risk per trade % | Max loss per trade | Settings "Default risk per trade"; Ranker "Max risk per trade %" | settings→`riskPct`; ranker→`portfolio.riskPerTradePct` | 0.25 % | Core (both) | Sizing (`tradeCalculator.ts:227`). Per-trade hard rule `RISK_LIMIT` (`candidateRanker.ts:268`). Conservative broker-only risk | **2** | Only via an unlocked version change | **One value `strategy.sizing.riskPct`** (owned by Settings; Ranker shows it read-only) | `strategy.sizing.riskPct` |
| 4 | Investment cap (per ticker) | Max notional per position | Settings "Default investment cap"; Ranker "Max single position $" | settings→`investmentCap`; ranker→`portfolio.maxPositionValue` | 20,000 | Core (both) | Sizing `investmentShares` (`tradeCalculator.ts:229`). Fit `sizeOk` (`portfolioAllocator.ts:123`). Broker-entry flag (`portfolioExposure.ts:232`) | **2** | Only via a version change | **One value `strategy.sizing.investmentCap`** (owned by Settings; Ranker shows it read-only) | `strategy.sizing.investmentCap` |

### 2.2 Portfolio policy (Ranker → Portfolio policy — single copy today)

| # | Parameter | Default | Lock | Consumers | Copies | Recommended owner | Supabase id |
|---|---|---|---|---|---|---|---|
| 5 | Max positions (slots) | 4 | Core | `checkFit.slotOk` (`portfolioAllocator.ts:121`), `allocate`, capital-availability score | 1 | Ranker → Portfolio policy | `strategy.portfolio.maxPositions` |
| 6 | Portfolio heat limit % | 1 % ($1,000) | Core | `heatLimit` (`portfolioAllocator.ts:93`), `heatOk`, portfolio-risk score | 1 | Ranker → Portfolio policy | `strategy.portfolio.heatPct` |
| 7 | Liquidity / capital reserve % | 20 % | Core | `usableAllocation` (`portfolioAllocator.ts:73`) | 1 | Ranker → Portfolio policy | `strategy.portfolio.reservePct` |
| 8 | Correlation: max highly correlated per theme / hard block / allow opposite direction | 1 / true / false | Core | `assessCorrelation` (correlation hard rule and score) | 1 | Ranker → Correlation policy | `strategy.correlation.*` |
| 9 | Replacement advantage | 5 pts | Core | Replacement suggestions | 1 | Ranker | `strategy.ranker.replacementAdvantage` |
| 10 | Score weights / bands / time buckets / grades / min candidates for relative | see `rankerSettings.ts:72-106` | Core | Opportunity Score (setup /70 + fit /30), tiers, trade threshold | 1 | Ranker settings (scoring, version-locked) | `strategy.scoring.*` |
| 11 | Min sample for analysis | 30 | Edit (non-core) | Analytics page only | 1 | Ranker | `ui.analytics.minSample` |

### 2.3 Trade construction (Settings — single copy, but bypassed)

| # | Parameter | Default | Lock | Consumers that READ THE SETTING | Consumers that bypass it (read `RB_V1_DEFAULTS`) | Divergence risk | Recommended |
|---|---|---|---|---|---|---|---|
| 12 | Minimum buffer $ / percentage buffer | $0.01 / 0.02 % | Core | `calcBuffer` / entry trigger (`tradeCalculator.ts:182-193`) via `evaluateTrade(…, settings)` | Server `calcAtAlert` (`processAlert.ts:190`) | After a version change, server reference ≠ client | Settings; server receives the active strategy version's values (see §4) |
| 13 | ATR stop multiple | 1.0 | Core | `buildPlan` (`tradeCalculator.ts:214`) | Server reference | same | Settings |
| 14 | Reward / risk multiple | 2 | Core | `buildPlan` target | Server reference | same | Settings |
| 15 | Chase threshold (ATR) | 0.25 | Core | Calculator chase. Ranker `checkChase` via `window` (`liveQueue.ts:123`) | Help and legend texts (`fieldHelp.ts:68-70`), lifecycle wording (`executionState.ts:347-349`), terminal-chase latch thresholds | Wording/latch after a version change | Settings; pass the effective value to the lifecycle and help texts |
| 16 | Entry window start / end (ET) | 09:45 / 15:30 | Core | Calculator. Ranker time rule via `window` | `alertDecision.ts:408` fallback `a.window ?? RB_V1_DEFAULTS`; help texts; server reference | Low (window is passed) | Settings |
| 17 | Alert lifetime (`alertWindowMinutes`) | 10 min | Core | Calculator STALE state | **`freshness()` (`alertDecision.ts:185`), snapshot `expiresAtMs` (`alertTimeSnapshot.ts:90,185`), `executionState.ts:261,312,342`, `observationContinuity.ts:35`, `terminalEvents.ts:79,101,131,158`, `tickerReservation.ts:43`, ranker peer window (`candidateRanker.ts:420`), `queueView.ts:460`** | **HIGH after any version change** — calculator and lifecycle would disagree on expiry | Settings; every consumer must receive the effective value |
| 18 | Timeframe minutes | 5 | Core | Informational conversion (InputPanel) | — | — | Settings (effectively a strategy constant) |
| 19 | Allow pyramiding | false | Core | Same-ticker rule | — | — | Settings |
| 20 | Strategy mode | RB_V1_BREAKOUT | Core (fixed) | — | — | — | Strategy constant (not user-configurable) |

### 2.4 Alert processing and data freshness (Automation Settings — per browser)

| # | Parameter | Default | Lock | Consumers | Copies / divergence | Recommended |
|---|---|---|---|---|---|---|
| 21 | Automated alert mode (enabled) | false | Edit | Whether this browser runs the queue | Per browser | Automation Settings (per user/device) |
| 22 | Micro-batch window / max batch hold | 3 s / 15 s | Edit | Release of alerts for joint ranking (`releasedIds`) | Per browser | Automation Settings |
| 23 | Alert poll / price poll interval | 3 s / 3 s | Edit | Client polling | Per browser | Automation Settings |
| 24 | Max market-data age / max last-trade age | 5 s / 60 s | Edit | STALE DATA gate (no ticket) | Per browser — two browsers can decide differently | Automation Settings, **account-scoped** (one value for all devices) |
| 25 | Price mismatch % / minimum $ | 0.10 % / $0.02 | Edit | TrendSpider-vs-provider mismatch → data review (`liveQueue.ts:199`) | Per browser | Automation Settings, account-scoped |
| 26 | Parity tolerances (price, ATR, EMA, VWAP, RVOL, RSI) and comparisons required | see `alertDecision.ts:171-172` | Edit | Client parity validation | **Server v1.2 reconstruction uses `DEFAULT_AUTOMATION.parity`** (`processAlert.ts:275`) | Account-scoped; the server reads the same value, or the field is labelled "client validation only" |
| 27 | Sector / industry / theme classifications | `KNOWN_CLASSIFICATIONS` + user edits | Edit | Correlation hard rule and score | Per browser (`rbv1.automation.classifications.v1`, plus deleted list) | Account-scoped reference data (not a strategy parameter) |
| 28 | CR-15 client mode | OFF | Edit | Cross-day Journal reconciliation (also server flag) | Per browser | Per device |
| 29 | App access token | — | Secret | API calls | Per browser | **Never** a configuration parameter; superseded by the CR-16 session |

### 2.5 Server feature flags (Netlify env — authoritative, not user-editable in the app)

`RB_AUTH_ENABLED`, `RB_BROKER_SYNC_ENABLED`, `RB_CR15_CROSSDAY_RECONCILIATION_ENABLED`, `RB_REFERENCE_SCORES_ENABLED`, `RB_RVOL_V1_OBSERVATION_ENABLED`, `RB_RVOL_POLICY_A_ENABLED`, `RB_RVOL_POLICY_B_ENABLED`. These are release controls, not trading parameters. Keep them in Netlify env, change them only through the release process, and record the effective values in each snapshot's provenance.

### 2.6 Internal engineering constants (keep as code constants — no operational need to edit)

| Constant | Value | Where |
|---|---|---|
| Broker verification freshness | 120 s | `portfolioExposure.ts:386,423` |
| Order ↔ candidate price tolerance | 2 ¢ | `portfolioExposure.ts:129`, `brokerSync.ts:154` |
| Order-before-mark window | 15 min | `portfolioExposure.ts:148` |
| Cross-day history bound | 5 dates / 10 days | `portfolioExposure.ts:153-154` |
| Open-orders page size | 500 | `alpaca.ts` |
| Snapshot finalize window | 60 s | `alertTimeSnapshot.ts:18` |
| Snapshot retention | 90 days | `alertTimeSnapshot.ts:137` |
| Queue archive age | 12 h | `alertTimeSnapshot.ts:174` |
| Candle retries | 30 / 60 / 120 s | `alertDecision.ts:117` |
| Snapshot data quality | max signal lag 120 s · missing bars 5 % · warm-up 100 bars · session VWAP | `alertSnapshot.ts:52` |
| SIP historical minimum age | 16 min | `historicalParity.ts:49` |
| Payload limit | 4 KB | `alertPayload.ts:13` |
| Policy B conditional minimum score | 80 | `rvolPolicy.ts:47` — a strategy constant of Policy B, versioned with it |
| Audited-registry validity | 30 days | `tsConfigRegistry.ts:19` |
| RVOL proven minimum (v1.2 shadow) | 1.5 | `v12Ranking.ts:27` |

They are documented here so they are not mistaken for duplicates. Promote one to a setting only when there is a genuine operational need, and then version it.

## 3. Recommended architecture

**One configuration model, one resolver, existing screens as editors.**

```
RbConfig (one object, stable ids)
 ├─ account.*          equity, (buying-power note)                editable any time; not part of the strategy fingerprint
 ├─ strategy.*         sizing, construction, portfolio, correlation, scoring, lifetime, windows
 │                     → version-locked; fingerprint = strategy version (RB v1.1 …)
 ├─ operations.*       alert processing, freshness, parity           account-scoped, not strategy
 ├─ reference.*        sector/industry/theme classifications         account-scoped reference data
 └─ device.*           automation on/off, poll intervals, CR-15 mode per browser
effectiveConfig(): RbConfig   ← the ONLY place any calculation reads parameters from
```

| Screen | Edits | Shows read-only |
|---|---|---|
| Settings | `strategy.sizing` (risk %, investment cap), `strategy.construction` (buffers, ATR multiple, R multiple, chase, windows, lifetime), and `account.equity` | — |
| Ranker → Portfolio policy | `strategy.portfolio`, `strategy.correlation`, `strategy.scoring`, and `account.equity` | risk %, investment cap |
| Automation Settings | `operations.*`, `reference.*`, `device.*` | — |

`account.equity` is the same field on two screens; editing either changes the one value.

Rules:

1. **No second copy of a value.** Where two screens show the same parameter, both bind to the same id. Remove `RankerSettings.portfolio.accountEquity`, `.riskPerTradePct` and `.maxPositionValue` as stored values. They become derived views of `account.equity` and `strategy.sizing.*`. The allocator keeps its signature by receiving them from the resolver.
2. **Every consumer receives the effective value as an argument.** Replace each direct `RB_V1_DEFAULTS.*` read in runtime logic (§2.3 #15–17) with the resolved value. Code defaults remain only as initial values and fallbacks.
3. **No retroactive change.** Alert-time snapshots already freeze entry, stop, target, quantity, score and decision, and are never re-scored. Each snapshot (and candidate `initialScore`) also records a `configVersion` reference (strategy version name + config revision id), so audits show which parameters produced them.
4. **The server uses the active strategy version's values**, not browser settings. The frozen strategy definition is versioned in code; the server reads the active version (env or Supabase), never a browser's local edit. Account equity is not used for server decisions; the server reference sizing is display-only and should be labelled "reference: $100k defaults".
5. **Validation lives with the model** (existing `validateSettings` / `validateRankerSettings` merged into one schema), applied on load, on edit and before persistence.

### Do Automation Settings need new fields?

**No.** Capital, risk and portfolio parameters already have a natural single home, so duplicating them on Automation Settings would recreate the problem being fixed. The only candidates I considered are the internal tolerances (broker freshness 120 s, 2 ¢ order match). There is no operational requirement to tune them, so they stay constants.

## 4. Supabase-ready persistence (future phase — not implemented)

| Requirement | Design |
|---|---|
| One authoritative current configuration | `rb_config_current(account_id, param_id, value jsonb, revision bigint, updated_at, updated_by)`, primary key `(account_id, param_id)`. The resolver reads only this, with a local cache. |
| Stable parameter identifiers | The ids in §2 (`account.equity`, `strategy.sizing.riskPct`, …), declared in one TypeScript schema shared by client and server |
| User/account scoping | `account_id` = authenticated principal (CR-16 username today; Supabase auth user later). Row-level security: `account_id = auth.uid()` |
| Strategy-version identification | `strategy.*` params grouped under `rb_strategy_version(name, fingerprint, params jsonb, locked, created_at)`. `rb_config_current.strategy_version` names the active one. Changing a core value creates a new version row (the existing version-lock rule). |
| Strong validation and access control | Server-side validation (Edge Function or Postgres check constraints) using the same schema. RLS. Only the owner writes. Core params writable only through "create new version". |
| Historical snapshots / version references | `rb_config_history(account_id, param_id, old, new, revision, changed_at, changed_by, reason)`, append-only (no UPDATE/DELETE grants). Every alert-time snapshot stores `{strategy_version, config_revision}`. |
| Settings change history | The history table above, plus the existing manual Change Log |
| Browser refresh / cross-session consistency | Load from Supabase on start. Subscribe to changes (realtime) or poll. localStorage is a cache only. |
| Safe migration from localStorage | One-time, explicit, user-confirmed import: read the three stores, map them to ids, show a diff, and **resolve the duplicate equity by asking the user**. Then write revision 1. Keep the localStorage copy read-only as a backup for N days. |
| Explicit conflict resolution | Optimistic concurrency: each write carries the expected `revision`. On mismatch, reject and show both values; never last-write-wins silently. |
| Safe behaviour on sync failure | Keep using the last loaded effective config (cached with its revision) and show "settings unsynchronised". **Block edits to strategy parameters while offline.** Never fall back to code defaults silently for account equity or risk. If no config was ever loaded on this device, withhold tickets (same principle as PORTFOLIO UNVERIFIED). |
| No competing sources of truth | After migration, Supabase is the only writer target. The three localStorage keys become read-only caches (or are removed), and the server reads the same tables. |

## 5. Migration considerations (for the Defect 1 phase)

1. Decide the equity rule for existing browsers where the two copies differ. Recommendation: prompt once and show both values; never pick silently.
2. Strategy fingerprint: `account.equity` is already excluded from the core fingerprint. Merging risk % and the cap into one id must keep `FROZEN_FINGERPRINT` identical, so RB v1.1 stays "FROZEN". Add a test that asserts the fingerprint string is unchanged.
3. Historical candidates and snapshots keep their frozen values. Nothing is re-sized or re-scored.
4. Order of work: (a) introduce `effectiveConfig()` reading the current stores (no behaviour change, golden tests equal); (b) route the bypassed consumers (§2.3) through it (no behaviour change while frozen); (c) merge the equity copies (Defect 1, user-visible); (d) Supabase persistence.
