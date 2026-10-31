# RB v1.1 — Change Log (local, pre-GitHub)

**Live status:** `RB V1.1 — FROZEN FOR PAPER TESTING`. Nothing in this log changes live trading behaviour unless a
record says so explicitly under **Live behaviour changed**.

**Git baseline:** the last commit is `3696669 Add TrendSpider alert automation and live queue`. Everything below is
local and uncommitted until a release package is approved.

**Rules for this log:**
* Every record has a rollback path.
* There are no secrets, tokens, API keys or `.env` values in this file or in `changes/`.

---

## Rollback checkpoint (current)

| Item | State |
|---|---|
| Last safe commit | `3696669`. Live RB v1.1 is identical to it: `alertSnapshot.ts`, `indicators.ts`, `alertDecision.ts`, `liveQueue.ts`, `autoCandidate.ts`, `parity.ts`, `ranker/`, `tradeCalculator.ts`, `rules.ts`, `settings.ts`, `strategyVersion.ts`, `processAlert.ts`, `store.ts` and `trendspider-alert.mts` have zero diff lines |
| Files to restore (CR-001 only) | Apply `changes/2026-10-31-phase1-historical-rvol-parity.patch` in reverse (see CR-001 → Rollback) |
| Files to restore (everything since `3696669`) | See CR-000 → Rollback |
| Research tooling (CR-002 to CR-004) | `tools/rvolParityStudy.ts`, `tools/rvolCandidateFinder.ts` and `tools/rvol-parity/`: delete them to roll back. Nothing imports them. The pre-merge pilot sample is kept at `changes/2026-10-31-phase2-pilot-sample.pre-merge.csv` |
| Config to restore | None. No Netlify environment variable, `netlify.toml`, `.env` or Automation-settings default was changed |
| Storage / schema | No live storage or schema change. Netlify Blobs (`rb-v1-alerts`) is untouched. The diagnostic endpoint's JSON response gained one additive field (`rvolParity`); nothing stores it |
| Browser localStorage | Historical SIP Test state moved from key `rbv1.diagnostics.historicalSip.v2` to `…v3` (CR-001). After a rollback the `v3` key is simply ignored; it can be deleted manually. No other key changed |
| Rollback type | **Code only.** No data or config rollback is needed |

---

## CR-000 — Historical SIP Parity diagnostic (pre-existing local work, recorded retroactively)

| Field | Value |
|---|---|
| Date / time | 2026-10-30 (before this log existed) |
| Phase | Pre-Phase 1 (diagnostic tooling) |
| Objective | An isolated, read-only Historical SIP Parity Test: forced `feed=sip` historical bars, intrabar reconstruction from 1m bars, earliest/latest bracketing, a derived diagnostic ticket, and the payload wiring fix |
| Live behaviour changed | **No** |
| Schema / API changed | Added the endpoint `POST /.netlify/functions/rb-historical-parity` (bearer `RB_APP_ACCESS_TOKEN`, diagnostic only). No change to existing endpoints or stored records |
| Production risk | LOW: an additive, isolated endpoint and UI sub-tab |

**Files:**
* New:
  * `netlify/functions/rb-historical-parity.mts`
  * `netlify/lib/historicalSip.ts`
  * `src/engine/automation/historicalParity.ts`
  * `src/components/live/HistoricalSipTest.tsx`
  * `netlify/__tests__/historicalSip.test.ts`
  * `src/engine/automation/__tests__/historicalParity.test.ts`
  * `src/lib/__tests__/historicalRequest.test.ts`
* Modified:
  * `netlify/lib/alpaca.ts`: additive optional `getBars1`; `getBars5` is unchanged.
  * `netlify/lib/log.ts`: three `historical_test_*` event names.
  * `src/lib/automationClient.ts`: `runHistoricalSip` and `historicalRequestBody`.
  * `src/App.tsx`: the "Historical SIP Test" sub-tab.
  * `src/engine/automation/__tests__/fixtures.ts`: `minuteBars` and `toFive`.
  * `AUTOMATION.md`: section 9.

**Not part of this work, check before committing:**
* `../.gitignore` shows as modified. It was not changed by this work stream; review it separately.
* `alerts-2026-10-30.json` is a user export of production alert records. Do not commit it.

**Tests at the end of CR-000:** 503 passed. Typecheck and build clean.

**Rollback:**
1. Delete the new files listed above.
2. Restore the modified tracked files: `git checkout 3696669 -- netlify/lib/alpaca.ts netlify/lib/log.ts src/lib/automationClient.ts src/App.tsx src/engine/automation/__tests__/fixtures.ts AUTOMATION.md`.
3. Browser: optionally delete the `rbv1.diagnostics.historicalSip.*` keys.

**Proposed commit:** `diagnostic: add isolated Historical SIP parity test with intrabar reconstruction`

---

## CR-001 — Phase 1: Historical SIP RVOL formula parity with TrendSpider

| Field | Value |
|---|---|
| Date / time | 2026-10-31, ≈ 01:00 ET |
| Phase | **Phase 1 — formula parity (Historical SIP diagnostic only)** |
| Objective | Make the diagnostic's RVOL use TrendSpider's empirically validated formula `RVOL(t) = Volume(t) / SMA20(Volume) ending at t−1`, so that RVOL comparisons measure data differences and not a formula difference |
| Live behaviour changed | **No.** The shared `rvol()` (`indicators.ts`) and the live `buildAlertSnapshot` (`alertSnapshot.ts`) are untouched, with zero diff lines. The webhook, queue, decision gate, ranker, calculator, portfolio, journal, storage and strategy version are all untouched |
| Schema / API changed | **Live: no.** The diagnostic endpoint (`rb-historical-parity`) changed in two ways: (a) **additive:** each bound's `snapshot.rvolParity = { formula, currentVolume, baselineBars[], baseline, value, legacy }`; (b) **semantic:** `snapshot.values.rvol` is now the TrendSpider-parity value, not the same-bar value. New diagnostic issue code: `RVOL_PARITY_BASELINE_UNAVAILABLE` (INCOMPLETE, fail closed) |
| Production risk | **LOW.** Diagnostic-only code path. No live module imports it, and a test enforces that |

