# Split src-tauri/src/ipc/accounts.rs by concern

## Goal
Break the 535-line `src-tauri/src/ipc/accounts.rs` into smaller modules grouped by the concern each command family serves, instead of one flat file mixing four unrelated command groups.

## Context
`src-tauri/src/ipc/accounts.rs` is a new file (multi-account feature) at 535 lines, and it visibly interleaves four distinct concerns with their own doc-comment banners:

- Wizard flow: `add_account_create` (accounts.rs:52-107), `add_account_check_login` (accounts.rs:112-151), `add_account_capture_cookie` (accounts.rs:157-194), `add_account_cancel` (accounts.rs:198-207), `add_account_finalize` (accounts.rs:218-297) plus the `AddAccountSession`/`LoginCheckOutcome` types (accounts.rs:22-48).
- Account management: `list_accounts` (accounts.rs:299-303), `remove_account` (accounts.rs:309-342), `logout_account` (accounts.rs:347-359), `set_default_account` (accounts.rs:361-386).
- Identity/re-auth: `get_terminal_identity` (accounts.rs:390-394), `get_account_identity` + `AccountIdentity` (accounts.rs:401-437), `reauth_account` (accounts.rs:443-452), `recapture_account_cookie` (accounts.rs:459-487).
- One-time migration prompt (explicitly its own section, marked with a `// --- ... ---` banner at accounts.rs:489): `AccountsSetupPromptState`, `get_accounts_setup_prompt_state`, `dismiss_accounts_setup_prompt` (accounts.rs:491-535).

Each group already has almost no coupling to the others beyond shared imports (`accounts_store`, `paths`, `AppState`), so this is a mechanical split rather than a design change.

## Approach
Turn `src-tauri/src/ipc/accounts.rs` into a small `mod.rs` (or keep `accounts.rs` as a thin re-export) that declares submodules, e.g.:
- `ipc/accounts/wizard.rs` - the 5 wizard-step commands + their two result types.
- `ipc/accounts/management.rs` - list/remove/logout/set_default.
- `ipc/accounts/identity.rs` - terminal identity, get_account_identity, reauth, recapture cookie.
- `ipc/accounts/setup_prompt.rs` - the migration-prompt pair.

Keep `pub use` re-exports so `lib.rs`'s `generate_handler!` list (lib.rs:321-335) doesn't need to change, and so `crate::ipc::accounts::*` call sites elsewhere keep working.

## Acceptance
- `cargo build --manifest-path src-tauri/Cargo.toml` succeeds with no changed public command names.
- Each new file is under ~200 lines and contains only its one concern.
- `src-tauri/tests/export_types.rs` and any other test referencing these types still pass.
