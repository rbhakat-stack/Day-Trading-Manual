# Rollback — Live vs. Alert-Time Comparison UI

This release is **presentation only**. It adds no localStorage key, no stored field, no schema, no migration, no
Netlify function and no environment variable. Rolling it back therefore needs **no data restoration**: Journal records
and browser storage written while it was live are read unchanged by the previous release, and vice versa.

## Checkpoint

| Item | Value |
|---|---|
| Rollback tag (annotated, on GitHub) | `prod-pre-live-alert-comparison` |
| Commit | `60c6600411494051e5b6def6943f3c01651b3416` (compact Live Alert Queue UI on top of S2a safety completion) |
| Netlify site | `tradedecider` (`a1dd4c11-ed90-4a23-ab6b-33163dee1fd6`) |
| Netlify deploy to restore | `6aebcac9911c71f0acd819fd` |
| Bundle served by that deploy | `assets/index-BJAQVCvY.js` |
| Strategy configuration | RB v1.1 **ACTIVE** (`ACTIVE_LOGIC_VERSION = FROZEN_VERSION`), RB v1.2 **SHADOW** |
| Older checkpoints (unchanged) | `prod-pre-ui-compact` → `b4b4e9c` (deploy `6aebc504…`), `prod-pre-ui-consolidation` → `874813a` (deploy `6aeba641…`) |

Verify the checkpoint at any time:

```bash
git rev-parse 'prod-pre-live-alert-comparison^{commit}'          # 60c6600411494051e5b6def6943f3c01651b3416
git ls-remote origin 'refs/tags/prod-pre-live-alert-comparison^{}'
```

## Recovery procedure (owner approval required for every production step)

1. **Restore the site (no build, seconds):** Netlify → Deploys → deploy `6aebcac9911c71f0acd819fd` → *Publish deploy*,
   or the API call `POST /api/v1/sites/a1dd4c11-ed90-4a23-ab6b-33163dee1fd6/deploys/6aebcac9911c71f0acd819fd/restore`.
2. **Verify:** the page loads `assets/index-BJAQVCvY.js`; sign-in works; data functions refuse requests without a
   session (401); the Live Alert Queue expanded row shows the previous compact panel (no AT ALERT row).
3. **Git (only if the release commit had reached `main`):** add a normal `git revert <release commit>` on `main` and
   push it so the next automatic build does not republish the release. Never force-push, never move or delete tags.
4. **Data:** nothing to restore. Do not clear browser storage; the write-once alert snapshots
   (`rbv1.v12.alertSnapshots.v1`) existed before this release and are kept by both versions.

## Rehearsal (isolated — production untouched)

The rehearsal builds the tagged commit from a clean `git archive` in a scratch folder and serves it on a local
isolated origin:

1. `git archive prod-pre-live-alert-comparison calculator | tar -x -C <scratch>`; install-free build with the
   project's toolchain (`vite build`).
2. The built `index-*.js` must be **byte-identical** to the bundle production serves for deploy `6aebcac9…`
   (`index-BJAQVCvY.js`).
3. The rehearsal build is opened against the local mock functions and the Live Alert Queue renders.

Result for this release: recorded in the release report.

## Known limitations

- Netlify keeps previous deploys; restoring depends on deploy `6aebcac9…` still being listed (it is not deleted by
  this release). If it were ever pruned, rebuild from the tag (step 3 above) instead.
- The alert-time row reads this browser's write-once snapshots. Rolling back hides that row but loses nothing.