**Evidence behind the formula.** TrendSpider's own displayed values for six consecutive VRSK completed candles on
2026-10-30, as Volume ÷ the previous candle's SMA20:

| Candle | Volume ÷ previous SMA20 | Result | TrendSpider |
|---|---|---|---|
| 12:00 | 100 ÷ 2,922 | 0.034 | 0.034 |
| 12:05 | 692 ÷ 2,864 | 0.242 | 0.242 |
| 12:10 | 658 ÷ 2,808 | 0.234 | 0.234 |
| 12:20 | 12,177 ÷ 2,797 | 4.354 | 4.354 |
| 12:25 | 6,649 ÷ 3,310 | 2.009 | 2.009 |
| 12:30 | 4,432 ÷ 3,558 | 1.246 | 1.246 |

All six match.

**Formula parity is not data parity.** TrendSpider's volume differs materially from Alpaca SIP: VRSK 12:25 is 6,649
in TrendSpider vs 11,336 in SIP, and 12:30 is 4,432 vs 8,181. No scaling, vendor factor or fitted correction was added.

### Files changed

| File | Reason | Previous behaviour | New behaviour |
|---|---|---|---|
| `src/engine/automation/historicalParity.ts` | The diagnostic's RVOL path | `values.rvol` came from the unchanged `buildAlertSnapshot`, i.e. the shared same-bar `rvol()`: the current, partial candle sits inside its own SMA20 | New diagnostic-only `historicalParityRvol(history5, activeStartMs, currentVolume, legacy)`. The **numerator** is active-candle volume up to the cutoff. The **denominator** is the SMA of the 20 completed regular-session 5m candles before the active candle, so it is frozen for the whole candle. `intrabarSnapshot` sets `values.rvol` to that value, keeps the same-bar value as `rvolParity.legacy`, re-evaluates the `RVOL20 > 1.5` condition on the parity value, and fails closed (`RVOL_PARITY_BASELINE_UNAVAILABLE`) if fewer than 20 baseline candles exist or the baseline is 0. The `RVOL_SEMANTICS_UNDER_VALIDATION` notice text is updated; its code is unchanged. Exports: `RVOL_PARITY_LENGTH`, `RVOL_PARITY_FORMULA`, `RVOL_LEGACY_LABEL`, `ParityRvol` |
| `src/components/live/HistoricalSipTest.tsx` | The UI must show which RVOL is compared | RVOL shown and compared as "RVOL20" with no formula shown | The field is labelled **RVOL20 (TrendSpider-parity)** and the table row **RVOL20 (TrendSpider-parity SIP)**. A new block "TrendSpider-parity SIP RVOL — calculated as `current volume / prior-20-bar SMA`" shows per bound `currentVolume / baseline = value`, the legacy value labelled **LEGACY RB FORMULA — DIAGNOSTIC ONLY** (never compared), and the 20 baseline candles. The browser key changed from `…historicalSip.v2` to `…v3` so that a saved legacy-formula result is never displayed as a parity value |
| `src/engine/automation/__tests__/historicalParity.test.ts` | Two assertions encoded the old same-bar RVOL | Test (6): `values.rvol === rvol(series)[n]`. IBM regression: LATEST `values` deep-equals the completed-candle snapshot | Test (6): `values.rvol === volume / prior-20 SMA` and `rvolParity.legacy === rvol(series)[n]`. IBM: all fields **except RVOL** still deep-equal, plus `legacy` equals the old RVOL and `rvol = volume / baseline` |
| `netlify/__tests__/historicalSip.test.ts` | Same IBM assertion via the server runner | LATEST `values` deep-equals the snapshot | All fields except RVOL deep-equal, and `rvolParity.legacy` equals the old RVOL |
| `src/engine/automation/__tests__/historicalParityRvol.test.ts` (**new**) | The Phase 1 test list | — | 18 tests (listed below) |
| `AUTOMATION.md` | Documentation | Section 9 said RVOL used the unchanged same-bar baseline; the indicators table did not mention the TrendSpider difference | Section 9 describes the parity formula, the frozen denominator, fail-closed behaviour and formula vs data parity. The indicators table notes the known live difference (live unchanged). The limitations list adds odd-lot-only minutes. The browser key is now `v3` |
| `changes/2026-10-31-phase1-historical-rvol-parity.patch` (**new**) | Rollback artefact | — | Exact unified diff of CR-001, applicable in reverse |
| `RB_V1_1_CHANGE_LOG.md` (**new**) | Change management | — | This file |

