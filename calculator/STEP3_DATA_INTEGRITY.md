# RB v1.1 stabilization — Step 3: data integrity (A, D approved; B deferred; C configuration check)

Branch `rb-v1.1-dup-stabilization`, on top of `e37ea8c` (Step 2: D3/D4 and the missed-trigger latch, all retained).
Local only; nothing pushed, merged or deployed.

## A — Signal-candle completeness

**Defect (2026-11-05, 10:05–10:15 ET).** Alpaca returned each 5-minute signal candle while it held only 3–4 of its five
minutes. Example: CARR 10:05:18, stored volume 75,437 = the exact sum of the 10:00–10:02 one-minute bars; close 55.05 =
the 10:02 close. The final bar has 96,626 shares and closes at 54.99. RB accepted the bar because its start time was in
the past. It affected 14 records, 13 of them DATA REVIEW. FCX 10:05:11 passed, but with a ticket built from the partial
candle.

**Rule (implemented).** `src/engine/automation/signalCompleteness.ts` · `verifySignalCandle`. The exact regular-session
candle `[start, start + 5 min)` is final only when all of these hold:
* the 5-minute bar exists at `start`;
* the final minute (`start + 4 min`) is in the 1-minute data;
* every 1-minute bar in the window is on a minute boundary;
* the 5-minute OHLCV equals the 1-minute aggregate: first open, max high, min low, last close and Σ volume.

All 134 final signal candles of 2026-11-04 (83) and 2026-11-05 (51) satisfy this exactly, so there are no false refusals
on those days.

**Behaviour.**

| Situation | Result |
|---|---|
| Candle not final | `DATA_ERROR` with `errorCode = SIGNAL_CANDLE_INCOMPLETE`, a precise reason, no snapshot and no ticket. The bars are not cached. |
| Retries | About 30 s, 60 s and 120 s after each attempt, 4 attempts in total. The server enforces this (`retryGate` in `rb-alerts`): no early or extra attempts from any tab, reload or restart. The client polls it (`automationClient`). |
| Still incomplete after the 4th attempt | `SIGNAL_CANDLE_INCOMPLETE_FINAL`: MANUAL REVIEW and never actionable. |
| A fetch failure while waiting | Keeps the same bounded schedule. |
| Audit | `enrichmentAudit` records every attempt: time, outcome, reason, and the provisional bar and minutes seen. Provisional values are never used for a decision. |
| Snapshot | Only the final, complete snapshot is ever stored, and an OK record stays immutable. `firstProcessedIso` (first attempt) and the alert time, and therefore the 10-minute expiry, never move. |

**Delayed reconstruction (requirement 11).** When the snapshot completes on a retry, the server records
`delayedReconstruction.gap`. The app acts on it as follows:

| Gap status | Evidence | App behaviour |
|---|---|---|
| `CROSSED` | A complete 1-minute bar, or any eligible or odd-lot trade print, at/through the frozen entry (LONG ≥, SHORT ≤) during the delay | Latched as the terminal missed trigger (MISSED) |
| `NOT_CROSSED` | Only from the complete trade record of `[signal end, reconstruction]` | Normal evaluation, still inside the original window |
| `UNVERIFIED` | The trade record is unavailable or incomplete (more than 5 pages, timeout) | No ticket for this alert, ever (fail closed) |

## D — Eligible current-price data

**Defect.** `/v2/stocks/trades/latest` returns the newest print whatever its conditions. BSX 2026-11-04 shows the
problem: derivatively priced and average-price prints on tape A (`4`, `B`) at about 46.31 alternated with the real market
at about 46.45. They drove BSX's live score to 85–87 and produced authorizations before and around the real crossing of
the 46.46 trigger at 13:00:32.323.

**Provider evidence.**
* **Alpaca condition dictionary:** `GET /v2/stocks/meta/conditions/trade?tape=A|B|C`. Codes are tape-specific: `B` is
  Average Price on tapes A/B but Bunched Trade on tape C; `W` is Average Price on tape C.
* **Alpaca market-data FAQ, "How are bars aggregated?":** the per-tape (CTS / UTP) table of conditions that update a
  minute bar's open/close and high/low. Where a print carries several conditions, the strictest rule applies.
* **Massive (Polygon) Conditions & Indicators matrix and the CTA/UTP notes:** used as a cross-check.

**Rule (implemented).** `src/engine/automation/tradeEligibility.ts`.

| Use | Accepted prints |
|---|---|
| Executable price (scoring, chase, missed-trigger check, execution — one price, so they cannot disagree) | Only prints whose every condition updates the minute bar's open/close and high/low on its own tape. Tape A/B: ` ` `F` `L` `X` `O` `5` `6` `K` `E`. Tape C: `@` `F` `L` `X` `O` `5` `6` `K` `B` `Y` `A` `D`. |
| Trigger evidence (conservative) | Eligible prints, plus odd lots (`I`) whose other conditions are all eligible |

* **Always excluded from the executable price:** `I` `4` `B`(A/B) `W` `Z` `U` `T` `C` `N` `R` `H` `P` `V` `7` `G` `Q`
  `M` `9`. The same applies to an unknown tape (only codes eligible on every tape are accepted) and to a print with no
  conditions.
