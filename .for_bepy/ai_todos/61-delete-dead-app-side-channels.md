# Delete dead app-side channel lifecycle + AppState.channels field

## Goal

After Phase 4 routed all app channel commands through the daemon (`ipc/channels.rs` → daemon RPC) and removed the app-side autostart, the app-side channel lifecycle is no longer called from anywhere in the app. It survives only because it's re-exported `pub` (so the compiler can't prove it dead). Remove the dead code.

## Context

- `src-tauri/src/channels/lifecycle.rs` — `start_channel` / `stop_channel` / `restart_channel` / `autostart_all` / `emit_changed` are now unused on the app side (the daemon has its own copy in `src-tauri/src/daemon/channels.rs`). `src-tauri/src/channels.rs:19` does `pub use lifecycle::*` which masks the dead-code warning.
- `src-tauri/src/state.rs:~55` — `pub channels: Arc<ChannelsManager>` field on `AppState` is no longer read on any path (reads moved to `cached_channels`). Left in place during Phase 4 Task 7 to avoid cascading edits.
- Still used (do NOT delete): `channels::kill::kill_tree` (used by `chat/takeover.rs`, `ipc/chat/*`), `channels::spawn`, `channels::window_chrome`, `channels::manager` (the daemon reuses all of these), `channels::vault_detector` (app automation picker).

## Approach

1. Delete `src-tauri/src/channels/lifecycle.rs` and its `pub mod lifecycle;` + `pub use lifecycle::*;` lines in `src-tauri/src/channels.rs`.
2. Remove the `channels: Arc<ChannelsManager>` field from `AppState` (`state.rs`) and its init in `AppState::new`. Drop the now-unused `use crate::channels::Manager as ChannelsManager;` import.
3. Grep for any remaining references to the deleted items; fix or remove.
4. `cargo check --manifest-path src-tauri/Cargo.toml --lib` and `--bin cc-companion-daemon` → both clean.

## Acceptance

- `channels/lifecycle.rs` gone; daemon's `daemon/channels.rs` is the only channel lifecycle.
- `AppState.channels` field gone; `cached_channels` is the only app-side channel state.
- `kill_tree` / `spawn` / `window_chrome` / `manager` / `vault_detector` untouched and still compiling.
- Both builds clean.
