# Split the floating-overlay window logic out of ipc/window.rs

**Type:** code-health

## Goal
Extract the milestone-06 floating-overlay window code from `src-tauri/src/ipc/window.rs` into its own module (e.g. `src-tauri/src/ipc/overlay_window.rs`) so `window.rs` drops back under ~400 lines and each file owns one window's lifecycle.

## Context
`src-tauri/src/ipc/window.rs` is 477 lines and mixes three separate concerns: the main dashboard window (build/surface/nav commands), the chats window, and the floating overlay window. The overlay block is a clean, self-contained seam - it's already delimited by the `── Multi-account milestone 06: floating overlay window ──` comment and covers, in order:
- constants `OVERLAY_LABEL`, `OVERLAY_WIDTH`, `OVERLAY_HEIGHT`
- `overlay_position` (+ its `#[cfg(test)]` unit tests)
- `rect_physical`
- `build_overlay_window`
- `persisted_overlay_pos`
- `save_overlay_position` (`#[tauri::command]`)
- `toggle_overlay_window`

`rect_physical` is used only by the overlay code, so it moves too. `toggle_overlay_window` is called from `src-tauri/src/tray/menu.rs` (`on_left_click`) and `save_overlay_position` is registered in `src-tauri/src/lib.rs` - both are `crate::ipc::...` paths, so they keep resolving as long as the new module is re-exported from `ipc/mod.rs` (`pub use overlay_window::*;`), matching how `window::*` is surfaced today.

## Approach
1. Create `src-tauri/src/ipc/overlay_window.rs`; move the items listed above (including the `overlay_position_tests` module) into it.
2. Add `pub mod overlay_window; pub use overlay_window::*;` (or equivalent) to `ipc/mod.rs` so existing `crate::ipc::toggle_overlay_window` / `ipc::save_overlay_position` call sites are unchanged.
3. Carry over the imports the moved code needs (`tauri::{AppHandle, Emitter, Manager, State}`, `crate::settings::{self, paths}`, `std::sync::atomic::Ordering`, `std::sync::Arc`); prune any now-unused imports left in `window.rs`.
4. `build_overlay_window` calls `build_main_window`? No - confirm no cross-calls back into `window.rs` beyond what's public; if any, keep them via `crate::ipc::...`.

## Acceptance
- `cargo build --manifest-path src-tauri/Cargo.toml` is clean (no new warnings).
- `cargo test --manifest-path src-tauri/Cargo.toml overlay_position` still passes (the moved unit tests run).
- `window.rs` is back under ~400 lines; no behaviour change to tray-toggle, drag-persist, or dashboard nav.
