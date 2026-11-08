# RB Defect 3 — Historical Regression (offline)

Production baseline: commit `7122934` (= rollback tag `rb-v1.1-pre-portfolio-stabilization-20261108`, Netlify deploy `6aee715816e7ee46a30bab41`). Fix: branch `rb-defect3-portfolio-summary` (isolated worktree, not merged, pushed or deployed). Both code trees were run through the **same harness over the same frozen inputs**, entirely offline: no network, no broker access, no archive writes.

## 1. Result

| Check | Result |
|---|---|
| Evaluations compared (identical keys in both trees) | **5,675 / 5,675** |
| Alert-row comparisons (candidate, score, components, eligibility, hard fails, allocation, decision, lifecycle, shadow score) | **372,700 rows — 0 differences** |
| Per-evaluation fields: rows, replacement suggestions, broker exposure (verified / released / added / working entries / source), frozen alert-time snapshots, broker reconciliation (TradeSync), Ranker complete portfolio | **0 differences** |
| Corrected summary = complete portfolio = Ranker complete portfolio | **5,675 / 5,675** |
| Corrected summary unchanged by reordering rows (committed first; reversed) | **5,675 / 5,675** each |
| Old (production) summary wrong when committed rows were listed first | **2,571** evaluations |
| Old summary blank ("—") although the portfolio held exposure | **45** evaluations (e.g. 09:31 pre-open with an overnight position) |
| Unexpected behavioural differences | **None** |

**Interpretation.** Every strategy, scoring, construction, eligibility, allocation, broker-reconciliation and snapshot output is byte-identical. The only difference is the source of the summary card, which now always equals the Ranker's complete portfolio.

## 2. Frozen dataset

