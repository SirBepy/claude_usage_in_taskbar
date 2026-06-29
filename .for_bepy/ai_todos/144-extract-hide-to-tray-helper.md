# Extract shared hide-to-tray window helper

## Goal
Remove the duplicated "hide on close instead of quit" `on_window_event` closure now present in both `build_main_window` and `build_chats_window`.

## Context
`src-tauri/src/ipc/window.rs` has two near-identical `CloseRequested` handlers (introduced when the main window became code-built, ai_todo 143):
- `build_main_window` ~line 108-126
- `build_chats_window` ~line 158-176

Both do the same thing: on `WindowEvent::CloseRequested`, read `AppState.should_quit`; if quitting, return (let it close); otherwise `api.prevent_close()` + `w.hide()`.

## Approach
Extract a helper like `fn attach_hide_to_tray(window: &tauri::WebviewWindow)` in `window.rs` that wires the `on_window_event` CloseRequested -> should_quit-check -> prevent_close + hide logic, and call it from both builders. One source of truth for the hide-to-tray behavior.

## Acceptance
- Single definition of the CloseRequested/hide-to-tray closure; both `build_main_window` and `build_chats_window` call the helper.
- `cargo build --manifest-path src-tauri/Cargo.toml` passes.
- Closing both the dashboard and chats windows still hides them to tray (does not quit the app); tray "Quit" still fully exits.
