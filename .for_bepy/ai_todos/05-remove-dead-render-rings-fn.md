# Remove dead `render_rings` back-compat fn from icon_render.rs

## Goal
Delete the unused `render_rings(sess, weekly)` function in `src-tauri/src/tray/icon_render.rs` and confirm nothing breaks.

## Context
`render_rings` was a back-compat shim for an old tray.rs call site that has since been migrated. The function's own comment says: "Once tray.rs is updated in a later task this function can be removed."

A grep across `src-tauri/src/` shows zero callers — only the function definition itself.

Was noticed during the bars-extraction session (2026-05-07) but left alone to avoid drive-by changes outside that todo's scope. Now it can be removed cleanly.

Location: `src-tauri/src/tray/icon_render.rs`, function `pub fn render_rings(...)` plus its 4-line doc comment immediately above. ~10 lines total.

## Approach
1. Confirm no callers: `Grep -r "render_rings" src-tauri/`
2. Delete the function + its doc comment block in `icon_render.rs`
3. Run `cargo check` then `cargo test`
4. Commit via `/commit`

## Acceptance
- `render_rings` no longer appears in source
- `cargo check` clean (no new warnings about removed item)
- `cargo test` exits 0
- `icon_render.rs` line count drops by ~10
