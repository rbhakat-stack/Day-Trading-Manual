# RB v1.2 — Architecture (design only)

| | |
|---|---|
| Status | **DESIGN APPROVED IN DIRECTION (Architecture B), hardened in Phase 3A.1. NOT IMPLEMENTED.** |
| Live system | `RB V1.1 — FROZEN FOR PAPER TESTING`, unchanged |
| Evidence base | Phase 1 (RVOL formula parity), Phase 2 (48-candle TrendSpider vs SIP study, frozen, classification **C**), Phase 2.5 (TrendSpider webhook capabilities) |
| Change log | `RB_V1_1_CHANGE_LOG.md`, entries CR-000 to CR-007 |

---

## 1. Principle

> **TrendSpider qualifies. SIP reconstructs. SIP does not re-qualify. RB constructs the ticket and owns current-state safety.**

Two rules RB must **never** break:

1. **A genuine alert is never rejected because SIP disagrees.** If a TrendSpider alert fires and SIP disagrees on RVOL (or VWAP, EMA, RSI, candle direction or 15m), the alert is **not** rejected.
2. **SIP never creates a setup.** If TrendSpider did not alert and SIP's RVOL (or any indicator) passes, RB does **not** create an RB setup.

**Why:**
* **Phase 2:** TrendSpider and Alpaca SIP use materially different intraday volume series (SIP +50% to +497% versus TrendSpider on all 48 candles). Near-threshold RVOL gate disagreement was **20%**, in both directions, and one genuine alert was falsely rejected.
* **Phase 2.5:**
  * TrendSpider's webhook cannot send its calculated values (OHLC, indicators, RVOL, 15m, timestamp).
  * Multi-Factor Alerts are evaluated at the close of the smallest-timeframe candle, so the signal candle is the just-completed 5m candle.

---

## 2. Layers

| Layer | Owner | Purpose |
|---|---|---|
| **A — Qualification** | TrendSpider (authenticated webhook + recognised `rule_set`) | Establishes that the configured RB LONG or SHORT rule set evaluated TRUE |
| **B — Reconstruction** | Alpaca SIP (historical bars, read-only) | Rebuilds the mapped signal candle (O/H/L/C), ATR14 and diagnostic indicators |
| **C — Trade construction** | RB engine (unchanged formulas) | Buffer, entry, structural stop, ATR minimum risk, target, shares, risk and position caps |
| **D — Current-state safety** | RB + Alpaca live data | Current price and freshness, chase, crossed, stale, entry window, duplicate and pyramiding, portfolio slots, heat, capital, correlation |

---

## 3. Rule-set trust boundary (hard prerequisite)

RB v1.2 treats a webhook as proof that the RB rule set passed **only if** the webhook names a **recognised, audited rule set**.

### 3.1 TrendSpider alert-definition audit checklist

