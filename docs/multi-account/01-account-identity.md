# Milestone 01 - Account identity, credential store, add-account

Depends on: nothing. Foundation for everything else. See `00-overview.md`.

## Goal
Introduce the concept of a Claude account as first-class data, with secure per-account
credentials (CLI token + web cookie), and an "add account" flow that connects first then
auto-fills name/icon. Migrate the current single logged-in identity into account #1.

## Context (current single-account reality)
- `src-tauri/src/auth/session.rs` reads/writes ONE `sessionKey` cookie to `<data_dir>/session.txt`
  (`settings/paths.rs:105-107`); no account id anywhere in the signatures.
- Login: `auth/login_flow.rs:151-236` drives a real browser via CDP on fixed port 9242
  (`:15`), profile at `<appdata>/chrome-login-profile` (`:160-163`), extracts the `sessionKey`
  cookie for `claude.ai` (`:225`).
- `scraping/client.rs:11-12` deserializes the org-list response into `OrgListEntry { uuid }` ONLY;
  name/email/org-name are discarded (`:60-62` takes `orgs.first().uuid`).
- The CLI's own creds (`~/.claude/.credentials.json`) are only READ (`ipc/models.rs:27,66`), never
  written by this app.
- `AppState.auth_state: Mutex<AuthState>` (`state.rs:11`) is one global enum.

## Approach
1. **Account struct + store (typed Rust, app-data).**
   `Account { id, label, colour, icon, subscription_tier, org_uuid, email, created_at }`.
   A new `accounts` module owning a persisted `Vec<Account>` in app-data (mirror how settings
   persist). Add `default_account_id: Option<String>` (global, in `Settings`).
2. **Secure credential storage.** Per account: the CLI `CLAUDE_CODE_OAUTH_TOKEN` and the web
   `sessionKey`. Store OUT of plaintext settings: OS credential store (Windows Credential Manager
   via a vetted crate) or an encrypted app-data blob. Never commit, never log. The `Account`
   holds only opaque refs/ids, not the secrets.
3. **`auth::session` -> per-account.** Change `load`/`save`/`clear` to take an `account_id` and key
   the sessionKey by account (e.g. `session-<id>.txt` or the credential store). Keep a thin compat
   shim for migration (see step 7).
4. **CLI token minting.** "Sign in" spawns `claude setup-token` for that account (interactive
   browser), captures the long-lived token, stores it. Requires Pro/Max/Team; on failure surface
   "subscription required" and abort (API-key accounts unsupported).
5. **Web cookie capture, per-account.** Reuse `login_flow.rs` but give each account its OWN chrome
   profile dir (avoid cookie collision) and store the `sessionKey` per account. Ideally the same
   browser trip that mints the token also lands the cookie (one login, two grants).
6. **Auto-detect name/icon.** Widen `scraping::client::OrgListEntry` to capture `name`/`email`
   (currently dropped). After connect, read the org info and prefill the label + email; auto-pick
   an icon from a pool, skipping icons already used by other accounts; user can reroll/edit. Colour
   picker too.
7. **Migration.** On upgrade, if a `session.txt` + logged-in identity exists, create account #1
   from it (carry its sessionKey, mark it `default_account_id`), and re-key its usage history
   (milestone 03 owns the usage table column, coordinate the migration there).

## Files
- New `src-tauri/src/accounts/` module (struct, store, secure-cred access).
- `src-tauri/src/auth/session.rs`, `auth/login_flow.rs` (per-account profile + keyed store).
- `src-tauri/src/scraping/client.rs:11-12` (widen `OrgListEntry`).
- `src-tauri/src/types/notifications.rs` (`Settings.default_account_id`).
- `src-tauri/src/settings/paths.rs` (per-account cred/cookie paths).
- IPC: `add_account`, `list_accounts`, `remove_account`, `set_default_account`, `reauth_account` +
  `export_types.rs` entry, regen `cargo test --test export_types` (`project_ipc_generated_source_of_truth`).

## Acceptance
- Add two accounts; each mints a token + captures a cookie; name/email arrive prefilled; icons
  never collide.
- Credentials are absent from settings JSON and logs (grep the on-disk settings + log).
- The pre-existing single account survives upgrade as account #1, marked default, with its cookie
  and history intact.
- An API-key / non-subscription login is refused with a clear message.
