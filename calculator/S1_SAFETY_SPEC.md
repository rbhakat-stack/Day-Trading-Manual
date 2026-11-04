# S1 — Safety Specification, Score Stability and Regression Tests

Branch `rb-s1-safety-spec` from `280b982`. The source tree is identical to `c2dbd72`, which is what production runs.

S1 is tests and design only. No application code is changed, nothing is pushed and nothing is deployed.

## 1. Invariants and authoritative owners

| ID | Invariant | Authoritative owner today | Status on 280b982 |
|---|---|---|---|
| A | If the execution safety gate refuses a new trade for an alert, no other component shows an actionable TRADE NOW for it at the same instant. | **The Live Queue**: `decideAlert` / `decideAlertV12` through `deriveLifecycle`. READY requires a ticket, `finalActionability === 'READY'`, and none of `entryWindowClosed`, `setupFailed` or `portfolioUnverified`. | **Violated.** The Ranker recomputes eligibility independently (`App.tsx:322`, `candidateRanker.strategyRules`) from persisted candidate fields. It applies no freshness, DATA REVIEW or terminal-latch input. |
| B | A reliable chase beyond 0.25 ATR, or a latched SETUP FAILED, never revives into an authorization. | `lifecycle/terminalEvents.ts` and `executionState.ts` | **Violated for chases.** CHASED is recomputed per quote. The SETUP FAILED latch holds in the Queue but not in the Ranker. |
| C | Frozen alert-time strategy quality, live execution conditions and final authorization are distinct, and policy decides which one gates eligibility. | Frozen: `alertTimeSnapshot.ts`, `candidate.initialScore`. Live: `rankCandidates` each pass. Authorization: `decideAlert`. | **Undefined policy.** The live tier decides (`alertDecision.ts:349–351`). |
| D | The Queue and the Ranker never give conflicting actionable answers. | — (two engines) | **Violated.** The peer pools differ (section 4). |
| E | Independent same-ticker alerts are not blocked by a non-actionable earlier candidate. Submitted orders and open positions do block. | `alertDecision.ts:existingCandidateFor` | **Violated** for non-actionable NEW/WATCHLIST candidates. PENDING, FILLED and positions block correctly. |

**Informational versus authorizing surfaces:**
- The manual Calculator (`DecisionPanel`) is an informational tool driven by your own inputs; it is not alert authorization.
- The Ranker's status actions (`App.tsx:503`, `setStatus`) can mark a candidate PENDING. They are therefore part of Invariant A.

## 2. Fixtures and provenance

All historical fixtures are in `src/safety/__tests__/fixtures/`. Their sources:
- **Records:** the production Netlify Blobs store `rb-v1-alerts/alerts/2026-11-04/<id>`, read-only, with the webhook token removed.
- **Prices:** Alpaca SIP **round-lot** trades (condition I excluded), fetched read-only. `quotes[sym][i]` is the latest real trade at or before `steps[i] − 300 ms`, or `null` when no trade is known. Nothing is filled or invented.

| Fixture | Content | Step |
|---|---|---|
| `vrsk-1035` | VRSK LONG 10:35:09 | 0.5 s (covers every 3 s polling phase) |
| `bsx-1220-peers` | All alerts received 12:10–12:27: BSX, UNH, NCLH ×3 | 1 s |
| `bsx-1300` | All alerts received 12:55–13:05:20: BSX, KKR, HCA, VEEV | 3 s |
| `unh-1400` | UNH LONG 14:00:09 and SHW LONG 14:00:16 | 3 s |
| `nclh-1145` | NCLH LONG 11:45:11 → 12:15:20 (6 alerts) | 3 s |

Synthetic records, built with the existing `recordWith` helper and labelled `synthetic.ts`, cover:
- stale quote, DATA REVIEW, missing quote;
- SETUP FAILED followed by recovery, chase followed by pullback;
- PENDING, FILLED, SKIPPED, open position;
- v1.2-stamped records.

`harness.ts` drives the **real** interfaces in the app's own order: `buildQueue` → `freezeAlertSnapshots` → `latchTerminalEvents`, then the Ranker exactly as `App.tsx:314–323` computes it, at the same instant and on the same state.

## 3. Test results on 280b982

| Group | Result |
|---|---|
| Existing baseline tests (unchanged) | **1,135 / 1,135 pass** |
| S1 tests passing: characterization and existing protections | **37** |
| S1 tests failing: known defects reproduced, labelled `[DEFECT]` | **16** |
| S1 tests pending on policy approval (`it.todo`) | **2** |
| Unexpected failures | **0** (one 5 s timeout on a long replay was fixed with an explicit timeout) |

The 16 expected failures, grouped by defect:
- **D1, chase revival (3):**
  - VRSK, Queue re-authorizes at 10:36:45.525–10:36:47.525;
  - VRSK, the chase is not persisted for reload;
  - synthetic pullback.