* **Why `T` is excluded:** Alpaca's minute rule includes `T`, but the last-sale rules and Alpaca's close list exclude it.
  Excluding it is the conservative choice.
* **Why odd lots are not the price:** they do not update the consolidated last sale.
* **Why odd lots still count as trigger evidence:** whether a broker stop triggers on them is not established, so an odd
  lot at/through the entry ends the alert (MISSED). It can never create a ticket. VRSK 2026-11-04 shows the case: odd-lot
  ISO prints at 201.26–201.41 from 10:35:12.107 came before the first eligible crossing at 10:35:13.338.
* **Server behaviour:** `netlify/lib/alpaca.ts` · `getLatestTrades`. When the latest print is ineligible, the server
  serves the newest eligible print of the last 5 minutes, searched newest-first in at most 3 pages of 1,000. It records
  `priceSource` and the `skipped` print. If no eligible print is found, or the lookup fails, that symbol gets no price on
  that poll. The result is no ticket for that symbol, fail closed, and other symbols are unaffected. Freshness rules are
  unchanged: the trade must be at most 60 s old and the data at most 5 s old.

## B — RVOL formula (deferred, unchanged)

RB v1.1 calculates RVOL20 as signal volume ÷ SMA20 of regular-session 5-minute volume, with the signal bar included.
TrendSpider's RVOL(20, SMA, 1) uses the SMA of the 20 previous bars.
* On 2026-11-05, TrendSpider's formula reads about 4–25% higher. It decides only AMD 10:05 (1.502) and CAT 10:05 (1.507),
  and only once the candles are complete.
* 14 TrendSpider-qualified alerts still show SIP RVOL < 1.5 with complete candles and TrendSpider's formula. One example
  is CARR 10:05: 0.979, where the prior day's 15:55 closing-auction bar is 32% of the denominator.
* **This is a data-source difference**, consistent with the Phase 2 study (SIP volume +50% to +497% versus TrendSpider).
* **Parity is not claimed.** Settling it needs TrendSpider's own historical volume figures, for example the CARR 5-minute
  volumes from 2026-11-04 14:50 to 2026-11-05 10:05 read from the TrendSpider chart.
* **Status:** formula and 1.5 threshold unchanged. These alerts remain DATA REVIEW under v1.1.

## C — VEEV alert provenance (configuration check; no RB change)

Three webhooks named "RB v1 SHORT Setup", `rule_set` RBTS-S-001, `alert_time` absent (receipt time used):

| Record | Received (ET) | Reconstructed candle (complete SIP) |
|---|---|---|
| `VEEV-S-130509-9ab769` | 2026-11-04 13:05:09 | All 6 LONG conditions pass (RVOL 1.72); 5 of 6 SHORT conditions fail |
| `VEEV-S-133521-ed682c` | 2026-11-04 13:35:21 | All 6 SHORT conditions fail; LONG passes except RVOL 1.41 |
| `VEEV-S-103509-3ac083` | 2026-11-05 10:35:09 | All 6 SHORT conditions fail (bullish 311.44→313.22, RSI 62.7, EMA9 > EMA20, 15m close > EMA20); LONG passes except RVOL 1.26 |

**TrendSpider checks to perform:**
1. Alerts list → show all alerts, including paused, expired, triggered and inactive. Search for symbol VEEV and for
   the text `RBTS-S-001` / `RB v1 SHORT Setup` in alert notes and webhook bodies.
2. For every alert whose note contains the SHORT payload, record:
   * its conditions — check each comparator against the SHORT checklist (Close < VWAP, EMA9 < EMA20, RSI < 45,
     Close < Open, 15m Close < EMA20) for an inverted `>`;
   * its symbol or watchlist — does it include VEEV?
   * its timeframe and extended-hours setting.
3. Open the LONG RB alert(s). Check that their note does not contain the SHORT payload, for example after a duplicate
   or clone.
4. Alert history / log for VEEV at 2026-11-04 ≈13:05:0x and ≈13:35:1x ET, and 2026-11-05 ≈10:35:0x ET: note the alert
   name and ID that fired each time.
5. Look for any other sender to the same webhook URL: another TrendSpider workspace or account, a Strategy Bot, a
   scanner alert, or a per-symbol alert created earlier.
6. When the source is found, fix the note or the conditions, then issue a new rule-set revision (`RBTS-S-002`; never
   reuse an ID) per RB_V1_2_ARCHITECTURE.md §3.2. v1.1's SIP re-check correctly kept all three non-actionable.

## Rollback

* **Data compatibility:** no migration. The new record fields (`errorCode`, `nextAttemptMs`, `enrichmentAudit`,
  `delayedReconstruction`) and quote fields (`conditions`, `tape`, `priceSource`, `skipped`) are optional and ignored by
  `e37ea8c` / `5e96d58`.
* **One caveat:** after a rollback, a record still pending in `DATA_ERROR SIGNAL_CANDLE_INCOMPLETE` is retried by the
  old build's generic rule (at most 3 attempts) WITHOUT the completeness check, which is the pre-Step-3 behaviour. Roll
  back outside market hours, or mark such records for manual review.
* **Production rollback:** republish deploy `6aebdc96` (`5e96d58`).
