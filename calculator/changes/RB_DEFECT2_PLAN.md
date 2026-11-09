# RB Defect 2 — Risk of unmatched broker positions from verified protective stops (PLAN)

Branch `rb-defect2-broker-position-risk`, based on `3e61dbf` (Defect 1). **Implemented with Option C** (owner decision 2026-11-09). Validated offline; not merged, pushed or deployed. §8 records the final implementation; §3 and §6 were the plan.

## 1. Defect

`reconcileExposure` (`engine/automation/lifecycle/portfolioExposure.ts:336-346`) adds every open Alpaca position that no active RB record represents with `plannedRisk = conservativeRisk` (equity × 0.25 % = **$250 flat**). It ignores the position's real protective stop.

| Real PAPER state | True risk (qty × \|entry − stop\|) | Counted today |
|---|---|---|
| FIS 499 sh @ 40.05, stop 39.84 (held overnight 2 → 3 Nov) | **$104.79** | $250 |
| MCD 75 sh @ 263.55, stop 261.01 (held overnight 3 → 4 Nov) | **$190.50** | $250 |
| GM 223 sh @ 89.49, stop 89.22 | **$60.21** | $250 |
| NVDA −98 sh @ 202.5249, buy-stop 203.35 | **$80.86** | $250 |
| CTVA −1683 sh @ 11.88, buy-stop 11.96 | **$134.64** | $250 |
| AAPL 360 sh @ 349.91, stop 349.24 | **$241.20** | $250 |

- **Overstated** whenever a position is protected (heat reaches its limit sooner, so new trades are wrongly blocked).
- **Understated** whenever real risk exceeds $250 (a wider stop, a larger position, or no stop at all).

Working entry orders (`brokerWorkingEntries`) already use a single unambiguous bracket stop. Only open positions are affected.

## 2. Key broker fact (from the archived PAPER orders)

For stop-entry and limit-entry brackets, the protective stop leg exists from the parent's creation but stays **`held`** (Alpaca's waiting OCO leg). It is "submitted" only when it triggers (FIS, GM, CTVA, AAPL, TRMB). For NVDA and MCD it was routed at once (`new`).

**Requirement:** treat a stop leg of a filled parent as protection when its status is `new`, `accepted` **or `held`**. Today's open-order handling skips `held` legs (correct for entries, wrong for protection).

To verify on the live API before release: whether `GET /v2/orders?status=open&nested=true` returns a filled parent with its held stop leg, or the leg at top level. The implementation must accept both.

## 3. Proposed rule (pure function, `portfolioExposure.ts`)

`protectiveRisk(position, openOrders)` → `{ basis, plannedRisk, confirmedRisk, uncoveredQty, stops[], flags[] }`