### Tests added (`historicalParityRvol.test.ts`)
1. The current candle is excluded from its own denominator. A 10× current volume does not move the baseline.
2. The denominator is exactly the previous 20 completed candles. The 21st-back candle has no effect; the 20th-back does; a candle at or after the active start never enters.
3. Fewer than 20 baseline candles, or a zero baseline, gives `null`.
4. Intrabar: the numerator is partial volume up to the cutoff, and the denominator is identical for EARLIEST and LATEST. Only the numerator grows.
5. `RVOL20 > 1.5` is evaluated on the parity value.
6. VRSK 12:00, 12:05, 12:10, 12:20, 12:25 and 12:30 reproduce TrendSpider exactly: 0.034 / 0.242 / 0.234 / 4.354 / 2.009 / 1.246.
7. The legacy formula does **not** reproduce TrendSpider on the same inputs.
8. VRSK real SIP volumes: 12:30 is 8,181 / 8,111 = 1.0086, and 12:25 is 11,336 / 8,021 = 1.4133.
9. Unchanged values: OHLC, volume, ATR, EMA9, EMA20, RSI and VWAP equal the unchanged builder; the 15m values equal the alert-time builder.
10. `values.rvol === rvolParity.value`.
11. The live `buildAlertSnapshot` still uses the same-bar RVOL.
12. The shared `rvol()` keeps its same-bar definition.
13. No live module imports `historicalParity` (source scan of `src/` and `netlify/`).

### Tests run and results (2026-10-31)

| Check | Result |
|---|---|
| `npx vitest run` | **521 passed / 0 failed**, 16 files. Before CR-001: 503 passed, 15 files |
| `npm run typecheck` (`tsc -b --noEmit && tsc -p tsconfig.netlify.json`) | **pass** |
| `npm run build` | **pass**. The bundle contains no Alpaca host and no key header |
| Live-file diff vs `3696669` | **0 lines** (list in the rollback checkpoint) |
| Rollback rehearsal | A scratch copy with the reverse-applied state passed **503 / 503** tests and both typechecks. The patch applied forward reproduces the current files byte-for-byte, ignoring line endings |
| UI check | The Historical SIP Test was rendered with a real VRSK result: the parity row, formula block, legacy label and baseline list all display correctly; no console errors. Seeded browser state was removed afterwards |

### VRSK 2026-10-30 diagnostic RVOL, before and after (real Alpaca SIP, LONG)

| Run | Bound / cutoff | Current volume | Baseline | Before (legacy) | **After (parity)** | TrendSpider |
|---|---|---|---|---|---|---|
| 12:28 (approximate) | EARLIEST 12:28:00 | 10,356 | 8,021 | 1.2845 | **1.2911** | 2.009 |
| 12:28 (approximate) | LATEST 12:29:00 | 10,802 | 8,021 | 1.3362 | **1.3467** | 2.009 |
| 12:29 (approximate) | LATEST 12:30:00, completed 12:25 candle | 11,336 | 8,021 | 1.3976 | **1.4133** | 2.009 |
| 12:34 (approximate) | LATEST 12:35:00, completed 12:30 candle | 8,181 | 8,111 | 1.0284 | **1.0086** | 1.246 |

The formula is now aligned; the remaining gap is the volume data. It is still reported as MISMATCH, and the ±15%
tolerance is unchanged.

### Known limitations
* The diagnostic RVOL baseline uses Alpaca SIP volume. Alpaca omits minutes that contain only odd-lot trades (on VRSK 10:50–12:35, 6,609 of 177,010 shares were missing), and TrendSpider's volume series differs anyway. Phase 2 is meant to measure this.
* The live RB v1.1 RVOL veto still uses the same-bar formula. That is intentional (frozen) and documented in `AUTOMATION.md`.
* The baseline uses regular-session bars, so for candles before 11:05 it reaches into prior-day bars, the same scope as live. TrendSpider's session scope for the first hour is unverified.

### Rollback procedure (CR-001 only)
**Now committed:** CR-001 is commit `e090121`, so the preferred rollback is `git revert e090121`.

Without git history, run this from the **repository root**:
```bash
git apply -R --directory=calculator calculator/changes/2026-10-31-phase1-historical-rvol-parity.patch
```
⚠ Correction (2026-10-31, CP0): the command originally given here (`git apply -R changes/...` run from `calculator/`) silently does **nothing** inside the repository. `git apply` resolves patch paths from the repository root and skips paths outside the current directory. The command above was verified during CP0.

This restores `historicalParity.ts`, `HistoricalSipTest.tsx`, both test files and `AUTOMATION.md`, and deletes
`historicalParityRvol.test.ts`. Then:
* run `npx vitest run`; the expected result is 503 passed;
* optionally delete `changes/` and remove this record;
* browser: optionally delete localStorage `rbv1.diagnostics.historicalSip.v3`.

No config or data steps are needed.

If CR-001 has been committed: `git revert <CR-001 commit>`.

### Proposed Git commit message
```
diagnostic: align historical SIP RVOL denominator with TrendSpider

Historical SIP Test only. RVOL = current-candle volume / SMA20 of the
20 completed 5m candles before it (TrendSpider: SMA20 ending at t-1),
frozen while the candle forms. Legacy same-bar value kept for reference
and labelled LEGACY RB FORMULA - DIAGNOSTIC ONLY. Live RB v1.1 RVOL,
shared rvol() and buildAlertSnapshot unchanged. No volume scaling.
```

---

## CR-002 — Phase 2 (pilot): cross-ticker RVOL / volume parity study tooling

| Field | Value |
|---|---|
| Date / time | 2026-10-31, ≈ 01:15 ET |
| Phase | **Phase 2 — study and measurement only (pilot: 20 candles, 12 tickers)**. Approved by the user: "APPROVED — PROCEED TO PHASE 2" |
| Objective | Measure TrendSpider vs Alpaca SIP volume and RVOL across tickers, liquidity tiers, price bands and times of day, before any architecture decision |
| Live behaviour changed | **No.** No file under `src/` or `netlify/` was changed by CR-002 |
| Schema / API changed | **No** |
| Production risk | **NONE (not deployed).** `tools/` is outside both tsconfig `include`s, outside the Vite entry graph and outside `netlify/functions`. Nothing imports it |

