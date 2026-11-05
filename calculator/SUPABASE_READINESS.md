# Supabase persistence — readiness notes (planning only)

**Nothing in this document is implemented.** No table, migration, backend service, persistence library, data-access
layer or authentication change is part of the Live vs. Alert-Time Comparison UI release. These notes record what the
application stores today and where, so the next release can persist it without rewriting history.

## 1. What is stored today

### Server (Netlify Blobs, store `rb-v1-alerts`, strong consistency)

| Key | Object | Mutability |
|---|---|---|
| `alerts/<ET date>/<record id>` | `AutoAlertRecord` (`src/engine/automation/alertDecision.ts`) | Filled by `enrichRecord`; **immutable once `status = OK`** (a retry only re-processes RECEIVED / DATA_ERROR records) |
| `dedupe/<hash(dedupeKey)>` | record id owning a dedupe key (v1.1 and v1.2 keys) | write-once per key |

`AutoAlertRecord` alert-time facts (server clock): `receivedIso/receivedMs`, `alert` (symbol, direction, alert name,
`alertTimeMs`, `timeSource`), sanitised `payload`, market-data `snapshot` (OHLC, indicators, signal candle, 15-minute
confirmation, `issues`), `marketDataThroughIso`, `initialQuote` (price, `tradeIso`, `fetchedIso`), `calcAtAlert`
(reference Calculator result with frozen RB v1.1 defaults: `action`, `headline`, entry, stop, target, shares,
planned risk), `versions` (rules / scoring / strategy), `firstProcessedIso` (write-once), `processedIso` and
`retry` (overwritten by retries — not provenance), and the RB v1.2 audit (`v12`: rule set, qualification,
reconstruction / parity).

Sessions: store `rb-auth-sessions` (CR-16), unrelated to trading data.

### Browser (`localStorage`, per browser profile — not shared between devices)

| Key | Content | Mutability |
|---|---|---|
| `rbv1.v12.alertSnapshots.v1` | `AlertTimeSnapshot` per record: v1.1 score / tier / decision, v1.2 score / Option A / B, trade plan + order type, OHLC / indicators, latency, provenance, `frozenAtMs`, `complete` / `missing` | **write-once** per record id; pruned after 90 days |
| `rbv1.ranker.candidates.v1` | `Candidate` per alert: frozen plan at creation, `initialScore` (write-once `ScoreSnapshot` with `at`), mutable `status`, live patches | mixed |
| `rbv1.v12.terminalEvents.v1` | `TerminalEvent` latches (`<id>` SETUP FAILED, `<id>|CHASED`) with `observedAtMs`, price, `quoteTradeIso` | write-once per key |
| `rbv1.journal.v1` | `JournalEntry` trades, notes, overrides | user-edited |
| `rbv1.ranker.positions.v1`, `rbv1.v12.releasedExposure.v1`, `rbv1.v12.brokerExposureSnapshot.v1`, `rbv1.v12.brokerOrders.v1` | portfolio / broker reconciliation state | mutable |
| `rbv1.settings.v1`, `rbv1.ranker.settings.v1`, `rbv1.strategy.version.v1`, `rbv1.automation.*` | configuration, classifications, parity log | mutable |

## 2. Gaps the comparison UI exposes (deferred snapshot-extension requirements)

1. **The alert-time RB decision, score and tier are not stored on the server.** They exist only in the browser that
   was open at alert time. A second device, a cleared profile, or an app opened after the alert has no genuine value —
   the UI shows NOT CAPTURED. → Persist the v1.1 (and v1.2) strategy snapshot server-side at first evaluation.
2. **No alert-time execution assessment is stored anywhere**: execution state, final actionability, data status,
   chase status and portfolio status are evaluated live and never recorded. → Record timestamped execution
   evaluations (at least: first evaluation, every state transition, terminal event).
3. **The alert-time portfolio context** (slots, heat, broker verification) is not recorded with the alert.
4. **Provenance of client snapshots** is the client clock (`frozenAtMs`). → Server-stamp evaluation times; keep the
   client time as a separate field.
5. `processedIso` is overwritten on retry; only `firstProcessedIso` is provenance.

None of these is implemented in this release (by instruction).

## 3. Proposed entities (separate immutable facts from changing evaluations)

