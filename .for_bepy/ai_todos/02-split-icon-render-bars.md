# Split icon_render.rs bars draw functions into submodule

## Goal
Bring `icon_render.rs` back under 400 lines by extracting the bars-specific draw functions into a `src-tauri/src/tray/bars.rs` submodule.

## Context
`src-tauri/src/tray/icon_render.rs` is 522 lines after the 4-bars feature + 32px resize work (session ending ~2026-05-02). The file has a clean split seam: entry-point logic (`render`, `render_spin`, `render_rings`) + number mode + ring rendering stays in `icon_render.rs`, while bars-specific primitives move out.

Functions that belong in `bars.rs`:
- `draw_bars`
- `draw_four_bars`
- `draw_column`
- `resolve_safe_color`

Constants that move with them (or stay shared in `icon_render.rs` and re-exported):
- `SAFE_PACE_COLOR` - used only by bars code, move it
- `TRACK` and `TRACK_ALPHA` - used by both ring and bar code, keep in `icon_render.rs`

## Approach
1. Create `src-tauri/src/tray/bars.rs`
2. Move the four functions + `SAFE_PACE_COLOR` into it; add `pub(super)` visibility
3. In `icon_render.rs`: add `mod bars;` and call via `bars::draw_bars(...)` etc.
4. Verify constants shared between files are accessible (pass them as params or pub(super) them)
5. Run `cargo check` then `cargo test` - all green

## Acceptance
- `icon_render.rs` drops to under 400 lines
- `cargo test` exits 0 with no new failures
- No behavior change: existing tests pass unchanged
