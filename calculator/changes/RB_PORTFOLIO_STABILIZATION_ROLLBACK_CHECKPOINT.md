# RB Portfolio Stabilization — Rollback Checkpoint

Recorded 2026-11-08 (Sunday), before any Defect 3 code change. Verified read-only against Netlify, GitHub and the live site.

## 1. Verified production state

| Item | Value | How verified |
|---|---|---|
| Netlify site | `tradedecider` · id `a1dd4c11-ed90-4a23-ab6b-33163dee1fd6` · https://tradedecider.netlify.app | `netlify api listSites` |
| Published deploy | **`6aee715816e7ee46a30bab41`** · state `ready` · context `production` · branch `main` | `netlify api getSite` (published_deploy) + `getDeploy` |
| Commit | **`7122934ab4c250a41289033ed9e8c77fe981ce1f`** — "Policy B: policy-state-aware Score / Tier / Decision help; 82-point exception eligibility tests" | deploy `commit_ref` |
| Deploy created / published | 2026-11-07T00:31:20.911Z / **2026-11-07T00:31:46.901Z** (deploy time 24 s, not a manual deploy) | `getDeploy` |
| Functions | rb-alerts, rb-auth, rb-broker, rb-health, rb-historical-parity, rb-quotes, trendspider-alert | `getDeploy.available_functions` |
| Live site = this deploy | `index.html` from https://tradedecider.netlify.app/ and from the deploy permalink `https://6aee715816e7ee46a30bab41--tradedecider.netlify.app/` are byte-identical (SHA-256 `221e63c6…cdb359d`; assets `index-DcYeaaAv.js`, `index-BAgegB4e.css`) | `curl` + `sha256sum` |
| GitHub `origin/main` | `7122934` (same commit) | `git ls-remote origin main` |
| Earlier deploy of the same commit | `6aee6dda0fc99510d78aaf50` (00:16 UTC, superseded 15 min later by `6aee7158…`) | `listSiteDeploys` |

The audit commit `7122934` is confirmed still deployed. The deploy ID in the older project memory (`6aee6dda…`) is the earlier, superseded deploy of the same commit.

### Production configuration (names and feature flags only; no secret values were read or recorded)