- **D2, the Ranker overrides a Queue refusal (6):**
  - VRSK after the chase (5 instants);
  - SETUP FAILED followed by recovery;
  - synthetic pullback;
  - stale quote;
  - DATA REVIEW;
  - missing quote.
- **D3, Queue and Ranker scores differ (2):**
  - BSX 12:20:06, 81 vs 85;
  - whole-fixture TRADE NOW mismatch at 12:26:49 and 12:27:21.
- **D4 and D8, duplicates (2):** NCLH 11:50:08, 11:55:03, 12:00:10 and 12:15:20 are rejected as DUPLICATE on arrival and their snapshots freeze blank. Each candidate is created about 5 minutes late.
- **D9, v1.2 ACTIVE (2):**
  - a v1.2-stamped record gets no frozen v1.2 score, because `decideShadow` returns null for v1.2-logic records;
  - the lifecycle alert-time tier is still the v1.1 tier.
- **D12 (1):** the expiry text says "no trigger" although the trigger was crossed.

## 4. Score stability (Invariant C)

**Frozen vs live components** (`opportunityScorer.ts`):

| Behaviour | Components |
|---|---|
| Fixed after the alert | rvol, momentum, candle, time (time is bucketed by alert time) |
| Move with every quote (every 3 s) | **trend** (price vs EMA20 and VWAP, `:65–66`); **location** (price vs VWAP, EMA20 and EMA9, plus −8 × chase ATR, `:238–272`) |
| Move with peers and portfolio | **capital efficiency** (percentile among peers; neutral 6/10 when there are fewer than 3 peers); capital availability; correlation; portfolio risk |

**UNH 14:00:09:**
- Every live score equals 74 + location, where location is 1 when price ≤ 411.3915 (EMA9 + 1.0 ATR) and 0 otherwise.
- The boundary is pinned on the real record: 411.39 scores 75 and 411.40 scores 74.
- The score changed more than ten times. The decision stayed SKIP.
- v1.2 re-scores live as well (74 ↔ 75) while its displayed frozen score stays 74.
- The SHW peer did not change UNH's score.

**BSX 13:00:15:**
- Frozen v1.1 is 82 (WATCHLIST); frozen v1.2 is 73/91 (WATCHLIST).
- The live score ranged over 82, 83, 85, 86, 87 and 89, giving **20 separate Queue authorizations** within the 10-minute window. The alert was never chased.
- So an alert below the threshold at alert time becomes actionable through live price location alone, and it flickers.

**BSX 12:20:06 (Invariant D):**
- At the same instant, on the same state, only capital efficiency differs: 6 in the Queue and 10 in the Ranker.
- The Queue removes DATA REVIEW candidates from its ranking pool (`liveQueue.ts:149–152`). That leaves 2 peers, which gets the neutral 6/10.
- The Ranker keeps them (`App.tsx:322`), giving 3 peers and a percentile of 10/10.
- So a below-threshold DATA REVIEW alert (NCLH 12:25:20, score 53) lifted BSX to 85 / TRADE NOW in the Ranker.

**Questions answered** (tests named in brackets):

| Question | Answer |
|---|---|
| Can the score cross 85 without a new alert? | **Yes** (BSX 13:00:15). |
| Can an initially qualified alert drop below threshold temporarily? | **Yes, by the same mechanism.** Location and trend move both ways, as UNH shows in both directions. |
| Can an initially disqualified alert become eligible later? | **Yes** (BSX 13:00:15). |
| Can a chased alert regain eligibility as its live score rises? | **Yes.** A pullback raises location points for a LONG while clearing the chase (VRSK, synthetic). |
| Can live scores change Ranker ordering inconsistently with the Queue? | **Yes** (BSX 12:20:06). |
| Does v1.2 re-score live too? | **Yes**, although its displayed score is frozen. |

**Tier boundaries are pinned:**
- v1.1: 74/75 is SKIP/LOW, 79/80 is LOW/WATCHLIST, 84/85 is WATCHLIST/HIGH, 89/90 is HIGH/ELITE.
- v1.2 Option B: 77/78 is WATCHLIST/HIGH and 81/82 is HIGH/ELITE (82/78/73/69).

## 5. Scoring-policy alternatives (pending approval; not implemented)

