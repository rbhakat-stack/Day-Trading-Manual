# RB v1.2 — production SHADOW activation runbook

Status: **prepared, not executed.** RB v1.1 stays the active decision path. RB v1.2 runs in SHADOW only and never offers a ticket or an action. Every step below is manual and needs your go-ahead. No secret value appears in this file. Never paste one into Git, chat, screenshots or logs.

## 0. Preconditions (done in code, CR-012)

* `TRUSTED_RULE_SETS` contains `RBTS-L-001 → LONG` and `RBTS-S-001 → SHORT` (audited 2026-10-31).
* Tests cover the full qualification matrix (valid, conflict, missing, unknown, retired, test webhook) and v1.1 identity with and without `rule_set`. They also check secret hygiene.

## 1. Webhook secret rotation

**Facts that shape the plan:**

* **One secret only.** The endpoint accepts exactly one secret, `TRENDSPIDER_WEBHOOK_SECRET`, compared in constant time.
* **Redeploy required.** Netlify applies a changed environment variable to Functions only on the next deploy.
* **One copy per alert.** The secret is in the note of **every** ticker-specific TrendSpider alert. From the moment Netlify has the new secret, every alert that still carries the old one is rejected (401) and its alert is lost.
* **No alerts out of hours.** The audited alerts run with Extended Hours OFF, so none fire outside 09:30–16:00 ET on trading days.

### Plan R — recommended, no code change

Rotate while the market is closed. Change only the token on every alert; add `rule_set` only to the two canaries.

1. **Pick a window.** After 16:00 ET on a trading day, or on a weekend or holiday. Allow enough time to edit every alert before 09:30 ET.
2. **Generate the new secret** locally: at least 32 random bytes, e.g. from a password manager. Keep it only in the password manager, not in a file in this repo or in shell history.
3. **Update Netlify.** Site settings → Environment variables → `TRENDSPIDER_WEBHOOK_SECRET` → new value (Functions scope).
4. **Redeploy.** Deploy the approved branch in this same window (step C in §2), so a single deploy carries the new secret.
5. **Check the endpoint** with a test-mode request (it is never stored):
   * `"test": true` with the new token should return **200** with `"test": true`.
   * `"test": true` with the old token should return **401**.
   * If you use `curl`, read the token from a prompt or an environment variable rather than typing it on the command line.
6. **Edit every TrendSpider alert note.**
   * On all alerts, replace only the `token` value.
   * On the two canary alerts only (one LONG, one SHORT), also add `"rule_set"` (§3).
   * The token edit is unavoidable for all alerts with a single secret; it is not the `rule_set` rollout.
7. **Count the alerts.** Confirm the number of edited alerts equals the number of active RB alerts (LONG and SHORT, every ticker).
8. **Next session:** watch the Netlify function log for `webhook_rejected` with reason `unauthorized`. Any hit is an alert you missed: fix its note.

Mismatch window: only while the market is closed, so no production alert is lost.

### Plan D — alternative, needs a code change (not implemented)

* **What it is:** accept `TRENDSPIDER_WEBHOOK_SECRET` or a temporary `TRENDSPIDER_WEBHOOK_SECRET_PREVIOUS`, both compared in constant time. Log only which one matched (`current` / `previous`), never a value. Remove `PREVIOUS` after a full session with no `previous` matches.
* **Benefit:** there is no mismatch window at any time of day, and alerts can be edited gradually.
* **Cost:** the **compromised** secret stays valid for the overlap.
* **When to choose it:** only if editing every alert in one closed-market window is impractical. It needs your approval as a separate change.

## 2. Activation sequence

| Step | Action | Who |
|---|---|---|
| A | Rule sets registered in code (`2953744`) | done |
| B | Tests, typecheck, build | done (726 / 726) |
| C | Deploy the branch. v1.1 stays active (`ACTIVE_LOGIC_VERSION = RB v1.1`), v1.2 shadow only | you, on approval, in the closed-market window |
| D | Rotate the webhook secret (Plan R §1, same window as C) | you |
| E | LONG canary: one LONG alert gets the new token and `"rule_set":"RBTS-L-001"` | you |
| F | Verify the LONG canary (§3) | you, during the next session |
| G | SHORT canary: one SHORT alert gets `"rule_set":"RBTS-S-001"`; verify the same way | you |
| H | **Only after E–G pass**, add `rule_set` to the remaining alerts (L-001 on every LONG, S-001 on every SHORT) | you |

## 3. Canary procedure

**LONG note** (the symbol stays ticker-specific; use no dynamic placeholder):

```
{"strategy":"RB_V1","symbol":"<TICKER>","direction":"LONG","alert_name":"RB v1 LONG Setup","rule_set":"RBTS-L-001","token":"<NEW SECRET>"}
```

**SHORT note:**

```
{"strategy":"RB_V1","symbol":"<TICKER>","direction":"SHORT","alert_name":"RB v1 SHORT Setup","rule_set":"RBTS-S-001","token":"<NEW SECRET>"}
```

**Choosing the canary:** pick a liquid ticker that triggers often. The alert repeats without limit, so it fires on its own; nothing needs to be forced.

**When the canary fires, verify all of the following:**

1. **Webhook accepted.**
   * The Netlify log shows `candidate_enriched` and `v12_shadow_audit` with `qualification: QUALIFIED`, `ruleSet: RECOGNISED` and `mapping: ON_TIME` (or `DELAYED`).
   * There is no `webhook_rejected`.
2. **RB v1.1 still active.** The queue row's "RB v1.1 decision" behaves exactly as before. Any ticket or action card comes from v1.1.
3. **v1.2 shadow.** The "RB v1.2 shadow" column shows a raw score and a tier. The details panel shows:
   * a **TS QUALIFIED** badge;
   * rule set `RBTS-L-001 (RECOGNISED)` (or `RBTS-S-001`);
   * the correct direction;
   * `TrendSpider RVOL Gate: PASS (>1.5)`;
   * signal mapping with the 5m candle that just closed and the lag in seconds.
4. **Shadow score generated.** The raw score `/ 91`, the Option B tier and the Option A tier are filled in. The "Export v1.2 shadow log" count goes up by one.
5. **No v1.2 action offered.** The details say "Ticket: … (not offered: shadow only)". There is no v1.2 copy, submit or skip control.

**If any check fails:** remove `rule_set` from that canary's note. v1.1 is unaffected either way. Then report the log lines (with no token).

## 4. Shadow data collection

* **The log:** use **Export v1.2 shadow log** (CSV) after each session. For each genuine alert, the first v1.2 score is frozen and holds:
  * ticker, direction, rule set, signal candle and mapping lag;
  * v1.1 decision, score and tier;
  * v1.2 raw score, Option A tier and Option B tier;
  * warnings (SIP parity), DATA REVIEW codes;
  * alert-time ticket geometry (entry, stop, target, shares).
* **The browser caveat:** the log lives in that browser's local storage, so export from the same browser every day.
* **Manual TrendSpider RVOL:** fill the empty `tsRvolManual` column from the alert candle where practical. Prioritise rows whose `capturePriority` lists `HIGH_OR_ELITE_SHADOW`, `A_B_DISAGREE`, `SHORT` or `NEAR_TRADE_THRESHOLD`.
