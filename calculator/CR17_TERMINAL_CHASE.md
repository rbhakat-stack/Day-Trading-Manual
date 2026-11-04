# CR-17 — Terminal Chase Safety and Entry-State Clarity

Status: implemented locally, not deployed. Rollback tag `prod-pre-cr17-terminal-chase` → `c2dbd72` (production deploy `6aea9411f4c9232185965667`).

## Defect

The audit of the 2026-11-04 VRSK 10:35:09 LONG alert (`VRSK-L-103509-494e49`) showed this sequence. The 10:35:12 READY state comes from a historical replay of the production record against real SIP round-lot prices. It is not retained production UI evidence.

| ET | Last round-lot trade | Pre-CR-17 state |
|---|---|---|
| 10:35:12.0 | 201.07 (entry 201.26 not crossed) | READY (ticket) |
| 10:35:13.7 | 201.465 (+0.26 ATR, limit 0.25) | CHASED / NO TRADE |
| 10:36:45.5 – 10:36:47.7 | 201.2334 (one round lot below entry) | **READY again** (BUY STOP 201.26, ask ≈ 201.6) |
| 10:36:48 → 10:45:09 | 201.38 – 202.5 | CHASED / LATE — REVIEW alternating |
| 10:45:09 | — | EXPIRED — STALE "no trigger within 10 minutes" (wrong: it was crossed) |

**Root cause.** `deriveLifecycle` decides CHASED from the current price's calculator result (`SKIP_CHASED`) on every pass. Nothing remembered that the limit had already been exceeded. When price returned below the trigger, the calculator again produced a BUY STOP ticket, and the lifecycle reported ACTIVE / READY. The `terminal: true` flag on CHASED was only a presentation flag. SETUP FAILED had a write-once latch (Nov 3 fix); the chase did not.

## Change

1. **Terminal chase latch** (`lifecycle/terminalEvents.ts`, `observedChase`, `latchTerminalEvents`). The latch is write-once and follows the same rules as SETUP FAILED. It is recorded only when all of these hold:
   - the record is OK and not under DATA REVIEW;
   - no order is submitted or filled (candidate NEW or WATCHLIST);
   - the alert is inside its 10-minute window;
   - the quote passes the existing freshness rules (data ≤ 5 s, last trade ≤ 60 s);
   - the last trade is not older than the alert receipt (out-of-order observations are refused);
   - the calculator reports its own `CHASED_SETUP` hard fail;
   - the observed price is beyond the frozen entry by more than the existing `chaseThresholdAtr` (0.25) in signal ATR.

   The event stores the price, entry, distance in ATR, threshold, observation time and last-trade time.
2. **Lifecycle** (`lifecycle/executionState.ts`).
   - A latched chase yields execution state `CHASED`, `NO TRADE`, terminal, with the new `chaseMissed` field and the reason `MISSED — DO NOT CHASE — price … was beyond the … trigger (x ATR, limit 0.25 ATR) at hh:mm:ss ET …`.
   - This reason survives the 10-minute expiry.
   - It is evaluated after the user and broker states (SUBMITTED, IN POSITION, CLOSED) and after SETUP FAILED.
   - An alert that was never eligible (for example SKIP) keeps its own reason.
   - Without a latch, the expiry reason no longer says "no trigger" when the current price is past the trigger.
3. **Ticket withholding.** Wherever a withheld ticket was already suppressed (15:30 cutoff, SETUP FAILED, portfolio unverified), a `chaseMissed` alert is suppressed too:
   - the actionable cards;
   - the *Mark order submitted* control;
   - the TRADE READY and READY badges;
   - the v1.2 shadow ticket note;
   - the not-ranked frozen-score display.

   The RB v1.1 decision object itself is unchanged.