Read-only copies, write-protected in `scratchpad\d3replay\data\` (`DATASET_SHA256.txt`):

| File | Records | Source | SHA-256 |
|---|---|---|---|
| `alerts-2026-11-02.json` | 100 | production `rb-alerts` archive (copy taken during the RVOL audit) | `ecc095c15efb4d0a32ae173fc34d54e51fdb23183a552b8ffcf02e34dfcc933f` |
| `alerts-2026-11-03.json` | 68 | same | `3f04c8f6222ce117e3e0aa378a4313ab72c4e43dfd6176e2cf1f67c3099b4f4b` |
| `alerts-2026-11-04.json` | 142 | same | `5a860e5ba08b57b86896d267b935984e81408b51b43b417e2d02c1eb1017ac07` |
| `alerts-2026-11-05.json` | 143 | same | `f80bb45507b9d012d1b36697dca1923f3b1f555af16b406a560e478ee3fc474d` |
| `alerts-2026-11-06.json` | 114 | `C:\RBResearch\exports\archives\rb-alerts-2026-11-06.json` (Phase 3B immutable copy; byte-identical to the RVOL-audit copy) | `74e17140828c89375faca35ce395f022e5962d785d695a2001c82257c4ddd500` |
| `broker-orders-paper.json` | 14 orders (+ 26 bracket legs) | Alpaca PAPER order history, GET-only, saved during Phase 2B calibration | `fd8ec7e5dd104488d6eb3a7be68b822f340b0eabb806268b1898e7c3f2738fba` |

**Totals: 5 completed sessions, 567 archived alerts (LONG and SHORT), 14 historical broker orders / 40 order objects.** The 30 Oct session (Phase 2B) is not in this set; its full archive was not retained locally.

Harness outputs: `out-base.json` (SHA-256 `877d08fd…cd7d4cad`) and `out-fix.json` (`769341…028f7`); comparison in `comparison.json`.

## 3. Method

`harness.ts` is bundled twice with esbuild, with `@rb` aliased to each tree's `src`. For each session and mode it replays checkpoints at each alert's receipt + 15 s and alert time + 11 min (after expiry), seeing only the records received by that moment. Quotes are the archived alert-time prices.

| Mode | Exposure source | Purpose |
|---|---|---|
| `HIST_BROKER` | Archived PAPER orders reconstructed as of each checkpoint (statuses from their timestamps; open orders from any day; positions from fills); candidates marked PENDING / FILLED / CANCELED / STOPPED_OUT / TARGET_HIT when their linked entry order (same ticker / side / day, stop within 2 ¢) was submitted / filled / exited, as the app's mark actions do | Real broker records |
| `HIST_BROKER_XDAY` | As above, candidates carried across sessions, plus a 09:31 ET pre-open checkpoint | Overnight positions (FIS 2→3 Nov, MCD 3→4 Nov) and GTC orders |
| `NO_BROKER` | Broker sync off | Missing broker data |
| `SYNTH_EXPOSURE` | **Synthetic, labelled:** 1 manual open position + 1 manual pending order + 1 broker-only position + 1 broker-only working entry; deterministic statuses (first two scored candidates FILLED / PENDING, next two EXPIRED / SKIPPED) | Multiple positions and pending orders, unmatched broker items, rejected / expired alerts |
| `SYNTH_UNVERIFIED` | Same, broker response unverified, last verified broker position kept | Stale / unavailable broker data |

For each evaluation, both trees emit:
- every row's candidate (entry, stop, target, quantity, value, risk, reward, initial score, frozen capital efficiency);
- the ranked result (total, setup, fit, tier, rank, eligibility, components, hard-fail codes, allocation, recommendation, the row's own portfolio snapshot);
- the decision, lifecycle and v1.2 shadow score;
- exposure adjustments, frozen alert-time snapshot ids and contents, and broker reconciliation (`reconcileBroker`);
- the Opportunity Ranker's complete portfolio (`reconcileExposure` + `rankCandidates`, as `App.tsx` does);
- the summary-card portfolio:
  - production: `portfolioSummary(rows)`, the first row's own-candidate-excluded snapshot;
  - fix: `portfolioSummary(QueueOutput.portfolio)`;
- the same summary with rows reordered (committed rows first; reversed).

## 4. Coverage

| Case | Present |
|---|---|
| Sessions | 5 (2–6 Nov 2026) |
| LONG / SHORT row evaluations | 155,520 / 217,180 |
| Score bands (scored row evaluations) | 85–89: 174 · 80–84: 963 · 75–79: 1,009 · < 75: 11,126 (no ≥ 90 in the archive) |
| Candidate statuses | NEW 346,244 · PENDING 1,892 · FILLED 2,200 · CANCELED 768 · EXPIRED 1,506 · SKIPPED 1,506 · STOPPED_OUT 306 · TARGET_HIT 140 · no candidate (data error / blocked) 18,138 |
| Repeated alerts for the same ticker | yes (e.g. DLTR ×5 on 2 Nov; duplicates blocked by existing rules) |
| Broker trades reconciled | 1,416 evaluations |
| Broker releases (verified closes) | 753 |
| Broker-only working entries / positions | 1,678 / 1,134 evaluations |
| Broker verified / unverified / last-known kept | 3,407 / 2,268 / 1,134 |
| Overnight positions | FIS (2→3 Nov), MCD (3→4 Nov); CTVA 5,000-sh GTC stop open 29 Oct → 3 Nov |

## 5. Before / after examples (archived data)

Production summary vs corrected summary for the **same** portfolio state:

| Evaluation | Situation | Production card | Corrected card (= Ranker) |
|---|---|---|---|
| 2 Nov, HIST_BROKER, step 68, committed rows listed first | GM pending + broker-only CTVA GTC stop | 1/4 slots · reserved $56,650 · available $23,350 · heat $250 | **2/4** · reserved $76,601.81 · available **$3,398.19** · heat **$305.75** |
| 2 Nov, step 79, committed rows first | + FIS pending | 2/4 · available $3,398.19 · heat $305.75 | **3/4** · reserved $96,581.77 · available **−$16,581.77** · heat **$405.55** |
| 3 Nov 09:31 pre-open (XDAY) | FIS held overnight + CTVA GTC stop | **— (blank)** | 2/4 · 1 open + 1 pending · deployed $19,979.96 · available $3,370.04 · heat $349.80 |
| 4 Nov 09:31 pre-open (XDAY) | MCD held overnight | **— (blank)** | 1/4 · deployed $19,758.75 · available $60,241.25 · heat $183.00 |
| 2 Nov 09:31 pre-open (XDAY) | CTVA GTC stop working from 29 Oct | **— (blank)** | 1/4 · reserved · heat $250 |
| 5 and 6 Nov 09:31 pre-open | nothing held | — (blank) | 0/4 · available $80,000 |

The negative available capital on 2 Nov is the existing allocator's real result (reservations exceeded the $80,000 usable allocation). Previously it was hidden whenever the first row omitted one reservation.

**Why the old card was usually right in the natural sort order.** In these sessions, data-review rows (NEW candidates with a score) always sorted above the committed rows. The first scored row therefore never excluded a reservation in the natural order (5,630 identical summaries). The defect appears when the top row is committed (2,571 cases in the reordering probe, reproduced by the unit tests). It also appears when there are no scored rows while exposure exists (45 cases), for example in the morning with an overnight position.

## 6. Acceptance criteria

| Criterion | Status |
|---|---|
| Opportunity Scores identical | ✔ (372,700 rows) |
| Scoring components identical | ✔ |
| Entry / stop / target / quantity identical | ✔ |
| Candidate eligibility and hard-rule outcomes identical | ✔ |
| Allocation decisions and rank identical | ✔ |
| Broker reconciliation identical | ✔ (exposure adjustments and TradeSync) |
| Underlying portfolio calculations identical | ✔ (row snapshots and Ranker portfolio identical) |
| Historical alert-time snapshots unchanged | ✔ (ids and frozen contents identical) |
| Corrected summary = Ranker complete portfolio | ✔ 5,675 / 5,675 |
| No failing or skipped replay cases | ✔ (0 skipped; every evaluation compared) |

## 7. Limitations

- The 30 Oct session archive was not available locally; the 5 sessions above were used.
- Broker statuses and positions are reconstructed from archived order timestamps (not live snapshots). Positions are derived from fills, and market value is taken at the fill price.
- Prices are the alert-time quotes from the archive (no intraday tick replay). This affects live states identically in both trees; it does not weaken the before/after equality.
- Synthetic exposure modes are deterministic fixtures and are labelled as such.