| Variable | Contexts | Value |
|---|---|---|
| `RB_AUTH_ENABLED` | all | `true` (CR-16 login ON) |
| `RB_BROKER_SYNC_ENABLED` | all | `true` |
| `RB_CR15_CROSSDAY_RECONCILIATION_ENABLED` | all | `true` |
| `RB_REFERENCE_SCORES_ENABLED` | all | `true` |
| `RB_RVOL_V1_OBSERVATION_ENABLED` | all | `true` |
| `RB_RVOL_POLICY_A_ENABLED` | all | **`false`** |
| `RB_RVOL_POLICY_B_ENABLED` | all | **`false`** |
| `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `RB_APP_ACCESS_TOKEN`, `RB_AUTH_PASSWORD_HASH`, `RB_AUTH_SESSION_SECRET`, `TRENDSPIDER_WEBHOOK_SECRET` | production / deploy contexts | secret — not shown |
| `ALPACA_DATA_BASE_URL`, `ALPACA_DATA_FEED`, `RB_AUTH_USERNAME` | all | not shown |

> **Note for Monday's Policy A/B market test:** both Policy flags are currently `false` in production. Nothing in this checkpoint changed them. If the test is meant to exercise Policy A/B as active, that is a separate, explicit configuration decision.

## 2. Working-tree state (preserved)

Main checkout `C:\Ranabir - C Drive\GitHub\Day Trading Manual`, branch `rb-v1.2-phase3b` (`c3f42db`, not production):

- `M .gitignore` — untouched
- `?? RB_Trade_Decider_End_User_Manual.pdf`, `?? RB_Trade_Decider_End_User_Manual.pptx`, `?? RB_Trade_Decider_V1_4_Multi_Strategy_Blueprint.docx` — untouched

All Defect 3 work happens in a separate worktree (`…\scratchpad\wt-d3`, branch `rb-defect3-portfolio-summary`, created from `7122934`). The main checkout, its branch and its files are not modified.

## 3. Rollback tag

| Item | Value |
|---|---|
| Tag | `rb-v1.1-pre-portfolio-stabilization-20261108` (did not exist before; created, not moved) |
| Type | annotated (tag object `2b3abcd8787e8263f8f25cdfebeb73f2cbb60e3b`, tagger date 2026-11-08 14:57:15 −05:00) |
| Points to | `7122934ab4c250a41289033ed9e8c77fe981ce1f` ✔ (`git rev-parse rb-v1.1-pre-portfolio-stabilization-20261108^{commit}`) |
| Pushed? | **No** — local only, per instructions (`git ls-remote --tags origin <tag>` returns nothing) |
| Recoverability | The commit is on `origin/main` and `origin/rb-v1.1-policy-b` on GitHub, so it stays recoverable even if this local repository were lost. Existing tag `prod-pre-policy-b` → `cd86379` (the previous production) is unchanged. |

To publish the tag later (only with approval): `git push origin rb-v1.1-pre-portfolio-stabilization-20261108`

## 4. Restore procedure

### A. Fastest: re-publish the verified deploy (no rebuild, seconds)

Netlify keeps the built deploy. Re-publishing it restores exactly the bundle and functions verified above:

```bash
netlify api restoreSiteDeploy --data '{"site_id":"a1dd4c11-ed90-4a23-ab6b-33163dee1fd6","deploy_id":"6aee715816e7ee46a30bab41"}'
```

(Equivalent UI: Netlify → tradedecider → Deploys → `6aee7158…` → "Publish deploy".) Then verify:

```bash
netlify api getSite --data '{"site_id":"a1dd4c11-ed90-4a23-ab6b-33163dee1fd6"}'
```

Check `published_deploy.id` = `6aee715816e7ee46a30bab41` and the live `index.html` SHA-256 = `221e63c6…cdb359d`.

If auto-publishing is on, the next push to `main` publishes again. Do source step B before any further push.

### B. Source: bring `main` back to the tagged code (no force push)

If a portfolio-fix commit has been merged to `main`, revert it with a normal commit:

```bash
git checkout main
git pull --ff-only
git revert --no-edit <merge-or-fix-commit>
git diff rb-v1.1-pre-portfolio-stabilization-20261108 -- calculator
git push origin main
```

The `git diff` must print nothing, or only intended unrelated changes. Never move the tag, and never force-push `main`.

### C. Rebuild from the tag (if the Netlify deploy were unavailable)

```bash
git worktree add --detach ../rb-restore rb-v1.1-pre-portfolio-stabilization-20261108
cd ../rb-restore/calculator && npm ci && npm run build
netlify deploy --prod --dir dist --functions netlify/functions --site a1dd4c11-ed90-4a23-ab6b-33163dee1fd6
```

## 5. What a code rollback does NOT reverse

| Layer | Restored by A/B/C? | Notes for this change (Defect 3) |
|---|---|---|
| Front-end bundle and functions | Yes | — |
| Netlify environment variables and flags | **No** — independent of deploys | Defect 3 changes no variable. Rollback needs no env change. Record flags before and after any deploy (table above). |
| Browser localStorage (settings, candidates, positions, Journal, snapshots, release latches, broker snapshot) | **No** — lives in each browser | Defect 3 adds no storage key and changes no persisted shape. Nothing to migrate or restore. Do not clear or "roll back" browser storage: it holds the Journal and write-once audit records. |
| Netlify Blobs (server alert archive `rb-alerts`) | **No** | Defect 3 does not touch the server or the archive. Archived records are immutable and must not be rewritten. |
| Supabase (`pnqifipwrrwsyekpxxto`) | **No** | Not used in production. Defect 3 does not touch it. |
| Alpaca PAPER orders / positions, TrendSpider alerts | **No** | Never touched by the app (read-only broker GETs). |

Conclusion: for the Defect 3 display change, restoring the code is a complete rollback. There is no data, settings or environment state to restore. For future phases that change settings or persisted shapes (Defects 1 and 2, Supabase), each change needs its own forward/backward migration plan before deployment.

## 6. Current status

No deploy, merge or push has been made. Production remains deploy `6aee715816e7ee46a30bab41` / commit `7122934`, unchanged for Monday's Policy A/B market test.