To be completed **from the live TrendSpider alert configuration** (screenshots of each alert's condition editor). Nothing here may be inferred from documentation. Record one checklist per alert (LONG and SHORT), and repeat it whenever an alert is edited.

| # | Item | LONG expected | SHORT expected | Observed (screenshot ref) | ✓ |
|---|---|---|---|---|---|
| 1 | Alert type | Multi-Factor Alert | Multi-Factor Alert | | |
| 2 | Smallest timeframe | 5 min | 5 min | | |
| 3 | 5m Close vs VWAP (and VWAP settings: anchor/session, source, any length) | Close **>** VWAP | Close **<** VWAP | | |
| 4 | EMA9 vs EMA20 (5m, source = close) | EMA9 **>** EMA20 | EMA9 **<** EMA20 | | |
| 5 | RSI (length 14, 5m) | RSI **>** 55 | RSI **<** 45 (the RB v1.1 code's SHORT threshold, `alertSnapshot.ts`; **verify in TrendSpider**) | | |
| 6 | Relative Volume (MA length 20, MA type SMA, Base 1, 5m) | RVOL **>** 1.5 | RVOL **>** 1.5 | | |
| 7 | Candle direction (5m) | Close **>** Open | Close **<** Open | | |
| 8 | 15m confirmation (exact indicator, comparison, source) | 15m Close **>** 15m EMA20 | 15m Close **<** 15m EMA20 | | |
| 9 | Condition logic | ALL conditions combined with AND | ALL with AND | | |
| 10 | "Use ext. hours" | **Off** (regular session only) | **Off** | | |
| 11 | Trigger frequency / repeat setting (once per bar? re-arm?) | record exactly | record exactly | | |
| 12 | Symbols / watchlist covered | record | record | | |
| 13 | Webhook URL target | the production `trendspider-alert` endpoint | same | | |
| 14 | Note (webhook body) exact text, including `strategy`, `symbol` placeholder, `direction`, `alert_name`, `rule_set`, `token` field present | record (token value redacted) | record (redacted) | | |
| 15 | Any **other** filters (price, volume, time of day, market cap, …) | list all, or "none" | list all, or "none" | | |
| 16 | Alert expiry / active window | record | record | | |

Every value marked "expected" is the RB v1.1 rule as written in the manual, and **must be verified, not assumed**. Any difference (for example a SHORT RSI threshold other than 45, or extended hours on) is recorded and becomes part of that rule set's registry entry. A difference from the RB rule needs an explicit decision before the rule set can be trusted.

### 3.2 `rule_set` identifier

* **Payload field:** a static string in the TrendSpider alert note, e.g. `"rule_set":"RBTS-L-001"` and `"rule_set":"RBTS-S-001"`.
* **Format:** `RBTS-<L|S>-<NNN>`, where RBTS means "RB TrendSpider rule set".
  * `L` / `S` is the direction.
  * `NNN` is a zero-padded revision, **incremented on every edit** to that TrendSpider alert's conditions. Revisions are never reused.
* **Deterministic:** one ID identifies exactly one audited configuration. The audit record (checklist, screenshots, date) is stored with the registry entry.
* **Registry:** a constant in v1.2 server/engine code (no environment variable), for example:
  `RBTS-L-001 → { direction: LONG, rulesVersion: "RB v1.2", audited: "YYYY-MM-DD", checklist: "<ref>", active: true }`.
  * Retiring a revision sets `active: false`, which still lets historical records resolve.
  * **Adding or changing an entry is a versioned code change with a change-log record.**

### 3.3 Trust-boundary behaviour

| Webhook condition | v1.1 (active) | v1.2 decision |
|---|---|---|
| Recognised, active `rule_set`, direction matches | unchanged | Enters the **QUALIFIED** path |
| `rule_set` **missing** | unchanged | **NOT QUALIFIED — RULE SET MISSING.** Terminal for this record. No ticket, no candidate, no capital |
| `rule_set` **unknown** or **retired** | unchanged | **NOT QUALIFIED — UNRECOGNISED RULE SET (`<id>`)**. Terminal |
| `rule_set` direction ≠ payload `direction` | unchanged | **NOT QUALIFIED — RULE SET / DIRECTION CONFLICT**. Terminal |
| `test: true` | never stored (unchanged) | never stored |

* An unrecognised alert **never** falls back to SIP re-qualification. That would reintroduce the false rejections, and SIP must never qualify a setup.
* The record is still stored and reconstructed, so the audit trail shows what arrived.
* **v1.1 safety:** v1.1's payload parser ignores unknown fields and stores them in the sanitised payload, so adding `rule_set` to the alert note is harmless to v1.1. Adding it is a TrendSpider configuration change for later approval, made after the audit.

---

## 4. What a qualified alert proves

**Proves** (for a recognised rule set): TrendSpider evaluated the symbol at a 5m close, and every condition in that audited rule set was TRUE on TrendSpider's data:
* Close vs VWAP;
* EMA9 vs EMA20;
* RSI;
* RVOL(20, SMA, 1) > 1.5;
* candle direction;
* 15m confirmation.

**Does not prove:** any numeric value; the exact candle time (it is inferred from receipt); SIP's High, Low or ATR; current price; chase safety; data freshness; portfolio availability; absence of a duplicate.

---

## 5. Source-of-truth matrix

| Field / rule | Source in v1.2 | Role | Blocking? | Diagnostic? | Failure behaviour |
|---|---|---|---|---|---|
| Webhook authenticity (token) | Webhook | Security | Yes | — | 401, not stored |
| Symbol, direction, alert name | TrendSpider webhook | Authoritative | Yes | — | Malformed: rejected at the webhook, not stored |
| `rule_set` | TrendSpider webhook + RB registry | **Trust boundary** | Yes | — | Missing, unknown or conflict: NOT QUALIFIED |
| Receipt time | Netlify receipt | Timing / audit | — | — | Always present |
| Signal candle | RB mapping from receipt time (§7) | Reconstructed | Ambiguous blocks | Yes | Lag > 120 s: DATA REVIEW |
| 5m High, Low | Alpaca SIP | Ticket geometry | **Yes** | Yes | Missing or impossible: DATA REVIEW |
| 5m Close | Alpaca SIP | Chase reference, structure | **Yes** | Yes | Missing: DATA REVIEW |
| 5m Open | Alpaca SIP | Diagnostic | No | Yes | Note |
| ATR14 | Alpaca SIP | Ticket minimum risk | **Yes** | Yes | Unavailable or insufficient history: DATA REVIEW |
| TS conditions (VWAP, EMA, RSI, RVOL, candle, 15m) | **TrendSpider** | Authoritative qualification | — (proved by the alert) | — | — |
| SIP VWAP, EMA9, EMA20, RSI14, candle direction | Alpaca SIP | **Diagnostic** + Ranker scoring inputs (not RVOL) | **No** | Yes | DISAGREE: PARITY WARNING. Unavailable: note (or SCORING INCOMPLETE if the Ranker needs it) |
| SIP Volume, SIP RVOL20 | Alpaca SIP | **Diagnostic only** | **No** | Yes | Note only; never a warning trigger |
| SIP 15m Close / EMA20 (completed **and** forming) | Alpaca SIP | **Diagnostic** | **No** | Yes | DISAGREE: PARITY WARNING. Unavailable: note |
| Entry, stop, target, shares, risk | RB (unchanged formulas) | Calculated | Invalid structure blocks | — | NOT ELIGIBLE |
| Current price + data age | Alpaca live trade | Current state | Yes | — | STALE DATA (refreshing) |
| Chase / crossed | RB | Safety | Yes | — | CHASED (terminal) / TRIGGER CROSSED (manual review) |
| Alert age | RB | Safety | Yes | — | STALE after 10 min (terminal) |
| Entry window 09:45–15:30 ET | RB | Rule | Yes | — | NOT ELIGIBLE |
| Duplicate / pyramiding | RB | Safety | Yes | — | NOT ELIGIBLE (DUPLICATE) |
| Slots, heat, capital, correlation, risk limit | RB portfolio engine | Safety | Yes | — | BLOCKED (can clear) or NOT ELIGIBLE |

---

## 6. Parity model (all diagnostic)

For each TrendSpider-qualified condition, SIP's evaluation is classified using the existing parity tolerances, which are unchanged:

| Class | Definition | Effect |
|---|---|---|
| **AGREE** | SIP gives the same result as TrendSpider | none |
| **KNIFE-EDGE** | SIP disagrees but is within tolerance of the threshold: \|Close−VWAP\| ≤ 0.05% × price · \|EMA9−EMA20\| ≤ 0.05% × price · \|RSI−threshold\| ≤ 2 pts · \|Close−Open\| ≤ $0.02 · \|15m Close−15m EMA20\| ≤ 0.05% × price | neutral note |
| **DISAGREE** | SIP disagrees beyond that margin | **PARITY WARNING** (non-blocking) |

RVOL is **always diagnostic only**: it is never classified into a warning, because the expected disagreement is about 17–20%.

**No number of DISAGREE results ever produces DATA REVIEW or NOT ELIGIBLE.** Warnings are visible flags on a QUALIFIED alert, nothing more. The same applies to manually entered TrendSpider-vs-SIP parity values: in v1.2 they produce warnings. In v1.1 they block.

---

## 7. Signal-candle mapping

`B` = the regular-session 5m boundary at or below the receipt time `R`, on the 09:30 ET grid. `lag = R − B`. The signal candle is `[B − 5 min, B)`.

| Lag | Status | Effect |
|---|---|---|
| 0–60 s | ON TIME | Mapped (observed 10–18 s on 4 production alerts) |
| > 60 s and ≤ 120 s | DELAYED | Mapped, plus a "delivery delayed" warning (non-blocking) |
| > 120 s | AMBIGUOUS | **DATA REVIEW.** It could be a > 5 min delay of the earlier candle; never mapped silently |

* **Boundaries:** a receipt before 09:35:00 has no completed regular-session candle, so it is NOT ELIGIBLE. 16:00:00 + lag maps to 15:55–16:00, which is NOT ELIGIBLE under the entry window but recorded.
* **Clock:** the Netlify clock is assumed NTP-synced. The windows are provisional: recalibrate to the P99 of 30 or more genuine deliveries during shadow mode.
* **Dedupe:** the v1.2 key is `symbol | direction | mapped candle start | rule_set`, so a redelivery of the same candle collapses. **Dual dedupe** stores and checks the v1.1 key (receipt second) as well during the transition.

---

## 8. State machine

**Server (immutable processing state):** `RECEIVED → ENRICHING → RECONSTRUCTED`, or `DATA_ERROR` (retry ≤ 3). A record is immutable once RECONSTRUCTED.

**Client decision (derived at view time, never stored):**

| State | Entry condition | Blocking | Terminal | Next states |
|---|---|---|---|---|
| PROCESSING | Micro-batch open, or enriching | — | No | any |
| NOT QUALIFIED | `rule_set` missing, unknown, retired or in direction conflict | Yes | **Yes** | — |
| NOT ELIGIBLE | Outside session or entry window; duplicate or pyramiding; invalid trade structure; risk-limit breach | Yes | **Yes** | — |
| DATA REVIEW | Any §9 trigger | Yes | No (retry, or provider recovery) | QUALIFIED*, NOT ELIGIBLE |
| QUALIFIED (+ warnings) | Recognised rule set + reconstruction complete + valid ticket | No | No | sub-states below |
| ↳ SCORING INCOMPLETE | A Ranker input is missing (classification, or a SIP scoring input) | Yes (cannot rank) | No | QUALIFIED tiers |
| ↳ WAITING FOR TRIGGER by tier (TRADE NOW ≥ 90 · HIGH PRIORITY ≥ 85 · WATCHLIST) | Price not crossed, data fresh | — | No | SUBMITTED, CROSSED, CHASED, STALE, BLOCKED |
| ↳ TRIGGER CROSSED | Past entry by ≤ 0.25 ATR | Manual review | No | CHASED, STALE |
| ↳ CHASED | Past entry by > 0.25 ATR | Yes | **Yes** | — |
| ↳ STALE | > 10 min since the signal without a trigger | Yes | **Yes** | — |
| ↳ BLOCKED | Slot, heat, capital or correlation | Yes | No | QUALIFIED tiers |
| ↳ STALE DATA | Current quote or last trade too old | Yes (temporary) | No | refresh |
| SUBMITTED → FILLED → CLOSED | User lifecycle (unchanged) | — | CLOSED terminal | — |

Order of evaluation:
1. PROCESSING
2. lifecycle
3. NOT QUALIFIED
4. time window
5. DATA REVIEW
6. duplicate
7. ticket structure
8. current-state safety
9. scoring and portfolio

Parity warnings are attached at QUALIFIED and **never** change the state.

---

## 9. DATA REVIEW triggers (exhaustive)

| Code | Trigger |
|---|---|
| `SIGNAL_MAPPING_AMBIGUOUS` | Receipt lag > 120 s |
| `SIGNAL_CANDLE_MISSING` | The mapped 5m bar is absent from SIP |
| `SIGNAL_CANDLE_INVALID` | Impossible OHLC (H < max(O,C), L > min(O,C), L ≤ 0, non-finite) |
| `ATR14_UNAVAILABLE` / `INSUFFICIENT_HISTORY` | ATR not computable, or fewer than 100 regular-session bars |
| `MISSING_BARS` | More than 5% of today's regular-session bars missing up to the signal candle |
| `DATA_ERROR` | Provider failure after retries |
| `RECONSTRUCTION_INCOMPLETE` | Snapshot absent or corrupted |
| `CALENDAR_UNAVAILABLE` / `MARKET_CLOSED_DAY` / `EARLY_CLOSE_SESSION` | Session validity cannot be established, or a non-standard session |
| `STALE DATA — REFRESHING` (temporary) | Current price unavailable, or older than the freshness limits, when a current-state decision needs it |

Not DATA REVIEW: any indicator disagreement or knife-edge; SIP RVOL; SIP 15m; a delayed (≤ 120 s) delivery. Malformed webhooks are rejected before storage.

## 10. Diagnostic-only warnings

* `PARITY WARNING: <condition> differs` (DISAGREE beyond tolerance)
* `NOTE: <condition> knife-edge`
* `DELIVERY DELAYED (61–120 s)`
* `SIP RVOL x.xx — diagnostic only, not used to validate TrendSpider RVOL`
* `SIP RVOL unavailable`
* `SIP 15m (completed/forming) differs` / `SIP 15m unavailable`
* `SIP VWAP/EMA/RSI unavailable`: a note. It becomes SCORING INCOMPLETE only where the Ranker needs the value.
* manual parity-screen mismatches

---

## 11. Trade ticket (unchanged)

* **LONG:**
  * buffer = max($0.01, 0.02% × signal High)
  * entry = High + buffer
  * R = max(entry − Low, ATR14)
  * stop = entry − R
  * target = entry + 2R
* **SHORT:** the mirror image (buffer on Low; entry = Low − buffer; R = max(High − entry, ATR14)).
* **Shares:** min(floor($250 / R), floor($20,000 / entry)).
* **Inputs:** SIP High, Low and ATR14 of the mapped candle.

No Phase 1–2.5 evidence justifies a change.

---

## 12. RVOL and the Ranker

* **Display:**
  * `TrendSpider RVOL gate: PASS (>1.5)` [TS QUALIFIED];
  * SIP RVOL appears only in the details panel, labelled diagnostic.
  * There is never a numeric "TrendSpider RVOL".
* **Ranker RVOL component (PROVISIONAL):**
  * automated, TrendSpider-qualified candidates receive the v1.1 band value proved by the alert: **6 / 15** ("qualified ≥ 1.5 — magnitude unknown");
  * no magnitude bonus;
  * **never** derived from SIP RVOL magnitude.
* **This floor is provisional**, implemented for shadow mode only, and **not frozen**. During historical replay and shadow mode, report per alert:
  * v1.1 total score, and v1.2 total score;
  * RVOL contribution under each;
  * tier under each;
  * the number crossing below 85 and below 90;
  * the distribution of score deltas (min, P10, median, P90, max).
* **Decide before promotion among:**
  * (A) keep 6/15;
  * (B) rebase the tier thresholds;
  * (C) redistribute the RVOL weight to other components;
  * (D) another normalised scheme.

  Any choice is a core-definition change recorded under RB v1.2.
* **Other components:** the trend, momentum and location components keep their SIP price-based inputs. They are ranking signals, not eligibility. Their parity is monitored in shadow mode.

---

## 13. 15-minute confirmation

* TrendSpider's 15m condition is **authoritative**.
* SIP records both the last **completed** 15m candle and the **forming** 15m value for diagnostics. Neither vetoes.
* Shadow evidence will establish TrendSpider's larger-timeframe semantics. Its docs say "the last calculated data point on the larger time frame".

## 14. `%last_price%`

Out of scope for Phase 3B. It is an optional later enhancement, after TrendSpider support confirms what it represents. If it is ever added, it is audit or warning only, never OHLC Close. Before then, v1.2 must not block on a price mismatch.

---

## 15. Audit record (additive to the v1.1 record)

```
logicVersion: "RB v1.2"
qualification: { source: "TRENDSPIDER", ruleSet: "RBTS-L-001", ruleSetStatus: RECOGNISED|MISSING|UNKNOWN|RETIRED|CONFLICT,
                 rulesAssumedPassed: [...names from the registry...], numericValuesProvided: false }
signalMapping: { receivedMs, boundaryMs, lagSec, candleStartIso, candleEndIso, status: ON_TIME|DELAYED|AMBIGUOUS }
reconstruction: { open, high, low, close, volume, atr14, vwap, ema9, ema20, rsi14, close15mCompleted, ema20_15mCompleted,
                  close15mForming, ema20_15mForming, sipRvol, provenance: "SIP", feed, marketDataThroughIso }
conditionDiagnostics: [{ rule, sipValue, threshold, sipPass, margin, class: AGREE|KNIFE_EDGE|DISAGREE|DIAGNOSTIC_ONLY }]
ticketAtAlert: { entry, stop, target, shares, riskPerShare, plannedRisk }
dataReview: [codes]   warnings: [codes]
dedupeKeys: { v11, v12 }
```

The record is immutable once RECONSTRUCTED. The live decision stays derived at view time. The v1.1 fields are kept unchanged.

---

## 16. Versioning and backward compatibility

* **RB v1.1:** the current frozen implementation. Its gate re-evaluates the six alert conditions on SIP (`ALERT_NOT_REPRODUCED` gives DATA MISMATCH), and its Ranker hard rules check candle direction and 15m from SIP. Its RVOL score comes from SIP bands, and its dedupe key uses the receipt second.
* **RB v1.2:** recognised-rule-set qualification; no SIP re-qualification; the provisional RVOL floor; candle-based dedupe; the DATA REVIEW criteria in §9.

**Why a version bump is required:** eligibility and scoring both change, and `rvolBands` is part of `strategyVersion.coreDefinition`.

**Dispatch:** every record is decided by the logic of its stored version. Nothing is re-scored retroactively.

---

## 17. Security (unchanged or strengthened)

Kept as they are:
* no broker execution;
* Alpaca is market data only;
* no secrets in the browser, logs or Git;
* token authentication;
* dedupe;
* immutable snapshots.

Because the webhook gains authority, **rotate the webhook token at promotion**. Optionally restrict by TrendSpider's documented source IP (3.12.143.24). Both need separate approval.

---

## 18. Rollout

| Step | Content | Gate |
|---|---|---|
| 3B | Implement behind a version flag: v1.1 active, v1.2 **shadow** only | Tests green; live v1.1 behaviour byte-identical |
| 3C | Unit + regression tests; historical replay (stored records + synthetic webhooks for Phase 2 alert candles); Ranker delta report | Review |
| **Prerequisite** | **TrendSpider rule-set audit (§3.1) completed; `rule_set` added to both alert notes (separately approved TrendSpider change)** | Signed checklist |
| 3D | Netlify deploy preview with `test:true` and replayed payloads | Review |
| 3E | Production **shadow**: ≥ 30 genuine alerts, including ≥ 5 SHORT, across ≥ 5 sessions | Acceptance criteria |
| 3F | Promote (flag flip) after explicit approval; rotate the token | Sign-off |
| 3G | Keep v1.1 code permanently, for historical dispatch | — |

**Acceptance criteria:**
* zero ticket-geometry differences where both versions produce a ticket;
* zero v1.2 candidates without an authenticated webhook **and** a recognised rule set;
* every v1.1/v1.2 divergence explained by an expected cause;
* no data-failure regressions;
* ≥ 95% of genuine alerts mapped ON TIME;
* the Ranker floor decision taken;
* user sign-off.

**Rollback triggers:**
* any geometry difference;
* any v1.2 candidate without a qualifying webhook;
* any secret exposure;
* v1.2 QUALIFIED on a record lacking SIP High, Low or ATR.

---

## 19. Testing

* **Tests to write first:**
  * signal mapping: lag 0, 10, 30, 60, 61, 120, 121 s; 09:34:59; 16:00:12; after hours;
  * rule-set trust boundary: recognised, missing, unknown, retired, direction conflict;
  * "SIP disagreement never blocks": all six conditions DISAGREE gives QUALIFIED with warnings;
  * "SIP never manufactures a setup": no code path creates a candidate without a stored, authenticated webhook (behavioural + source scan);
  * ticket formulas unchanged (golden values);
  * every §9 trigger;
  * candle-based dedupe and redelivery; dual dedupe;
  * version dispatch;
  * Ranker floor mode.
* **Regression cases:**
  * **VRSK 10-30 12:25:** SIP RVOL 1.413, so v1.2 must reach QUALIFIED (v1.1 gave DATA MISMATCH).
  * **VRSK knife-edge VWAP:** a note only.
  * **AVGO 10-30 15:00:** no webhook, so nothing exists.
  * **IBM 15:50, NEE 15:40 (SHORT), AVGO, IQV, Q 15:55:** QUALIFIED, then NOT ELIGIBLE (after 15:30).
  * **MSFT 10-30 13:35 (corrected):** diagnostics agree.
  * **NVDA `test:true`:** never stored.
* **Shadow mode:** v1.1 and v1.2 compared per alert. Divergences are classed by cause; the Ranker deltas from §12 are reported; the lag distribution and the 15m completed/forming split are recorded.

---

## 20. Rollback

| Checkpoint | State | Rollback |
|---|---|---|
| CP0 | Pre-3B baseline: CR-000 to CR-007 committed as small commits (needs approval) | `git revert` per commit |
| CP1…n | Each Phase 3B step as its own commit | `git revert <step>` |
| CP-shadow | Deployed with v1.2 shadow only | Redeploy CP0, or turn the shadow flag off. v1.1 is unaffected |
| CP-promote | Flag flipped to v1.2 | Flip the flag back to v1.1. No secret or environment change. v1.2 records stay for forensics. Dual dedupe prevents redelivery gaps. New browser keys only, so v1.1 keys are untouched |

---

## 21. Files expected to change in Phase 3B

**New:**
* `src/engine/automation/v12/ruleSets.ts` (registry)
* `src/engine/automation/v12/signalMapping.ts`
* `src/engine/automation/v12/qualification.ts` (parity classes; trust boundary)
* `src/engine/automation/v12/decideAlertV12.ts`
* tests under `src/engine/automation/v12/__tests__/`

**Changed:**
* `src/engine/automation/autoCandidate.ts`: versioned mapping, RVOL provenance.
* `src/engine/ranker/opportunityScorer.ts` and `src/engine/ranker/rankerSettings.ts`: an `rvolMode: BANDS | QUALIFIED_FLOOR` setting.
* `src/engine/rules.ts` and `src/engine/strategyVersion.ts`: the RB v1.2 definition.
* `src/engine/automation/liveQueue.ts`: version dispatch and shadow evaluation.
* `netlify/lib/processAlert.ts` and `netlify/lib/store.ts`: additive v1.2 fields and dual dedupe.
* `src/engine/automation/alertPayload.ts`: read `rule_set`; the v1.2 dedupe key.
* `src/components/live/LiveQueuePage.tsx`, the Ranker table and explanation components, and `src/components/live/AutomationSettings.tsx`: shadow column, badges, version flag.
* `AUTOMATION.md`, the manual (alert-check chapters), and `RB_V1_1_CHANGE_LOG.md`.

**Not edited:**
* `tradeCalculator.ts`
* `indicators.ts`
* `alertSnapshot.ts`
* `trendspider-alert.mts` (beyond what `processAlert` needs)

---

## 22. Unresolved questions

1. **The actual TrendSpider LONG and SHORT alert configurations.** The §3.1 audit is the blocker for meaningful shadow mode and for promotion.
2. Whether TrendSpider's 15m condition uses the completed or the forming 15m value. Shadow-mode diagnostics will tell.
3. What `%last_price%` represents (deferred).
4. The delivery-lag distribution: n = 4 so far, so the 60 s / 120 s windows are provisional.
5. The final Ranker RVOL policy (§12).
6. Genuine-alert evidence is thin (6 alerts, 1 SHORT). Shadow mode adds more.
7. The seven TrendSpider support questions from Phase 2.5 (see the change log).
8. Follow-up outside 3B: the Historical SIP diagnostic's intrabar mode predates the candle-close finding; a completed-candle mode would make it consistent with v1.2.

---

## 23. Implementation notes — Phase 3B steps 1–5 (clarifications, not deviations)

1. **Module names.**
   * The trust boundary lives in `v12/ruleSets.ts`.
   * Parity classification lives in `v12/parityDiagnostics.ts` (§21 planned it as `qualification.ts`).
   * Two modules were added: `v12/audit.ts` (audit schema, integrity codes) and `v12/dispatch.ts`.
2. **Dedupe during shadow mode.**
   * v1.1 is still active, so the v1.2 key is **recorded, not enforced**.
   * A record whose v1.2 key already exists is stored exactly as v1.1 would store it. Its audit gets `duplicateOf`, and the v1.2 shadow decision treats it as DUPLICATE.
   * "Check both keys" (§7) applies from promotion onward.
3. **Entry window.** v1.2 evaluates the window on the **mapped signal-candle close** (when TrendSpider evaluated the alert). v1.1 evaluates it on the receipt time.
4. **Scoring before step 6.**
   * The v1.1 ranker gives no score after a SIP candle or 15m hard fail, and keeps records with any snapshot issue out of allocation.
   * Until the v1.2 ranking pass exists, the v1.2 decision uses the v1.1 ranking only when neither applies. Otherwise it reports **QUALIFIED — SCORE PENDING**, with no ticket.
5. **Waived SIP vetoes.** The shared calculator's `INVALID_CANDLE_DIRECTION` and `HTF_CONFIRMATION_FAILED` hard rules re-check TrendSpider conditions on SIP. For qualified alerts they are waived and reported as `SIP_VETO_WAIVED:*` warnings. The calculator itself is unchanged, and the ticket is its unchanged plan.
6. **Reconstruction source.**
   * v1.2 reuses the v1.1 snapshot's values: the same mapped candle and the same bars.
   * The v1.1 snapshot drops all values when *any* indicator is unavailable, so in that rare case (zero-volume history, or missing 15m bars) v1.2 reports `RECONSTRUCTION_INCOMPLETE`, not an indicator note.
   * **To resolve before promotion:** an independent v1.2 geometry reconstruction.
7. **`alert_time` in the payload.** TrendSpider never sends it. If a manual payload carries one, the v1.1 snapshot candle can differ from the v1.2 receipt-mapped candle. That is flagged `SIGNAL_CANDLE_MISMATCH` (integrity, DATA REVIEW).
8. **Server stamping.** New records keep `versions.strategy = RB v1.1` (`ACTIVE_LOGIC_VERSION`). Promotion changes that constant, and is a separate approval.

---

## 24. Implementation notes — Phase 3B step 6 (ranker, shadow only)

1. **Opt-in mechanism.**
   * An optional `Candidate.qualification` (TrendSpider source, rule set, proven RVOL minimum, waived rules) replaces the `rvolMode` setting planned in §21.
   * Only the v1.2 shadow builder sets it, on non-persisted copies of v1.1 candidates. v1.1 candidates and saved Ranker settings are untouched.
   * `rankerSettings.ts` is unchanged.
2. **Waived calculator state.**
   * The shared calculator's `INVALID_CANDLE_DIRECTION` and `HTF_CONFIRMATION_FAILED` are removed on the v1.2 copy.
   * The action and ready flag are re-derived with the calculator's own branch rules: not crossed → stop order (ready); crossed within the chase limit → `MARKET_LATE_ENTRY`; any other fail → not ready.
   * The plan is the calculator's, unchanged.
3. **Scoring ceiling.** With the provisional floor, the maximum achievable score is 91 (6 + 85). This is the main input to the Phase 3C scoring decision.
4. **Reconstruction dependency, and the smallest proposed Phase 3C fix.**
   * `buildAlertSnapshot` marks `RVOL20_UNAVAILABLE` as INCOMPLETE, so the snapshot has no values. There is then no v1.1 candidate, and so no v1.2 candidate, although v1.2 scoring does not use RVOL.
   * VWAP, EMA, RSI and 15m remain genuinely required by the existing trend, location and momentum components.
   * **Proposal:**
     * Add an optional `SnapshotConfig.optionalIndicators` (default empty, so v1.1 is unchanged). The v1.2 server audit calls the unchanged builder a second time with `['RVOL20']` optional.
     * Store those values as `v12.reconstruction`.
     * Build v1.2 candidates from `v12.reconstruction` when the v1.1 candidate is absent.
   * This is one optional config field in a shared file, so it needs approval.

## 25. Phase 3C.1 — RVOL-optional reconstruction (implemented, shadow only)

Implements the §24.4 proposal, with two small refinements that do not change the architecture:

1. **Snapshot builder.**
   * `SnapshotConfig.optionalIndicators?: readonly OptionalIndicator[]`. The type allows only `'RVOL20'`, so VWAP, EMA, RSI, ATR and 15m cannot be made optional.
   * Absent or empty means RB v1.1 behaviour. The default config has no such key, so stored v1.1 snapshots are byte-identical: 108 builder outputs matched the pre-change builder exactly.
   * When RVOL20 is optional and unavailable, `values.rvol` is NaN (null after JSON storage), never a defaulted number. The RVOL alert-condition re-check is omitted, not reported as failed. No issue is added; the v1.2 parity diagnostics already report `SIP_UNAVAILABLE:RVOL`.
2. **Audit.**
   * The server rebuilds the snapshot RVOL-optional **only** when the v1.1 snapshot lost its values and `RVOL20_UNAVAILABLE` is among the reasons (`needsRvolOptionalSnapshot`).
   * **Refinement 1:** the whole rebuilt snapshot is stored as `v12.rvolOptionalSnapshot`, not just values copied into `reconstruction`. Integrity checks (signal-candle match, history, gaps) therefore run on the same structure as for v1.1.
   * `reconstruction` and `dataReview` are derived from it. Any other missing input still leaves the rebuild incomplete, so DATA REVIEW applies as before.
3. **Decision and queue.**
   * `decideAlertV12` checks integrity on `v12Snapshot(rec)`: the rebuild when present, else the v1.1 snapshot.
   * **Refinement 2:** `buildQueue` creates a shadow-only v1.2 candidate with the unchanged `candidateFromRecord` / `liveState` on a record copy that carries the rebuilt snapshot. This applies only to records that have no v1.1 candidate, are released and OK, and are not duplicates. The candidate is never added to the returned `candidates` and is never persisted.
   * The v1.1 record, candidate, ranking and decision are unchanged (tested).
4. **Known shadow-only nuance.** A v1.2-only candidate does not block a later v1.1 candidate for the same ticker. v1.1 cannot see it, by design.

## 26. Phase 3C.1 — score-threshold calibration (analysis; nothing adopted)

**Code:** `v12/v12Thresholds.ts` (pure, tested). It is not wired into any decision; the shadow ranking still uses the RB v1.1 grades (Option A).

* **Qualified maximum:** Σw − w.rvol + floor × w.rvol / 15. At default weights that is 100 − 15 + 6 = **91**.

| Grade | v1.1 | share | exact × 0.91 | A (share of 91) | B_ROUND | B_CEIL |
|---|---|---|---|---|---|---|
| Elite | 90 | 90 % | 81.9 | 90 (98.9 %) | 82 (90.1 %) | 82 (90.1 %) |
| High (trade minimum) | 85 | 85 % | 77.35 | 85 (93.4 %) | 77 (84.6 %) | 78 (85.7 %) |
| Watchlist | 80 | 80 % | 72.8 | 80 (87.9 %) | 73 (80.2 %) | 73 (80.2 %) |
| Low | 75 | 75 % | 68.25 | 75 (82.4 %) | 68 (74.7 %) | 69 (75.8 %) |

* **Rounding.** Default-weight scores are integers. B_CEIL therefore classifies every score exactly like the unrounded proportional thresholds (tested 0–91) and never asks for a smaller share than v1.1. B_ROUND is one point looser at High (77) and Low (68).
* **Lower tiers must move with the upper tiers.** Rebasing only High and Elite (77/82) leaves Watchlist at 80, above High. `validateRankerSettings` rejects that, and WATCHLIST becomes unreachable.
* **What proportional rebasing assumes.** A v1.1 threshold T is "neutral" for a qualified alert whose true TrendSpider-RVOL band is b when the v1.2 threshold is T − (b − 6):

  | True RVOL band | Neutral High / Elite |
  |---|---|
  | NORMAL (6) | 85 / 90 (= Option A) |
  | ELEVATED (9) | 82 / 87 |
  | STRONG (12) | 79 / 84 |
  | EXCEPTIONAL (15) | 76 / 81 |

  * B_CEIL (78/82) corresponds to b ≈ 13 to 14.
  * The six genuine alerts' captured TS RVOL averages b ≈ 11.5, giving a neutral of ≈ 79.5 / 84.5.
  * The 23 qualified-RVOL candles of the threshold-weighted sample average b ≈ 9.1, giving ≈ 81.9 / 86.9. This is biased low by design.
  * So B is the **permissive** end of the evidence, and A is the strict end.
* **Replay** (`tools/rvol-parity/v12-score-replay-summary.md`):
  * The genuine VRSK alert scores 78. That is LOW under A and HIGH under both B variants, but its TS-informed reference is 81 / WATCHLIST.
  * Across the 15 hypothetical candles with TS RVOL > 1.5, A and B match the reference tier equally often (12 of 15).
* **Recommendation:** use B_CEIL for **shadow testing only**, with A recorded alongside it, and decide after genuine shadow alerts. Before promotion, capture TrendSpider RVOL for genuine alerts so the TS-informed reference can be measured. See the CR-010 report.

## 27. Step 7 — Option B shadow thresholds and the shadow-only UI (implemented, local preview only)

1. **Thresholds.** `V12_SHADOW_GRADES = 82 / 78 / 73 / 69` (B_CEIL), fixed and frozen.
   * It is not a user setting and is not used by RB v1.1. `shadowRanking` ranks v1.2 copies with these grades, so v1.2 allocation also uses them. Weights, bands and raw scores are unchanged.
2. **Option A retained.** Every v1.2 score summary records:
   * the raw total;
   * `tierOptionB` (= `tier`, which drives the shadow decision);
   * `tierOptionA` (the active v1.1 grades);
   * both threshold sets;
   * `v11Total` and `deltaVsV11`.
3. **Comparison log.** `freezeShadowScores` keeps the first complete v1.2 score per alert. It is frozen and stored locally under `rbv1.v12.shadowLog.v1`, with CSV export from the queue header. It is calibration data only and is never read back into a decision.
4. **Labels.** The v1.2 decision texts read the shadow thresholds, e.g. "below the v1.2 shadow trade threshold (78)". The v1.1 texts and section titles are unchanged.
5. **UI.**
   * **Version legend:** RB v1.1 is the active decision; RB v1.2 SHADOW is comparison only.
   * **Queue column:** "RB v1.2 shadow" shows the raw score and Option B tier, or NOT QUALIFIED with the rule-set state, plus WARNING / DATA REVIEW flags only.
   * **Details panel:**
     * Option A tier and the RB v1.1 score with Δ;
     * both threshold lines;
     * `TrendSpider RVOL Gate: PASS (>1.5)`, shown only when qualified;
     * `SIP RVOL: X.XX — diagnostic only` or `unavailable — non-blocking`;
     * qualification and rule set, and signal mapping;
     * SIP parity diagnostics and integrity codes;
     * provenance badges: TS QUALIFIED, SIP, RB, SHADOW, WARNING, DATA REVIEW.
   * No v1.2 ticket values, copy button or action are offered.
6. **Local preview.** `tools/preview/v12-shadow.html` (vite dev only) renders the real queue page with synthetic records and the TEST rule sets `RBTS-L-TEST` / `RBTS-S-TEST`. The production build contains no TEST data, and `TRUSTED_RULE_SETS` stays empty.


## 28. Audited rule sets registered (CR-012) — shadow activation prepared

* **Registry.** `RBTS-L-001 → LONG` and `RBTS-S-001 → SHORT` are registered from the user-confirmed audit of the live TrendSpider alerts (§3.1). The §3.1 items that were not reported (watchlist, webhook URL, extra filters) are taken as none beyond those listed.
* **Effect.** Registration changes only the v1.2 SHADOW qualification. Swapped direction is CONFLICT; missing, unknown and retired ids, test webhooks and unauthenticated requests are NOT QUALIFIED.
* **VWAP difference.** The audited TrendSpider VWAP is `VWAP(14, 0, hlc3)`, while the SIP reconstruction uses SESSION VWAP by default. That affects only the diagnostic `CLOSE_VS_VWAP` parity class in v1.2; any change is approval-gated.
* **Activation.** Activation and secret rotation follow `RB_V1_2_SHADOW_ACTIVATION.md`. Promotion of v1.2 (§16, §18) remains a separate decision under the §18 rollout gates; the §17 note on rotating the token at promotion is covered by the rotation plan.
