# Milestone 01 - Account identity, profile dirs, add-account wizard

Depends on: nothing. Foundation for everything else. See `00-overview.md`.

## Goal
Introduce the concept of a Claude account as first-class data. Each account owns an app-created
`CLAUDE_CONFIG_DIR` profile dir (credentials only; everything else funnels to `~/.claude` via
junctions/symlinks) plus a per-account web cookie. Ship the "add account" wizard: create dir ->
interactive `/login` -> identity read -> cookie grab -> cross-check -> auto-fill name/icon.

## Context (current single-account reality)
- `src-tauri/src/auth/session.rs` reads/writes ONE `sessionKey` cookie to `<data_dir>/session.txt`
  (`settings/paths.rs:105-107`); no account id anywhere in the signatures.
- Login: `auth/login_flow.rs:151-236` drives a real browser via CDP on fixed port 9242
  (`:15`), profile at `<appdata>/chrome-login-profile` (`:160-163`), extracts the `sessionKey`
  cookie for `claude.ai` (`:225`).
- `scraping/client.rs:11-12` deserializes the org-list response into `OrgListEntry { uuid }` ONLY;
  name/email/org-name are discarded (`:60-62` takes `orgs.first().uuid`).
- The CLI's own creds (`~/.claude/.credentials.json`) are only READ (`ipc/models.rs:27,66`), never
  written by this app. That read-only discipline now extends to every profile dir.
- `AppState.auth_state: Mutex<AuthState>` (`state.rs:11`) is one global enum.
- A hand-built profile dir `~/.claude-fibo` already exists on Joe's machine with exactly the
  layout this milestone automates - use it as the junction-recipe reference.

## Approach
1. **Account struct + store (typed Rust, app-data).**
   `Account { id, label, colour, icon, config_dir, chrome_profile_dir, email, org_uuid,
   subscription_tier, created_at }`.
   A new `accounts` module owning a persisted `Vec<Account>` in app-data (mirror how settings
   persist). Add `default_account_id: Option<String>` (global, in `Settings`). No CLI-token field
   anywhere - CLI credentials live in the profile dir, owned and refreshed by Claude Code itself.
2. **Profile-dir factory.** `create_profile_dir(slug)` builds `~/.claude-<slug>`:
   - Junction (dirs): `projects`, `todos`, `sessions`, `skills`, `commands`, `plugins`, `refs`,
     `code-style`, `snippets` -> the same dir under `~/.claude`. Junctions need no admin on
     Windows; macOS/Linux use symlinks. Create missing targets in `~/.claude` first.
   - Symlink (files): `CLAUDE.md`, `settings.json`, `settings.local.json`. On Windows, PS 5.1
     `New-Item -ItemType SymbolicLink` demands admin even with Dev Mode; use `cmd /c mklink`
     (works under Dev Mode) or the Rust `std::os::windows::fs::symlink_file` equivalent.
   - Any failure -> delete the half-made dir and abort with a clear error. Never leave a broken
     profile.
   - Dir already exists (e.g. `~/.claude-fibo`): offer adoption - proceed to the login step, and
     if the verified identity matches what the dir already holds, register it as-is; otherwise
     require a different slug. Never modify an existing dir's credentials. Adoption re-runs the
     factory's link pass to fill in any MISSING junctions (the hand-built `~/.claude-fibo` has a
     real `sessions/` dir today, not a junction - merge its contents into `~/.claude/sessions/`
     then replace with the junction).