1. **Protective stops:**
   - same symbol, opposite side (sell for LONG, buy for SHORT);
   - type `stop`, `stop_limit` or `trailing_stop`;
   - status `new`, `accepted`, `held` or `pending_new`;
   - a numeric `stop_price` (for a trailing stop, the broker's current stop);
   - top-level or nested legs, de-duplicated by order id;
   - canceled, replaced, filled and expired orders are never protection.
2. **Coverage:** the sum of stop quantities, capped at the position quantity.
3. **Confirmed risk:** Σ legQty × max(0, \|avgEntry − stop\|) (a stop past the entry locks profit, so risk is 0, never negative). A position with several lots uses the broker's average entry, the only entry `/v2/positions` reports (TRMB fixture).
4. **Ambiguous stops** (more stop quantity than shares, at different prices): count the **farthest** stops first, so risk is never understated. Flag `AMBIGUOUS_STOPS`.
5. **Basis:**
   - `CONFIRMED_STOP`: fully covered.
   - `PARTIAL_STOP`: confirmed part, plus the uncovered quantity treated as unknown.
   - `UNKNOWN_NO_STOP`: no protective stop.
6. **Unknown risk (owner decision, see §6).**
7. **Unchanged:** represented positions (an active RB candidate or manual position for the ticker) are never added, so there is no double counting. Released and latched logic, unverified-broker handling (`LAST_KNOWN` snapshot and the PORTFOLIO UNVERIFIED gate), working entries, scoring, sizing, allocation formulas, slots, the heat % and the Journal.
8. **Additive data:** `BrokerOnlyPosition` gains `riskBasis`, `stops`, `uncoveredQty` and `flags`. The persisted broker snapshot stays backward compatible (missing fields are read as the old flat basis).
9. **Display only:** the Live Queue and Ranker exposure notes show "risk from broker stop $X" or "UNPROTECTED — conservative".

## 4. Partial fills, replacements, overnight

- **Partial fill:** position qty = filled qty. A stop leg sized to the filled qty means confirmed risk; a bigger leg is capped at the position.
- **Stop replaced:** only the open replacement counts (the replaced order is terminal).
- **Stop canceled:** no protection, so the position is unknown.
- **Overnight:** GTC legs come from the any-day open-order list (already fetched), so a held OCO leg counts.

## 5. Tests required (implementation phase)

- **Fixture tests** (`defect2-broker-positions.fixtures.json`, 16 states): 7 real PAPER states (FIS, MCD, GM, NVDA, CTVA, AAPL, TRMB with two lots) and 9 labelled synthetic ones: canceled stop, partial coverage, replaced stop, two conflicting stops, a stop past the entry, a partial fill, a trailing stop, a same-side stop (not protection) and an unverified broker.
- The `CURRENT` assertions in `defect2Characterization.test.ts` flip to each fixture's `expected`.
- No double counting with a represented candidate (FILLED, PENDING) or a manual position. Released and latched behaviour unchanged.
- Historical replay (the Defect 3 harness, all modes): every field identical **except** broker-only position risk and its downstream effects (heat, the portfolio-risk score component, `PORTFOLIO_HEAT_LIMIT` hard fails, allocation, tickets), each difference listed.
- **Unverified / last-known paths unchanged.** Snapshot backward compatibility: an old snapshot without `riskBasis` still loads.
- Source guard: `held` stop legs of filled parents are considered protection, and `held` entries are still never counted as working entries.

## 6. Decision needed from the owner: how to count UNKNOWN risk

| Option | Unknown / uncovered quantity counted as | Effect |
|---|---|---|
| A | Per-trade limit ($250), as today, plus a warning | Can understate a large unprotected position |
| B | Full notional (qty × entry) | Extremely conservative: one unprotected $20k position exceeds the $1,000 heat limit and blocks all new trades |
| **C (recommended)** | Per-trade limit (or more, if the confirmed part already exceeds it), **plus** a new portfolio gate **UNPROTECTED BROKER POSITION** that withholds new tickets until a stop exists or the position is recorded in RB | Conservative, no invented risk number, clear operator action. Reuses the existing PORTFOLIO UNVERIFIED gate pattern. |

## 7. Out of scope

- Represented positions whose stop was later moved at the broker (the candidate keeps its planned risk).
- Automated stop placement or any broker write.
- Supabase.

## 8. Implementation (final)

### Files
- `engine/automation/lifecycle/portfolioExposure.ts`: `positionProtection` (pure), `unprotectedReason`, `unprotectedGate`, types; unrepresented positions use the corrected risk; `BrokerOnlyPosition` gains additive fields.
- `engine/automation/liveQueue.ts`: the UNPROTECTED gate joins the existing portfolio gate (the verification gate wins).
- `engine/automation/lifecycle/executionState.ts`: the gate's own label, `NO TICKET — UNPROTECTED BROKER POSITION — <exact reason>`.
- `components/live/queueView.ts`: row status label.
- `components/live/LiveQueuePage.tsx`: `brokerPositionNote` (verified stops listed; unresolved reason; legacy wording kept).
- `App.tsx`: `gateView` (verification plus the UNPROTECTED gate) for the Live Queue banner and the Ranker's TRADE NOW gate.
- Tests: `defect2BrokerPositionRisk.test.ts` (35), `defect2Acceptance.test.ts` (8), fixtures (24 states). Three existing tests updated to the corrected values (MCD $190.50; additive snapshot fields; `gateView` source guard).
- `tools/defect2/buildFixtures.mjs`.

### Rules changed from the plan after reading Alpaca's documentation
- **Complete fill required.** A bracket leg protects only when its parent entry is **completely** filled. Alpaca: exit legs "won't be active until the first order is completely filled". A partial fill therefore has no active bracket stop, so it is UNKNOWN unless a standalone stop covers it.
- **Trailing stops.** They are standalone only (Alpaca does not support them as bracket legs yet) and use the broker's live `stop_price`; one without a stop price is not verifiable.
- **Ambiguous stops** (more stop quantity than shares, at different prices) do not establish protection: `AMBIGUOUS_STOPS` is gated. Over-coverage at one price is unambiguous: CONFIRMED, flag `OVERLAPPING_STOPS_SAME_PRICE`.

### API-shape evidence and its limits
- **Documented** (docs.alpaca.markets, "Orders at Alpaca"): `nested=true` nests child orders under the parent in `legs`; each order of a group is also an independent order; exit legs are inactive until the entry is completely filled; trailing stops report `hwm` and a continuously updated `stop_price`.
- **Not documented:** the leg status values after the parent fills, and whether `status=open&nested=true` returns a filled parent with its open legs.
- **Empirical:** the archived PAPER orders show stop legs created with the parent but submitted only when triggered (FIS, GM, CTVA, AAPL, TRMB), i.e. a waiting `held` OCO leg.
- **The code accepts both shapes.** A nested or verifiable parent counts; a held leg without a verifiable parent fails closed (UNKNOWN, gated).
- **Live check still needed:** confirm the open-order shape read-only the next time a bracket position is open. Until then a mismatch can only gate (fail closed), never understate risk.

### Replay results (identical inputs; baseline `3e61dbf`)
- **Five standard modes:** 6,147 evaluations and 382,825 rows, 0 differences. No real broker-only position exists in them; the synthetic SYNB1 is now `UNKNOWN_NO_STOP` at the same $250.
- **HIST_BROKER_NORB** (real broker states with RB records absent): 1,228 evaluations and 76,565 rows.
  - Risk: CTVA 250 → 134.64, FIS 250 → 104.79, GM 250 → 60.21, MCD 250 → 190.50, NVDA 250 → 80.86, all CONFIRMED via bracket legs and never gated.
  - Heat lower in 329 evaluations.
  - Portfolio-risk score component changed in 9,543 row-evaluations.
  - Hard rules, tickets and lifecycle unchanged. 0 unexpected differences.