**Files (all new):**

| File | Reason |
|---|---|
| `tools/rvolParityStudy.ts` | Local study tool, run with `npx vite-node tools/rvolParityStudy.ts [sample.csv] [outDir]`. For each sample candle it reads historical SIP 5m bars and reuses the diagnostic's code (`regularSessionBars`, `historicalParityRvol`) to compute: native volume; the SIP Volume SMA20 at the candle, which is what TrendSpider's Volume indicator displays; the prior-20 SMA; and the TrendSpider-parity RVOL. It compares these with any TrendSpider values in the sample and writes a results CSV and a summary. **Read-only:** every request passes `assertHistoricalBarsRequest` (GET `/bars`, `feed=sip`, end ≥ 16 min old). Credentials are read from the local `.env` into memory only and are never printed or written. A blank TrendSpider cell stays blank; nothing is invented |
| `tools/rvol-parity/pilot-sample.csv` | The pilot sample: 20 candles, 12 tickers. The six VRSK TrendSpider values come from the user's chart readings; every other TrendSpider cell is blank, pending capture |
| `tools/rvol-parity/pilot-sample-results.csv` · `pilot-sample-summary.md` | Generated output. Market data only, no secrets |

**Tests run:**
* `npx vitest run`: 521 passed, unchanged.
* `npm run typecheck`: pass.
* The tool ran successfully on 20 of 20 candles, each with 20 baseline bars and no missing SIP candles.

**Known limitations:**
* Only 5 of 20 pilot candles have TrendSpider values (all VRSK). Statistics are not yet cross-ticker.
* The liquidity tier uses the 20-day SIP average daily volume: HIGH ≥ 5M, MEDIUM 1–5M, LOW < 1M shares.
* The tool reads 5m bars only, so minutes with only odd-lot trades are missing from SIP volume, as in the diagnostic.

**Rollback:** delete `tools/rvolParityStudy.ts` and `tools/rvol-parity/`. Code only; no config or data.

**Proposed commit:** `diagnostic: add cross-ticker RVOL parity study tooling`

---

## CR-003 — Phase 2 pilot completed: TrendSpider capture merged, 20-candle study run

| Field | Value |
|---|---|
| Date / time | 2026-10-31, ≈ 01:35 ET |
| Phase | **Phase 2 — study only (pilot complete)**. Phase 3 has **not** started |
| Objective | Merge the user's TrendSpider capture for the 15 pending pilot candles, validate all 20 rows, and run the full volume / RVOL / hard-gate parity analysis |
| Imported workbook | `RB_Phase2_TrendSpider_Capture_2026-10-30.xlsx`, sheet `TrendSpider Capture`, 15 rows. It was read with a merge script kept outside the project; the workbook itself was not copied into the repo |
| Live behaviour changed | **No.** The live-file diff against `3696669` is 0 lines; no file under `src/` or `netlify/` was changed |
| Schema / API changed | **No** |
| Production risk | **NONE (research files only)** |

**Provenance rules applied:**
* `ts_volume`, `ts_sma20` and `ts_rvol` are **observed** values, read from TrendSpider screenshots of the **completed** candle.
* `ts_sma20_prev` carries a new column, `ts_sma20_prev_source`:
  * **OBSERVED** for the 5 VRSK rows, where the previous candle was read separately;
  * **DERIVED** (`ts_volume / ts_rvol`) for the 15 workbook rows.
* Derived prior SMAs are never presented as observed. The TrendSpider self-consistency check runs only on OBSERVED rows, because on derived rows it would be circular.
* Rule (from the user): every TrendSpider value in the statistics must come from the fully completed 5-minute candle. Alert-time or intrabar readings are not mixed in.

**Superseded observation (kept for traceability):**
* IBM 15:50–15:55: the earlier TS RVOL **2.043** came from the IBM alert-time parity readings (earlier context). It was in the pilot sample under CR-002.
* It is **superseded by 1.950**, from the completed-candle screenshot in the workbook, on the user's instruction (2026-10-31).
* No other value conflicted.

**Files changed:**

| File | Change |
|---|---|
| `tools/rvol-parity/pilot-sample.csv` | **Changed.** 15 rows filled from the workbook; IBM 15:50 RVOL changed from 2.043 to 1.95; IBM 15:50 context text cleaned up; new column `ts_sma20_prev_source`. The 5 VRSK rows are unchanged apart from being marked OBSERVED |
| `tools/rvolParityStudy.ts` | **Analysis changes only:** reads `ts_sma20_prev_source` and skips the circular self-check on DERIVED rows; RVOL statistics no longer require a TS volume; adds min/max, P90 of absolute RVOL difference, 30% bands with percentages, an above/below bias count, the PASS/PASS · FAIL/FAIL · TS PASS/SIP FAIL · TS FAIL/SIP PASS matrix with a disagreement rate and every disagreement listed, and alert-linked vs non-alert and VRSK vs rest segments; the time-of-day bands are 09:30–11:30, 11:30–14:00 and 14:00–16:00. The read-only SIP path and its guard are unchanged |
| `tools/rvol-parity/pilot-sample-results.csv` · `pilot-sample-summary.md` | Regenerated |
| `changes/2026-10-31-phase2-pilot-sample.pre-merge.csv` | **New.** The pilot sample exactly as it was before this merge (rollback aid) |

