# CR-16 — Username / password authentication (isolated feature)

Security layer around the existing application. No trading, scoring, portfolio, Journal, CR-15, webhook or broker
logic was changed. The feature is **inactive until the server enables it**.

## What it does

| Piece | File | Role |
|---|---|---|
| Server sessions | `netlify/lib/session.ts` | scrypt password check, random 256-bit session id, server-side session records (Netlify Blobs store `rb-auth-sessions`, strong consistency, only `sha256(id)` stored), absolute 12 h expiry, per-IP login throttle (5 failures / 15 min), `requireSession` guard |
| Login endpoint | `netlify/functions/rb-auth.mts` | `GET` status · `POST {"action":"login"}` · `POST {"action":"logout"}` |
| Endpoint guard | `rb-alerts`, `rb-broker`, `rb-health`, `rb-quotes`, `rb-historical-parity` | one guard call before the existing code; the existing `RB_APP_ACCESS_TOKEN` check still runs (both are required when auth is on) |
| Login screen | `src/auth/LoginScreen.tsx`, `src/auth/AuthGate.tsx`, `src/auth/authClient.ts` | the app is rendered only after the server says "signed in" (or "auth disabled"); a small **Log out** control at the bottom right |
| Hash tool | `scripts/hash-password.mjs` | produces `RB_AUTH_PASSWORD_HASH` (password read hidden from the terminal, never stored) |

**Not behind the session guard:** `trendspider-alert` (TrendSpider cannot sign in; it keeps its own
`TRENDSPIDER_WEBHOOK_SECRET`). The static HTML/JS bundle is still downloadable (it contains no secrets and no data —
your trading data lives only in your browser); every piece of server data is refused without a session.

Session cookie: `__Host-rb_session`, `HttpOnly; Secure; SameSite=Strict; Path=/`, 12 h. JavaScript cannot read it.
Nothing is written to `localStorage`; logging out ends the server session and clears the cookie only — the Journal,
candidates, snapshots, CR-15 backups and notes are untouched.

## Configuration (Netlify → Site configuration → Environment variables)

| Variable | Value | Notes |
|---|---|---|
| `RB_AUTH_ENABLED` | `true` to enforce | unset / `false` / `0` / `off` = inactive (legacy behaviour). Any other value counts as ON (a typo fails closed). |
| `RB_AUTH_USERNAME` | your user name | Functions scope |
| `RB_AUTH_PASSWORD_HASH` | output of `node scripts/hash-password.mjs` | mark **secret**, Functions scope. Contains `$` characters — paste it exactly (in PowerShell use single quotes). |

Enabled but username/hash missing or malformed → the login screen says "not configured", sign-in returns 503 and every
protected endpoint returns 401. Authentication is never silently bypassed.

## Activation (each step needs your approval)

1. `cd calculator` → `node scripts/hash-password.mjs` (≥ 12 characters, typed twice, nothing echoed).
2. In Netlify set `RB_AUTH_USERNAME` and `RB_AUTH_PASSWORD_HASH` (leave `RB_AUTH_ENABLED` unset).
3. Deploy the CR-16 commit. With the flag unset the app behaves exactly as before (verify).
4. Set `RB_AUTH_ENABLED=true` and trigger a deploy (environment changes apply to the next deploy).
5. Open the app → sign in → confirm the Live Alert Queue, broker sync and CR-15 AUTO work → Log out → sign in again.

## Recovery

**A. Authentication problem (locked out, lost password, misconfiguration) — keep the code, turn the feature off**
1. Netlify → Environment variables → `RB_AUTH_ENABLED` = `false` (or delete it).
2. Deploys → Trigger deploy → *Deploy site* (same commit, ~1 min).
3. The app opens without sign-in; the existing app access token still protects the endpoints.

**B. New password / revoke every session**
`node scripts/hash-password.mjs` → replace `RB_AUTH_PASSWORD_HASH` → trigger a deploy. Every existing session is
invalid immediately (sessions are bound to a fingerprint of the user name + hash). Changing `RB_AUTH_USERNAME` does the same.

**C. Full code rollback to the pre-CR-16 production build**
- Fastest: Netlify → Deploys → deploy `6aea68cd26821f62309720f0` (commit `17d9092`) → *Publish deploy*; then keep
  auto-publishing locked until a fixed commit is approved.
- Git: tag `prod-pre-cr16-auth` → `17d9092`. Roll back with a revert commit on `main` (no force push, no history rewrite).
- Browser: nothing to undo. The pre-CR-16 build ignores the `__Host-rb_session` cookie (it expires within 12 h) and the
  `rb-auth-sessions` blob store; CR-16 adds no `localStorage` key. Verified in the rollback rehearsal.
- The `RB_AUTH_*` variables may stay set; the old code never reads them.

## Security notes

- Password: scrypt (N=16384, r=8, p=1, 16-byte salt, 32-byte key), constant-time comparison; the user-name check is
  constant-time and the hash is always evaluated (no user-name timing oracle). One generic error message.
- Throttle: 5 failed sign-ins per client IP per 15 min (persistent across function instances) + 20 requests/min per
  instance. A store outage refuses sign-in and access.
- CSRF: `SameSite=Strict`, JSON-only POSTs, cross-origin `Origin` refused; the data endpoints additionally need the
  bearer token header, which a cross-site page cannot send.
- Logs: sign-in success/failure events record only the client IP — never the user name, password, hash or session id.
