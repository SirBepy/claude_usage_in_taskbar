# Extract a shared atomic JSON-write helper (tmp + rename)

## Goal
The "write JSON to `path.json.tmp` then `rename` over `path`" pattern is now duplicated in three places. Extract one helper.

## Context
Atomic-write-via-tmp+rename appears in:
- `src-tauri/src/sessions/persistence.rs:69` (save_snapshot)
- `src-tauri/src/sessions/chat_config.rs:53` (write_atomic - added this session)
- `src-tauri/src/hooks/installer.rs:130`
Each re-implements `path.with_extension("json.tmp")` + `fs::write` + `fs::rename` with its own error logging. Low-risk DRY cleanup.

## Approach
- Add `pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()>` (or a `&str`-taking variant) to a shared util module (e.g. `src-tauri/src/util/`), doing create_dir_all(parent) + write tmp + rename.
- Replace the three call sites. Preserve each site's existing log-and-swallow vs propagate behavior (persistence + chat_config swallow + log::warn; installer propagates `?`) - the helper can return Result and callers choose.

## Acceptance
- One atomic-write helper; the three sites call it.
- `cargo build` green; existing `sessions::persistence` and `sessions::chat_config` tests still pass (`cargo test --lib persistence`, `--lib chat_config`).