**Headline results (20 candles, 12 tickers, 2026-10-30):**
* **Volume:** SIP is above TrendSpider on every candle, by +64% to +470% (median +134%). None is within 30%.
* **TrendSpider-parity RVOL:** median difference +0.5%, but P90 of the absolute difference is 43.5%. Within 10% / 20% / 30%: 6 / 10 / 16 of 20. SIP is above TS on 10 and below on 10.
* **Hard gate (RVOL > 1.5):** 7 PASS/PASS, 12 FAIL/FAIL, 1 TS PASS/SIP FAIL (VRSK 12:25, a genuine alert candle), 0 TS FAIL/SIP PASS. Disagreement rate 5%.
* **Pilot classification:** B. SIP RVOL is usable only with non-blocking parity warnings; A is ruled out. Confidence is LOW-MODERATE. Expanding the sample, weighted toward candles near the threshold, is recommended.

**Plausibility flags (values not altered):**
* **MSFT 11:15:** the SMA arithmetic implies TrendSpider's 09:35 bar had about 711k shares. SIP's matching bar implies about 1.17M, a similar 0.61 ratio. **Plausible.**
* **F 12:45:** the SMA arithmetic implies TrendSpider's 11:05 bar had about 1.01M shares; SIP implies about 1.44M (ratio 0.70). **Plausible**, but F has the largest RVOL deviation in the sample (+48.2%). Recommend re-checking the screenshot.

**Tests run:**
* `npx vitest run`: 521 passed, unchanged.
* `npm run typecheck`: pass.
* `npm run build`: pass.
* The study tool ran on 20 of 20 candles, all with a full 20-bar SIP baseline.

**Rollback:**
* **To the CR-002 state:** copy `changes/2026-10-31-phase2-pilot-sample.pre-merge.csv` over `tools/rvol-parity/pilot-sample.csv` and rerun the tool. The tool's CR-003 changes only add statistics and are harmless with the old sample.
* **Full rollback:** delete `tools/` (CR-002 and CR-003) and that pre-merge file.
* Code and research data only; no config or production data.

**Proposed commit:** `diagnostic: complete Phase 2 RVOL parity pilot with TrendSpider capture (20 candles)`

---

## Phase 2.5 — TrendSpider webhook capability investigation (read-only, no files changed)

* **Date:** 2026-10-31.
* **Result: C — TrendSpider cannot send material indicator values.**
  * Official placeholders: `%alert_name%`, `%alert_symbol%`, `%alert_note%`, `%price_action_event%`, `%last_price%`, plus `%bot_*%` for Strategy Bots only.
  * There is no OHLC, indicator, 15m or timestamp placeholder.
  * The JS `register_signal` is binary only, and `request.http` is GET-only data intake.
* **Finding:** the TrendSpider Multi-Factor Alerts docs say alerts are checked at the close of the smallest-timeframe candle. Production receipt times (10–18 s after 5m closes) agree.
* **Doc inaccuracy noted, not changed:** the example note in `AUTOMATION.md` uses `{{ticker}}`, which is TradingView syntax; TrendSpider uses `%alert_symbol%`.
* **TrendSpider support questions are open** (none answered yet):
  1. Placeholders for indicator, OHLC or Volume values?
  2. An alert trigger-time placeholder?
  3. Is `%last_price%` the last trade or the candle close?
  4. Is the 15m condition evaluated on the completed or the forming 15m candle?
  5. Is evaluation close-only, or is there an intrabar option?
  6. Can a JS indicator pass numeric values into the webhook body?
  7. Which volume vendor and trade-condition filters does TrendSpider use?

---

## CR-004 — Phase 2 expansion: threshold-weighted sample design and tooling (TrendSpider capture pending)

| Field | Value |
|---|---|
| Date / time | 2026-10-31, ≈ 02:00 ET |
| Phase | **Phase 2 expansion — study only.** Phase 3 has not started |
| Objective | Grow the study from 20 to about 48 completed 5m candles, concentrated where TrendSpider RVOL is 1.2–2.5, across more days, liquidity tiers and sessions |
| Live behaviour changed | **No.** The live-file diff against `3696669` is 0 lines; nothing under `src/` or `netlify/` changed |
| Schema / API changed | **No** |
| Production risk | **NONE (research files only)** |

**Sample-selection rules:**
* **Days:** 2026-10-28 and 2026-10-29 (new), plus 2026-10-30.
* **Candles:** completed 5m candles from 09:40 to 15:50. The 09:30 opening print and the 15:55 closing ramp are excluded.
* **Pool:** 21 tickers, being the RB ranker universe (NVDA, AMD, AVGO, AAPL, MSFT, IBM, NEE, AEP, HCA, DLTR, TRMB), the pilot names (AMZN, IQV, Q, GM, F, VRSK) and low-ADV large caps (MSCI, FDS, ROP, TDY).
* **Liquidity tiers:** unchanged (20-day SIP ADV: HIGH ≥ 5M, MEDIUM 1–5M, LOW < 1M). HCA sits at the LOW/MEDIUM boundary (about 0.96–1.0M), so its tier can differ by date. The thresholds were not changed.
* **Selection proxy:** TrendSpider RVOL is unknown before capture, so candles were chosen on **SIP parity RVOL**. Target counts per band:

  | SIP RVOL band | 1.05–1.35 | 1.35–1.5 | 1.5–1.7 | 1.7–2.0 | 2.0–2.7 | Below 1.05 | Above 2.7 |
  |---|---|---|---|---|---|---|---|
  | Target | 5 | 4 | 5 | 4 | 4 | 3 | 3 |

  The study bands rows by the **captured TrendSpider RVOL**, never by this proxy. Proxy selection biases the sample toward candles where SIP RVOL is in range; that is disclosed and accepted.