4. **Entry states** (`components/live/queueView.ts`, `entryState`). There are exactly three, and they are presentation only:
   - **READY — PLACE STOP ORDER**: the active decision carries a ticket that nothing withholds, and the trigger is not crossed. The detail reads `BUY STOP` or `SELL STOP`, plus "recheck live before submitting; a stop order is not guaranteed to fill at its trigger".
   - **TRIGGER CROSSED — REVIEW ENTRY**: crossed within the 0.25 ATR band, not terminal, and the alert-time tier passed (ELITE or HIGH). It is review only and never carries a ticket.
   - **MISSED — DO NOT CHASE**: the terminal chase latch.
   - Otherwise there is no entry state, and the existing decision (SKIP, DATA REVIEW, SETUP FAILED, EXPIRED — STALE, portfolio, SUBMITTED / IN POSITION) is shown with its authority unchanged.
   - The state is displayed in the main queue (Execution column), the expanded header, Trade Construction, and Portfolio & Execution. The Hard Rules section still explains the decision.

## Unchanged

Nothing else changes:
- scoring (v1.1 and v1.2), the Option A/B thresholds and the 0.25 ATR limit;
- ATR, entry, stop, target, quantity, risk and R:R;
- portfolio allocation and limits;
- indicators and frozen alert-time snapshots;
- the webhook, Alpaca (PAPER, GET-only), broker matching and verification;
- CR-15, the Journal, the Dashboard and CR-16.

No storage key was added, renamed or migrated.

## Persistence and rollback

- The chase event is stored in the existing terminal-events map (`rbv1.v12.terminalEvents.v1`, 90-day pruning) under the key `"<recordId>|CHASED"`. The record-id key used by SETUP FAILED is untouched.
- **After a refresh:** it survives a page reload in the same browser, because the map is persisted by the existing `usePersistent`.
- **On rollback:** the previous build looks events up only by record id, so it ignores CR-17 entries. Its own SETUP FAILED latch for the same record still works, and pruning is unchanged; this was tested against `c2dbd72`. Rolling back needs no data restore and no cleanup.
- **Other tabs and devices:** the latch lives in this browser's storage, like the snapshots and SETUP FAILED. Another browser or device latches independently on its own first reliable observation. A browser that was not polling while price was beyond the limit never latches, and keeps the previous behaviour for that alert.
- **Timing:** the latch is written after the pass that observes the chase, the same as SETUP FAILED. That pass itself already shows CHASED / NO TRADE with no ticket.

## Limitations

- **Bid/ask not checked.** The live quote is the last trade only, and the app has no bid or ask data. TRIGGER CROSSED — REVIEW ENTRY is therefore checked on the last trade and never authorizes a ticket. READY does not check whether the ask is already above a BUY STOP trigger. On VRSK at 10:35:12 the ask was 201.35, above the 201.26 trigger.
- **Odd lots.** Alpaca's latest trade excludes odd lots, so a chase seen only in odd lots is not latched.
- **Header count.** The *Live Alert Queue (n)* count in the App header still counts decisions that carry a ticket. As before CR-17 for withheld tickets, that includes withheld ones. It is not a ticket, and no execution control is shown.
- **Opportunity Ranker page.** It is not connected to terminal events. This is unchanged and applies to SETUP FAILED as well.

## Tests

`src/components/live/__tests__/cr17TerminalChase.test.ts` has 32 tests:
- the VRSK replay, which reproduces the pre-CR-17 revival and confirms it is suppressed;
- LONG and SHORT ready, in-band and beyond-limit cases, pullback and opposite-direction moves after a chase, and the 10-minute expiry;
- an independent later alert, stale data, out-of-order observations, submitted, filled, broker unavailable, portfolio unverified, SETUP FAILED, EXPIRED — STALE, and below-threshold SKIP;
- unchanged frozen scores and plan, consistent labels across views, refresh, storage keys, data review, and a single READY window.

The fixture is `src/engine/automation/__tests__/vrsk-2026-11-04.json`: the production record with the webhook token removed, plus the SIP round-lot observations.
