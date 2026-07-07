# Share one bak_path() helper instead of two identical copies

## Goal
Remove the duplicate `.bak`-suffix path helper introduced by the multi-account migration code and have it reuse the pre-existing one instead.

## Context
`src-tauri/src/accounts/migration.rs:64-68` defines:

```rust
fn bak_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".bak");
    path.with_file_name(name)
}
```

This is byte-for-byte identical to the pre-existing `src-tauri/src/storage/migration.rs:41-45`. The new copy's own doc comment even says "mirrors `storage::migration`'s private `bak_path`" (migration.rs:62-63), i.e. the duplication was noticed and left in rather than shared - both functions are private (`fn`, not `pub fn`) to their respective modules, so neither is currently reachable from the other.

## Approach
Make one copy `pub(crate)` (suggest keeping it in `storage/migration.rs` since it's the older of the two, or move it to a small shared `path_util` spot if one already exists) and have `accounts/migration.rs::retire_legacy_session_at` (migration.rs:116-123) call the shared version instead of the local `bak_path`. Delete the local copy in `accounts/migration.rs`.

## Acceptance
- `cargo build --manifest-path src-tauri/Cargo.toml` succeeds.
- `cargo test --manifest-path src-tauri/Cargo.toml` (scoped to avoid killing the dev daemon per project convention) still passes `retire_legacy_session_renames_to_bak_and_is_idempotent` (migration.rs:327-343) and the existing `storage::migration` bak tests.
- Only one `fn bak_path` definition remains in the codebase.