3. **Interactive `/login` step.** There is no headless login. The wizard spawns a visible terminal
   with `CLAUDE_CONFIG_DIR=<dir>` running `claude`, instructs the user to run `/login` and pick
   the right account, and polls `<dir>/.claude.json` for `oauthAccount` to appear/refresh
   (`profileFetchedAt` newer than step start). Timeout or user-cancel -> clean up the dir.
   **Never** run `claude setup-token`; **never** copy an existing `.credentials.json` into the
   dir (single-use rotating refresh tokens - see 00's locked decisions).
4. **Identity read + dedup.** Parse `oauthAccount` `{emailAddress, organizationUuid,
   organizationName, organizationType}`. If `org_uuid` or email matches an existing account:
   reject with "already added as <label>" and clean up. Show "Logged in as <email> (<tier>)" for
   the user to confirm before continuing.
   **Browser-first reorder (2026-07-08):** the wizard now runs the BROWSER login before the CLI
   step, because the cookie alone yields the full identity via `GET /api/account` (validated
   live: returns `email_address` + org memberships with `uuid`/`name`/`capabilities`; pick the
   chat-capable org, since one account can also hold an API-only Console org). Flow:
   `add_account_create` (dir only, no terminal) -> `add_account_capture_cookie` (cookie +
   identity + dedup) -> if the dir already has a valid `.credentials.json`, skip straight to
   finalize; otherwise `add_account_start_cli_login` spawns the `/login` terminal and
   `add_account_check_login` polls, cross-checking the CLI's `oauthAccount` against the browser
   identity. Background: the CLI only writes `oauthAccount` during the live `/login` handshake -
   ordinary startups against already-valid credentials never backfill it, so a dir can sit in
   "valid credentials, no `oauthAccount`" forever (`LoginPollResult::CredentialsNoProfile`); the
   browser identity resolves that state. The browser step is skippable; the flow then degrades
   to the original CLI-identity path.
5. **Web cookie capture, per-account.** Reuse `login_flow.rs` but give each account its OWN chrome
   profile dir (avoid cookie collision) and store the `sessionKey` per account (keyed file
   `session-<id>.txt` or credential store - keep the existing storage pattern, just keyed).
6. **Cross-check the two planes.** With the fresh cookie, fetch the org/account info (widen
   `OrgListEntry` to capture `name`/email) and compare against `oauthAccount`. Mismatch = the
   browser logged into a different account than the CLI did; block saving and say exactly that.
   This is the guard that turns a weeks-later billing surprise into an onboarding error message.
7. **Auto-detect name/icon.** Prefill the label from org name/email; auto-pick an icon from a
   pool, skipping icons already used by other accounts; user can reroll/edit. Colour picker too.
8. **Terminal identity (observed, read-only).** A small `terminal_identity()` helper reads
   `~/.claude.json` -> `oauthAccount` (note: HOME-dir file, not inside `~/.claude`) so the UI can
   label terminal sessions and show "Terminal: currently <email>". Not an account; not in the
   registry.
9. **Remove-account.** Drop the record; delete its profile dir, chrome profile dir, and stored
   cookie. Deleting the profile dir removes only real files + the junction/symlink entries
   (junction deletion does NOT recurse into targets - verify with a test). `~/.claude` is never a
   deletion target because it is never in the registry.
10. **Logout vs remove.** Per-account "log out" = delete the cookie + mark auth invalid (chats
    stop spawning for it) but keep the record + dir; "remove" is the full teardown. Neither
    touches app data (characters, projects, chat history).

## Files
- New `src-tauri/src/accounts/` module (struct, store, profile-dir factory, identity read).
- `src-tauri/src/auth/session.rs`, `auth/login_flow.rs` (per-account profile + keyed store).
- `src-tauri/src/scraping/client.rs:11-12` (widen `OrgListEntry`).
- `src-tauri/src/types/notifications.rs` (`Settings.default_account_id`).
- `src-tauri/src/settings/paths.rs` (per-account cookie/chrome-profile paths).
- IPC: `add_account` (wizard steps), `list_accounts`, `remove_account`, `logout_account`,
  `set_default_account`, `get_terminal_identity` + `export_types.rs` entry, regen
  `cargo test --test export_types` (`project_ipc_generated_source_of_truth`).

## Acceptance
- Add two accounts end-to-end; each gets its own profile dir with working junctions (a skill
  edited in `~/.claude` is instantly visible through the profile dir), its own `/login`
  credentials, and its own cookie; name/email arrive prefilled; icons never collide.
- Adding the same account twice is rejected at the identity step with the existing label named.
- A deliberate mismatch (CLI login account A, browser login account B) is caught by the
  cross-check and blocked.
- Credentials and cookies are absent from settings JSON and logs (grep the on-disk settings +
  log). The app never writes any `.credentials.json`.
- Removing an account deletes its dir without touching `~/.claude` content through the junctions.
- An API-key / non-subscription login is refused with a clear message.