* **Spread rules:**
  * rotate day × session;
  * rotate the preferred tier HIGH → MEDIUM → LOW;
  * at most 3 new candles per ticker, and one per ticker per session per day;
  * same-ticker candles at least 30 min apart;
  * seeded, so the selection is reproducible.
* **Result:**
  * **28 new candles, 15 tickers.** By day: 10 / 10 / 8. By tier: 10 HIGH, 9 MEDIUM, 9 LOW. By session: 9 morning, 9 midday, 10 afternoon.
  * 22 of 28 in the near-threshold proxy region.
  * 5 MEDIUM tickers (TRMB, Q, DLTR, AEP, IQV) and 5 LOW (MSCI, VRSK, FDS, ROP, HCA).
  * Largest ticker share in the master: VRSK, 7 of 48 = 14.6%.
* **Genuine alerts:** no genuine RB alert candles for 10-28 or 10-29 are available to this workspace. The capture sheet asks the user to append them from TrendSpider's alert history (alert_linked = YES).

**Files (all under `tools/`):**

| File | Change |
|---|---|
| `tools/rvolCandidateFinder.ts` (**new**) | Selection tool. Guarded, read-only historical SIP 5m bars. Writes the three files below. Refuses to overwrite an existing `master-sample.csv` |
| `tools/rvol-parity/expansion-selection.csv` (**new**) | Selection log, including the SIP proxy RVOL. **Do not open while capturing** |
| `tools/rvol-parity/expansion-capture.csv` (**new**) | **Blind** capture sheet for TrendSpider: date, ticker, candle, and blank `alert_linked`, `direction`, `ts_volume`, `ts_sma20`, `ts_sma20_prev`, `ts_rvol`. No SIP numbers |
| `tools/rvol-parity/master-sample.csv` (**new**) | The 20 pilot rows (with a new `alert_linked` column: YES / TEST / NO; the NVDA local test alert is TEST) plus 28 new rows with TrendSpider columns blank |
| `tools/rvol-parity/master-sample-results.csv` · `master-sample-summary.md` (**new**, generated) | The SIP side for all 48 rows; statistics over the 20 captured rows so far |
| `tools/rvolParityStudy.ts` | **Analysis only:** `alert_linked` support (inferred for older sheets); gate results labelled PASS/PASS, FAIL/FAIL, TS PASS / SIP FAIL, TS FAIL / SIP PASS; the primary near-threshold gate table (1.2–2.5, split 1.2–1.5, 1.5–1.8, 1.8–2.5, plus the far bands and the five TrendSpider sub-bands); a genuine-alert subset (LONG/SHORT, test alerts excluded); false-rejection and false-validation rates; segments by liquidity, session (with VRSK separated), day, alert linkage and ticker, each with near-threshold disagreement and a DIRECTIONAL ONLY note when n < 10; ticker concentration with a > 20% imbalance flag; volume within 10/20/30/50%; Phase 3 evidence flags. The SIP path and guard are unchanged |

**Pilot-only preview (20 rows) from the new tool:**
* Near-threshold disagreement: 1 of 6 (16.7%, flagged).
* Genuine-alert disagreement: 1 of 6 (16.7%, flagged).
* P90 RVOL error: 43.5% (flagged).
* This is not a result for the expansion: the 28 new rows are not captured yet.

**Tests run:**
* `npx vitest run`: 521 passed.
* `npm run typecheck`: pass.
* `npm run build`: pass.
* Live-file diff: 0 lines.

**Rollback:**
* Delete `tools/rvolCandidateFinder.ts`, `tools/rvol-parity/expansion-*.csv` and `tools/rvol-parity/master-sample*`.
* The `rvolParityStudy.ts` changes only add analysis, and the tool still runs on `pilot-sample.csv` (alert linkage is inferred).
* Full Phase 2 rollback: delete `tools/`.
* Code and research data only.

**Proposed commit:** `diagnostic: add threshold-weighted Phase 2 expansion sample and gate metrics`

---

## CR-005 — Phase 2 expansion completed: 28 TrendSpider readings merged, 48-candle study run

| Field | Value |
|---|---|
| Date / time | 2026-10-31, ≈ 02:30 ET |
| Phase | **Phase 2 expansion — study only (complete).** Phase 3 has not started |
| Imported workbook | `RB_Phase2_Expansion_TrendSpider_Capture_28.xlsx`, sheet `Expansion Capture`, 28 rows. It was read with a merge script kept outside the project; the workbook was not copied into the repo |
| Live behaviour changed | **No.** The live-file diff against `3696669` is 0 lines; nothing under `src/` or `netlify/` changed |
| Schema / API changed | **No** |
| Production risk | **NONE (research files only)** |

**Import validation:**
* Exactly 28 rows. All 28 keys (date, ticker, candle) match `expansion-selection.csv`; no duplicates.
* Every row has TS SMA20, TS Volume and TS RVOL.
* Every derived prior SMA is marked DERIVED and equals Volume ÷ RVOL.
* Alert fields were blank as intended. No key conflicted with existing data.

**AAPL correction:** the earlier, incorrect AAPL captures (10-29 12:15 and 10-29 15:30) were never in the selection or the master. The valid rows used are AAPL 10-29 09:50 and AAPL 10-30 12:10, from the corrected workbook.

