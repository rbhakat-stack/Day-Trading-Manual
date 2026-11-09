# RB Defect 1 — One authoritative account equity

Branch `rb-defect1-authoritative-equity`, based on production `32ba0c7` (checkpoint tag `rb-v1.1-pre-defect1-20261109`). Not merged, pushed or deployed.

## Root cause

Account equity was stored twice, and both copies were editable while RB v1.1 is frozen (equity is not part of the strategy fingerprint):

| Copy | Storage | Used for |
|---|---|---|
| Settings → "Default account equity" | `rbv1.settings.v1` → `accountEquity` | Trade sizing: max dollar risk → quantity (Calculator prefill, Live Queue candidates, `inputsFromRecord`) |
| Ranker → Portfolio policy → "Account equity $" | `rbv1.ranker.settings.v1` → `portfolio.accountEquity` | Allocation: usable capital, heat limit, per-trade risk limit (`RISK_LIMIT`), conservative broker-only risk |

When they differed, a trade could be sized on one equity and checked against limits computed from the other. Example: Settings $150,000 / Ranker $100,000 → sized at $375 risk, then blocked by `RISK_LIMIT` ($250).

## Change

- `engine/accountEquity.ts` (new): `effectiveAccountEquity` (the one value), `withEffectiveEquity` (calculation views; the same objects when there is no conflict), `syncAccountEquity` (write rule), `equityConflictText`.
- `App.tsx`:
  - `proposeSettings` applies `syncAccountEquity`: an equity edit on either screen writes both stored fields.
  - Every calculation receives `rbEff` / `rkEff`: Live Queue `rb` / `rk`, Ranker ranking, exposure reconciliation (conservative risk, max position), `snapshotOf`, sample day, Calculator prefill and clear, `inputsFromRecord`.
  - Editors still receive the stored values.
  - A conflict banner offers the two explicit choices.
- `SettingsPanel.tsx`, `RankerSettingsPanel.tsx`: help text only ("same field").
- Tests: `engine/__tests__/accountEquity.test.ts` (18).

Not changed:
- risk 0.25 % and the $20,000 cap (both copies are strategy-locked and part of the frozen fingerprint);
- slots, reserve and heat %;
- scoring, Policy A/B and registry, trade construction, lifecycle;
- broker logic, Defect 2, snapshots and Journal;
- the server.

## Migration

- **Copies agree** (normal): no change at all; the same objects are passed through.
- **Copies differ** (existing browser):
  - The stored values are preserved.
  - A banner shows both values.
  - Until the user chooses, every calculation uses the LOWER value, so it is never a silent risk increase.
  - The conflict is re-derived on every load (refresh-safe).
  - Choosing writes both copies.
- **Editing another field** never resolves a conflict.
- **Rollback compatibility:** the Ranker field remains as a write-through mirror, so an older build reads the same value.
- **Supabase:** maps to one parameter, `account.equity`. The mirror and the conflict path disappear when the browser stores become caches.
