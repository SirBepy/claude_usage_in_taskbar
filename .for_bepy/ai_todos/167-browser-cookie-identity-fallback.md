# Fall back to browser-cookie identity when the CLI never writes oauthAccount

**Type:** task

## Goal
Let the add-account wizard finish even when a profile dir has valid `.credentials.json` but the CLI never wrote `oauthAccount` into its `.claude.json` - by deriving identity (org uuid + org name) from the browser-cookie step instead of blocking forever on the CLI side.

## Context
- Real repro on Joe's machine: `~/.claude-fibo` has a valid, unexpired `.credentials.json` (used it for `numStartups: 19` real sessions) but `.claude.json` has never gotten an `oauthAccount` block. Whatever writes that block apparently only happens during the live `/login` handshake itself, not on ordinary CLI startups against an already-valid token - so "just run a command in that terminal" (the workaround shipped in `3df971ac`) does NOT reliably fix it. Confirmed false for this exact profile.
- Current chain: `src-tauri/src/accounts/login_step.rs` `poll_login()` now returns `Ready` / `CredentialsNoProfile` / `Pending`. `CredentialsNoProfile` only gets a nicer message in the wizard (`add-account-wizard.ts` renderLoginStep) - it still polls forever, there's no escape hatch.
- The wizard's step 3 (`add_account_capture_cookie` in `src-tauri/src/ipc/accounts.rs`) already calls `crate::scraping::client::fetch_org_list` (`src-tauri/src/scraping/client.rs:53`), which hits `claude.ai/api/organizations` via the session cookie and returns `Vec<OrgListEntry { uuid, name }>` - real account identity, zero extra manual steps beyond the browser login the user does anyway. But it currently only runs as a CROSS-CHECK against an already-`Ready` CLI identity (`add_account_capture_cookie` hard-requires `session.verified_identity` to be `Some` first - see the `.ok_or_else("call add_account_check_login until Ready...")` guard).
- **Known gap in this endpoint:** `/api/organizations` returns `uuid` + `name` only - no email. So a cookie-only identity has no email field. Decide how the UI shows "logged in as" without one (e.g. show org name only, or "unknown email").
- **Do NOT assume `/api/organizations` or another claude.ai endpoint can return email** - this was not verified this session, only asserted as a known gap. If it turns out some other claude.ai endpoint (already authenticated by the same cookie) DOES return email, that's better than a fallback with no email at all - check before assuming the gap is permanent.

## Approach (validate before building)
This is a genuine "have Opus verify this holds up" candidate before writing code - the idea came from inline reasoning, not confirmed against real API responses, and the whole point is not to ship another guess that turns out false like the last one did.

1. **Validate first:**
   - Confirm (with a real cookie, e.g. Joe's fibo browser session) what `GET https://claude.ai/api/organizations` actually returns - re-verify `uuid`/`name` are present and check for any other identity-bearing field (email, display name) that isn't currently deserialized in `OrgListEntry` (`scraping/client.rs:15-20`) but might be in the raw JSON.
   - Confirm there's no better-suited claude.ai endpoint (e.g. something like `/api/bootstrap`, `/api/account`) reachable with the same cookie that DOES return email - grep the web app's network requests if possible, or search for prior art.
   - Re-confirm the actual condition under which the CLI writes `oauthAccount` (only `/login` handshake vs. also lazily on interactive turns) so the `CredentialsNoProfile` UI copy can be corrected/removed if it's misleading.
2. **If validated, build the fallback:**
   - Relax `add_account_capture_cookie`'s guard so it can run when `poll_login` is `CredentialsNoProfile` (valid creds, no CLI identity) and NOT only when `Ready`.
   - When the CLI never produces `oauthAccount`, treat the cookie's `org_uuid` + `org_name` as the account's identity for dedup (`accounts_store::find_duplicate`) and labeling (`prefillLabel` in `wizard-logic.ts`) - `email_address` needs a sentinel (`None`/empty) plumbed through `OauthAccountInfo` and every render site that shows it (`renderLoginStep`, `renderCookieStep`, Settings > Accounts identity surface `buildIdentitySurface` in `wizard-logic.ts`).
   - Wizard UI: when stuck on `CredentialsNoProfile` past some threshold (or immediately - TBD by the validation step), offer a "skip to browser login" action instead of only "I've logged in - check now".
   - Update the `docs/multi-account/01-account-identity.md` step-4 identity-read description once the fallback path exists, since it currently only describes the CLI-`oauthAccount`-required path.

## Acceptance
- Repro: an add-account wizard run against a profile dir with valid credentials but no `oauthAccount` (e.g. `~/.claude-fibo` as-is, no changes to it) completes successfully end to end, landing on a real, correctly-deduped account with org name populated.
- Existing CLI-identity-available path is unchanged (still the preferred/faster path when `oauthAccount` is present).
- Rust + frontend test suites still pass; new tests cover the fallback identity path (dedup by org_uuid without email, label prefill without email).
- No regression to the cookie-capture cross-check used by the existing CLI-identity-present path (`Mismatch` detection).