**Provenance:**
* TS SMA20, Volume and RVOL are OBSERVED, from completed-candle screenshots.
* `ts_sma20_prev` is DERIVED for all 28 new rows (and the 15 pilot workbook rows), and OBSERVED only for the 5 pilot VRSK rows.

**Plausibility flag (value NOT altered):**
* **MSFT 2026-10-30 13:35** is internally impossible. With TS SMA20 83,335, Volume 82,221 and RVOL 1.624 (derived prior SMA 50,629), the SMA identity implies the candle leaving the window had volume **−571,905**.
* Its TS/SIP volume ratio (0.28) is also far below MSFT's other rows (0.40–0.61).
* Most likely one of the three values was read from a different candle.
* **Effect:** it is PASS/PASS, so gate counts are unaffected. Sensitivity run without it: near-threshold disagreement 4 of 19 = 21.1% (vs 4 of 20 = 20.0%), and P90 RVOL error 58.3% (vs 57.1%). **Recommend re-capturing it.**

**Genuine-alert enrichment:**
* The only alert history in the workspace is the 2026-10-30 webhook export (`alerts-2026-10-30.json`). It contains genuine LONG alerts on AVGO 15:55, IBM 15:50, IQV 15:55 and Q 15:55, all already in the pilot rows.
* The pilot also carries two user-classified alert cases: VRSK 12:25 LONG and NEE 15:40 SHORT (not in the webhook export).
* **New 10-30 rows:** alert_linked = NO (that date is covered by the export, with no alert on these candles).
* **All 20 rows from 10-28 and 10-29:** alert_linked = **UNKNOWN**. No alert history for those dates is in the workspace, so nothing was guessed.
* **Genuine alerts identified:** 5 LONG and 1 SHORT. The NVDA local test alert stays TEST.

**Files changed:**

| File | Change |
|---|---|
| `tools/rvol-parity/master-sample.csv` | 28 rows filled with TS values; `ts_sma20_prev_source` = DERIVED; `alert_linked` NO or UNKNOWN as above; context records the workbook name |
| `tools/rvolParityStudy.ts` | **Analysis only:** an UNKNOWN alert linkage is reported as "UNKNOWN (no alert history)" instead of being counted as NON-ALERT |
| `tools/rvol-parity/master-sample-results.csv` · `master-sample-summary.md` | Regenerated (48 of 48 captured) |
| `changes/2026-10-31-phase2-master-sample.pre-merge.csv` (**new**) | The master exactly as it was before this merge (rollback aid) |

**Headline results (48 candles, 20 tickers, 3 days):**
* **Gate:** 19 PASS/PASS, 21 FAIL/FAIL, **4 TS PASS / SIP FAIL**, **4 TS FAIL / SIP PASS**. Disagreement 16.7%.
* **Near threshold (TS RVOL 1.2–2.5):** n = 20, disagreement **20.0%**:

  | TS RVOL band | Disagreement |
  |---|---|
  | 1.2–1.5 | 0 of 4 |
  | 1.5–1.8 | **2 of 6** |
  | 1.8–2.5 | **2 of 10** |

* **Genuine alerts:** 1 of 6 disagree (VRSK 12:25).
* **Late afternoon:** 6 of 8 disagreements are on candles from 15:00 to 15:50. That window has only 10 candles, so its disagreement rate is 60%. Before 15:00 the rate is 2 of 35. All four TS FAIL / SIP PASS cases are from 15:00 to 15:40, with SIP RVOL 40–118% higher.
* **RVOL error:** P90 of the absolute difference is **57.1%**.
* **All evidence flags fire.**
* **Expanded classification: C.** SIP RVOL should not be used to validate TrendSpider RVOL.

**Tests run:**
* `npx vitest run`: 521 passed.
* `npm run typecheck`: pass.
* `npm run build`: pass.
* Live-file diff: 0 lines.

**Rollback:**
* **To the CR-004 state:** copy `changes/2026-10-31-phase2-master-sample.pre-merge.csv` over `tools/rvol-parity/master-sample.csv`, then rerun the study. The tool change only affects one label.
* **Full Phase 2 rollback:** delete `tools/` and the `changes/2026-10-31-phase2-*.csv` files.
* Code and research data only.

**Proposed commit:** `diagnostic: complete Phase 2 expanded RVOL parity study (48 candles, 3 days)`

---

## CR-006 — Phase 2 final correction: MSFT 2026-10-30 13:35 re-captured

| Field | Value |
|---|---|
| Date / time | 2026-10-31, ≈ 03:00 ET |
| Phase | Phase 2 (final data correction), done at the start of Phase 3A. **No Phase 3 code** |
| Live behaviour changed | **No.** The live-file diff is 0 lines |
| Production risk | **NONE (research data only)** |