| | A — frozen quality qualification | B — fully dynamic (current) | C — hybrid with controlled upgrades |
|---|---|---|---|
| Rule | Eligibility requires the alert-time total to be at least the trade threshold. Live inputs can only take eligibility away: hard gates, chase, freshness, portfolio. | The live total can cross thresholds either way. | Frozen qualification, with an upgrade allowed only under explicit rules or a new TrendSpider alert. |
| Safety | Highest. No upgrade by drift, no flicker; terminal and portfolio gates stay live. | Lowest. Upgrades by location drift (BSX 13:00:15, 20 windows). Pullbacks raise the score while clearing a chase. | High, if the upgrade rules are themselves tested. |
| 10-minute lifecycle | Unchanged. | Unchanged, but tickets can appear at any moment. | Unchanged, plus upgrade evaluation. |
| Repeated tickets | At most one READY episode per alert unless a live gate interrupts it. | Many (UNH: >10 score flips; BSX: 20 windows). | Few. |
| Ranking | Allocation priority by frozen quality; live portfolio fit still gates capacity. | Order changes every poll. | Mixed. |
| v1.1 / v1.2 | Both; uses each version's own frozen tier (needs D9). | Both. | Both, and needs per-version upgrade rules. |
| Replay effect (11/04) | BSX 13:00:15 and other below-threshold alerts lose their late tickets; VRSK unchanged. | None. | Depends on the rules. |
| Auditability | One score per alert explains the decision. | The decision depends on a quote that is not retained. | Needs upgrade-event logging. |
| Sub-60 s execution | Stable ticket from the first pass. | Tickets can disappear before you finish. | Mostly stable. |
| Extra tests | Frozen-gate tests (the two `it.todo`). | Hysteresis and flicker tests. | Upgrade-rule tests and event-persistence tests. |
| Complexity | Low: one gate change in `decideAlert` / `decideAlertV12`. | None. | High: new rules, state and UI. |

**Recommendation (pending your approval): Policy A.**
- It removes the flicker and late-upgrade class entirely, and it keeps every live safety gate.
- It needs one gate condition and no change to the scoring formulas.
- Missed opportunities are limited to setups that were below threshold at alert time. Their later "improvement" comes mostly from price drifting back toward structure, which overlaps with the chase and revival risk anyway.
- Policy C can be added later with evidence.

## 6. Minimal S2 design (not implemented)

**S2a — one release, tightly coupled because both are authorization:**
1. **Terminal chase latch, with no UI redesign.**
   - `terminalEvents.ts`: add `observedChase` (fresh quote, trade after the alert, not under DATA REVIEW, unsubmitted, inside the window, calculator `CHASED_SETUP`, price beyond the frozen entry by more than 0.25 ATR). Write it once under the key `<id>|CHASED`.
   - `executionState.ts`: one branch after SETUP FAILED; latched gives the existing `CHASED` / `NO TRADE` with `terminal: true`, plus a `chaseLatched` flag.
   - Withhold the ticket wherever `setupFailed` withholds it: `LiveQueuePage.tsx:93`, `QueueParts.tsx:388–390`, `queueView.ts` badges.
   - Writes go only to the existing terminal-events map. The previous build ignores the `|CHASED` key; this was proven in CR-17.
   - Replay expectation: VRSK has no READY after 10:35:14. No other 11/04 decision changes.
2. **Shared authorization for the Ranker.**
   - `App.tsx`: compute `authorizedIds` from `queue.rows` with the `queueAuthorizes` predicate, and pass it to `RankerPage`.
   - `portfolioGate.ts`: add one display gate, following the existing `gateRankingDisplay` pattern. For **AUTO** candidates not in `authorizedIds` (or when the Queue is off), show "NOT AUTHORIZED — see Live Queue" instead of TRADE NOW and hide the submit action.
   - **Manual** candidates are unchanged, since the Ranker is their authority.
   - Scores are not changed. Owner: the Live Queue.
   - Replay expectation: zero `rankerAuthorizes && !queueAuthorizes` instants across all fixtures.
   - No storage writes.
3. **Display separation (D3 visibility).** In the Ranker, label the score as the Ranker's peer-pool view, and show the Queue's score when they differ. This is display only and changes no weights.

**S2b — separate:** D4 duplicate rule (`existingCandidateFor` blocks only PENDING/FILLED, or earlier candidates that were trade-eligible at alert time). It changes decisions, so it gets its own replay diff.

**S2c — separate, after policy approval:** the scoring policy (section 5).

**S2d — with v1.2 promotion:** D9 (version-correct frozen v1.2 score and alert-time tier).

**S2e — separate:** bid/ask (needs a quote API extension).

**For every S2 release:**
- push an annotated rollback tag at the production SHA first;
- keep the previous deploy ready;
- the 1,135 baseline tests must still pass;
- the S1 `[DEFECT]` tests for that release's scope must turn green;
- no other S1 test may change state;
- run a whole-fixture replay diff of decisions, tickets, scores and plans.

## 7. v1.2 ACTIVE implications

v1.2 shares the Queue lifecycle and the Ranker, so D1–D4 apply to it unchanged. D9 must be fixed, or a v1.2-active alert will have no frozen v1.2 score and v1.1-based lifecycle reasons.

Also outstanding for v1.2:
- the scoring policy, which must use each version's own frozen tier;
- the `rule_set` configuration for HCA, KKR and SWKS alerts;
- bid/ask.
