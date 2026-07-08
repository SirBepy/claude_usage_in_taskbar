# Dead code: OauthAccountInfo.profile_fetched_at

**Type:** task

## Goal
Remove the now-unread `profile_fetched_at` field from `OauthAccountInfo` and its remaining test references.

## Context
Commit 568178fa (wizard login-step rework, 2026-07-08) deleted the only production reader: `login_step::poll_login` used to compare `profileFetchedAt` timestamps for login freshness, but current Claude CLI builds no longer write that field at all, so completion detection now keys off file presence (`oauthAccount` + `.credentials.json`). What remains is parse-only dead weight:
- `src-tauri/src/accounts/identity.rs:22` - field definition (`pub profile_fetched_at: Option<String>`).
- `src-tauri/src/accounts/identity.rs:71,84,120` - its own fixture/asserts.
- `src-tauri/src/accounts/drift.rs:81` - test fixture sets it to `None`.

The field is `#[serde(default)]` and the struct is also ts-rs-exported, so removing it changes `src/types/ipc.generated.ts` (`OauthAccountInfo`) - check frontend for any `profileFetchedAt` reads (none known).

## Approach
Delete the field from `OauthAccountInfo`, drop the fixture lines/asserts in identity.rs and drift.rs tests, regenerate types via `cargo test --manifest-path src-tauri/Cargo.toml --test export_types`, then `pnpm tsc --noEmit`.

## Acceptance
`grep -ri profile_fetched_at src-tauri src` returns nothing (docs/ may keep historical mentions); `cargo test --lib accounts::` and `pnpm tsc --noEmit` pass.