**The correction** (from the user's re-captured completed-candle screenshot):

| Field | Old | New |
|---|---|---|
| `ts_volume` | 82,221 | **132,221** |
| `ts_sma20` | 83,335 | **83,325** |
| `ts_rvol` | 1.624 | 1.624 (unchanged) |
| `ts_sma20_prev` | 50,629 | 132,221 / 1.624 = **81,416.87**, marked DERIVED |

* No other row was touched (verified by diff).
* The SMA identity now holds: the implied volume of the candle leaving the window is +94,058 (it was −571,905).
* The MSFT volume difference is now +124.8%, in line with MSFT's other rows (63–150%).

**Rerun result:**
* **Phase 2 classification is unchanged: C.**
* Gate counts unchanged: 19 / 21 / 4 / 4.
* Near-threshold disagreement still 4 of 20 = 20.0%.
* P90 RVOL error still 57.1%.
* Median volume difference moved from +141.2% to +132.0%; mean from +166.7% to +163.9%.

**Files:**
* `tools/rvol-parity/master-sample.csv`: the one row.
* `master-sample-results.csv` and `master-sample-summary.md`: regenerated.
* `changes/2026-10-31-phase2-master-sample.pre-msft-fix.csv` (**new**): the master before this fix.

**Rollback:** copy `changes/2026-10-31-phase2-master-sample.pre-msft-fix.csv` over `tools/rvol-parity/master-sample.csv`, then rerun the study.

**Proposed commit** (can be folded into the CR-005 commit): `diagnostic: correct MSFT 2026-10-30 13:35 TrendSpider capture`

**Phase 2 evidence baseline: FROZEN at this state** (48 candles, classification C). Phase 3A is design only; no code was changed.

---

## CR-007 — Phase 3A / 3A.1: RB v1.2 architecture design (documentation only)

| Field | Value |
|---|---|
| Date / time | 2026-10-31, ≈ 03:30 ET |
| Phase | **Phase 3A.1 — architecture hardening. Design only; Phase 3B not started** |
| Objective | Record the approved Architecture B (TrendSpider-qualified signal) with the user's 3A.1 refinements |
| Live behaviour changed | **No.** No file under `src/` or `netlify/` changed; the live-logic diff is 0 lines |
| Schema / API changed | **No** (the audit schema is a proposal only) |
| Production risk | **NONE** |

**Files:**
* `RB_V1_2_ARCHITECTURE.md` (**new**): the full design.

**3A.1 refinements recorded in the design:**
1. **Rule-set trust boundary is a hard prerequisite.**
   * A TrendSpider LONG/SHORT alert-definition audit checklist must be completed from live screenshots.
   * Proposed static `rule_set` IDs: `RBTS-<L|S>-<NNN>`.
   * A code-level registry of audited rule sets.
   * A missing, unknown, retired or direction-conflicting rule set gives NOT QUALIFIED. It never falls back to SIP qualification.
   * Verified: v1.1's payload parser ignores unknown fields, so adding `rule_set` to the alert note later is v1.1-safe.
2. **SIP indicator disagreement is diagnostic only.** AGREE / KNIFE-EDGE / DISAGREE; DISAGREE gives a PARITY WARNING. It never produces DATA REVIEW or NOT ELIGIBLE, however many conditions disagree. DATA REVIEW is limited to data-integrity triggers: ambiguous mapping (> 120 s), missing or impossible signal candle, ATR or history unavailable, more than 5% of bars missing, provider error, corrupted reconstruction, calendar problems, and stale current data.
3. **The RVOL Ranker floor (6/15) is provisional** (shadow mode only). The replay and shadow mode report v1.1 vs v1.2 totals, RVOL contribution, tiers, crossings below 85 and 90, and the delta distribution. Options A–D are decided before promotion. SIP RVOL magnitude is never used.
4. **Kept:** TrendSpider qualification; SIP High, Low and ATR for geometry; unchanged ticket formulas; chase, stale and portfolio controls; the receipt-time mapping (0–60 s ON TIME, 60–120 s DELAYED, > 120 s DATA REVIEW); version dispatch; immutable records; shadow mode; additive audit fields; dual dedupe; no broker execution; Alpaca as market data only; no secrets.
5. **`%last_price%` is out of Phase 3B scope.**
6. **15m:** TrendSpider is authoritative. SIP completed and forming values are captured for diagnostics only.

**Tests run:** none required (documentation only); the live-logic diff was confirmed at 0 lines.

**Rollback:** delete `RB_V1_2_ARCHITECTURE.md` and this entry.

**Proposed commit:** `docs: add RB v1.2 architecture design (TrendSpider-qualified signal)`

---

## Commit plan — EXECUTED as CP0 (2026-10-31, branch `rb-v1.2-phase3b`, not pushed)
CR-000 and CR-001 were split by reverse-applying the Phase 1 patch from the repository root (`--directory=calculator`). The CR-000 state was verified at 503 tests before committing, and the CR-001 state at 521. The CP0 commits are listed in the CP0 record below.

Excluded from CP0:
* `.gitignore`: an unrelated local change (adds `.netlify`).
* `calculator/alerts-2026-10-30.json`: a production alert export.
* `.env`, `.netlify/`, `dist/`: already ignored by git.

---

## CP0 — Rollback baseline before Phase 3B (2026-10-31)

* **Branch:** `rb-v1.2-phase3b`, created from `main` at `3696669`. **Not pushed.**

| Commit | Content |
|---|---|
| `d20a059` | CR-000: Historical SIP Parity Test (diagnostic). 503 tests at this commit |
| `e090121` | CR-001: Phase 1 TrendSpider-parity RVOL in the diagnostic, plus the rollback patch. 521 tests |
| `1fa2d2f` | CR-002/003: Phase 2 study tool and pilot data |
| `704ad66` | CR-004/005/006: Phase 2 expansion tool, 48-candle master, backups |
| *(this commit)* | CR-007 docs: this change log and `RB_V1_2_ARCHITECTURE.md` |

* **Excluded:**
  * `.gitignore`: an unrelated local change (`.netlify`).
  * `calculator/alerts-2026-10-30.json`: a production export.
  * Ignored files: `.env`, `.netlify/`, `dist/`.
* **Secret scan:** before committing, every committed file was checked against the actual `.env` secret values and common key and token patterns. No hits.
* **Rollback to CP0** from any later Phase 3B state: `git revert` the Phase 3B commits, newest first. To go back to before all of this work: `git switch main`; `main` is untouched.
