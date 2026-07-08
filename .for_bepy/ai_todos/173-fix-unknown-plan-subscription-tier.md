# Fix "Unknown plan" showing for accounts added via browser-first flow

**Type:** task

## Goal

Settings > Accounts should show the real subscription tier (Pro/Max/Team/etc)
for every account, not "Unknown plan" - currently at least one account
(`fibo`, org `josip.muzic@fibo.hr`) shows "Unknown plan" despite having a
real paid Claude subscription.

## Context

Found 2026-07-08 while redesigning the accounts row UI. `personal` correctly
shows "Max"; `fibo` shows "Unknown plan" and also has an expired token.

Root cause trace: `wizard-logic.ts`'s `tierLabel()` returns "Unknown plan"
when the tier string is falsy (empty string counts as falsy in JS). The
empty string comes from `src-tauri/src/ipc/accounts.rs:394`
(`add_account_finalize`): `subscription_tier:
identity.organization_type.unwrap_or_default()`. That field is `None` when
the identity came from the **browser-first** capture path
(`add_account_capture_cookie`, `ipc/accounts.rs:290`): `organization_type:
org.subscription_tier()`, where `org` is a `WebOrg` from
`src-tauri/src/scraping/client.rs`. So `WebOrg::subscription_tier()` returned
`None` for fibo's org at add-time.

`buildIdentitySurface` (`wizard-logic.ts`) does fall back to a **live** read
(`identity?.oauthAccount?.organizationType`) when available, which would
paper over a bad registry value - but that only works if the account has a
valid CLI login with `oauthAccount` written to the profile dir. Fibo's token
is expired, so that live path likely isn't returning a fresh value either
(worth checking whether `identity::read_oauth_account` is failing too, or
just returning a stale/also-empty value).

## Approach

1. Read `WebOrg::subscription_tier()` in `src-tauri/src/scraping/client.rs`
   and figure out why it returns `None` for some orgs - likely a shape in
   the `/api/account` response fibo's org has that others don't (e.g. a
   different plan-name string not in the match arms, or a missing field).
2. Consider whether `add_account_finalize` should refuse to unwrap_or_default
   silently - or at minimum log a warning - when `organization_type` is
   `None`, so this doesn't happen silently for future adds.
3. Decide whether to backfill fibo's existing registry record once the root
   cause is fixed (one-time manual data fix vs. a migration), or just fix the
   parser and tell Joe to re-run `Reauth`/recapture so it picks up the tier
   next login.

## Acceptance

- Fibo's row (and any other affected account) shows an actual tier, not
  "Unknown plan", after whatever fix + recapture/reauth step is needed.
- `tierLabel()`/`buildIdentitySurface()` unit tests
  (`tests/wizard-logic.test.mjs`) still pass unchanged - this is a backend
  data-population bug, not a frontend labeling bug.
- New account adds via the browser-first flow populate a real tier for org
  shapes that previously mapped to `None`.
