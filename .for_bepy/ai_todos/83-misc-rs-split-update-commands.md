# misc.rs: split update commands into ipc/update.rs

## Goal
Move the four update-related IPC commands out of `misc.rs` into a dedicated `src-tauri/src/ipc/update.rs` module to bring `misc.rs` under 400 lines.

## Context
`src-tauri/src/ipc/misc.rs` is 610 lines and mixes unrelated concerns. The update commands form a clear cohesive group:
- `set_update_state` (line ~320)
- `check_for_updates`
- `download_and_install_update`
- `install_update`
- `get_update_state`

These are the only commands that touch `tauri_plugin_updater` and the shared `UPDATE_STATE` static. They have no dependencies on the window/chat helpers above them in the file.

## Approach
1. Create `src-tauri/src/ipc/update.rs` and move the five update symbols into it (keep the `UPDATE_STATE` static there too).
2. Add `pub mod update;` to `src-tauri/src/ipc/mod.rs`.
3. Update `src-tauri/src/lib.rs` handler list: replace `ipc::check_for_updates` etc. with `ipc::update::check_for_updates` etc. (or re-export from `ipc` mod).
4. Delete the moved code from `misc.rs`.

## Acceptance
- `cargo build --manifest-path src-tauri/Cargo.toml` passes.
- `misc.rs` is under 400 lines.
- All four update IPC commands still work (check for update, download, install, get state in Settings view).