| Entity | Purpose | Key fields | Mutability |
|---|---|---|---|
| **A. `alerts`** | one row per TrendSpider alert | `id` (record id, PK), `dedupe_key` (unique), `symbol`, `direction`, `rule_set`, `alert_name`, `alert_time`, `time_source`, `received_at`, `first_processed_at`, `payload` (sanitised), `market_data_through`, `initial_quote`, `market_snapshot` (jsonb), `calc_at_alert` (jsonb) | insert-once; `status` the only updatable column until OK |
| **B. `strategy_snapshots`** | alert-time strategy result **per strategy version** | `alert_id` FK, `strategy_version` ('RB v1.1' / 'RB v1.2'), `role_at_capture` (ACTIVE / SHADOW), `score`, `max_score`, `tier` (+ v1.2 option tiers), `decision`, `decision_detail`, `components` (jsonb), `trade_plan` (entry, stop, target, qty, risk, **order_type**), `evaluated_at` (server), `client_frozen_at`, `complete`, `missing` | insert-once; unique (`alert_id`, `strategy_version`) |
| **C. `execution_evaluations`** | timestamped execution assessments | `alert_id`, `strategy_version`, `evaluated_at` (server), `quote_trade_at`, `quote_received_at`, `execution_state`, `final_actionability`, `reason`, `data_status`, `chase_status`, `portfolio_status`, `live_score`, `live_tier`, `authorization_ref` | append-only (one row per transition, not per poll) |
| **D. `lifecycle_events`** | terminal and notable events | `alert_id`, `kind` (CHASED, SETUP_FAILED, EXPIRED, STALE, …), `observed_at`, `price`, `evidence` (jsonb) | append-only; first terminal event wins (as S2a today) |
| **E1. `candidates`** | the trade candidate created from an alert | `id`, `alert_id`, `strategy_version`, frozen plan, `initial_score_ref` | plan insert-once; `status` updatable with history |
| **E2. `broker_orders` / `fills` / `positions`** | Alpaca PAPER mirror | Alpaca order id (unique), `candidate_id` (nullable for overrides), symbol, side, qty, prices, timestamps | upsert by Alpaca id; never deletes |
| **E3. `journal_entries`** | user journal, notes, overrides, outcomes | `id`, `candidate_id` / `alert_id` (nullable), `broker_order_id`, user fields, realized R / P&L | user-editable with `updated_at` and an audit trail |

Relationships: `alerts 1—n strategy_snapshots (one per version)`, `alerts 1—n execution_evaluations`,
`alerts 1—n lifecycle_events`, `alerts 1—0..1 candidates (per version)`, `candidates 1—n broker_orders`,
`journal_entries n—1 candidates / broker_orders`.

Rules carried over from the current code:
- never write a later evaluation into an alert-time column (no single mutable "alert" row);
- v1.1 and v1.2 results are separate rows; a version never reads the other's values;
- a missing historical value stays missing (NULL + reason), it is never back-filled from current data.

## 4. Migration and compatibility risks

- **Backfill**: server records (`rb-v1-alerts`) can be imported as `alerts` exactly. Browser snapshots can be imported
  per device only as *client-captured* rows (`client_frozen_at`, flagged); they must not be presented as server
  evaluations, and snapshots written late (see `ALERT_CAPTURE_TOLERANCE_MS`) must be flagged as not alert-time.
- Conflicting snapshots from two browsers for the same alert: keep the earliest genuine one, retain the other for audit.
- Journal entries without alert/candidate identity (manual, overrides such as the BA / NVDA records) must import with
  NULL foreign keys — not be matched heuristically.
- Keep the current localStorage keys readable during the transition (read-through), so a rollback stays possible.

## 5. Idempotency and duplicates

- `alerts.id` and `alerts.dedupe_key` unique (today: `dedupe/<hash>` blobs, v1.1 and v1.2 keys).
- `strategy_snapshots` unique (`alert_id`, `strategy_version`); insert-if-absent (mirrors write-once `freezeAlertSnapshots`).
- `lifecycle_events` unique (`alert_id`, `kind`) for terminal kinds (mirrors the S2a latch keys).
- Broker rows keyed by Alpaca order id; webhook retries and repeated polls must be no-ops.

## 6. Audit, retention, security

- Immutable tables: no UPDATE/DELETE grants for the application role; corrections are new rows.
- Retention: alerts and snapshots ≥ 90 days (today's snapshot pruning), journal indefinitely; archive rather than delete.
- Row-level security: every row carries `owner_id`; RLS policies `owner_id = auth.uid()`; the webhook writes through a
  server-side service role only (never from the browser); no Alpaca or TrendSpider secret ever stored in Supabase rows.
- Server timestamps (`now()`) for every evaluation; client times kept only as labelled secondary fields.
