# when_done.rs should be split: extract pure helper functions

## Goal
Reduce `src-tauri/src/when_done.rs` (1052 lines) by extracting ~244 lines of stateless helper functions into a dedicated submodule, leaving the engine (EngineDeps) and public types in the main file.

## Context
`when_done.rs` mixes three distinct layers:
- Types: `ProtocolState`, `WhenDoneInner` (lines 52-93)
- Pure stateless helpers: `instance_is_idle`, `all_sessions_idle`, `waiting_on_ids`, `next_countdown`, `close_turn_complete`, `live_session_ids`, `live_busy_map`, `default_question_answers`, `update_and_emit`, `is_cancelled` (lines 94-337, ~244 lines)
- Engine: `EngineDeps` struct and its impl (lines 339-623)
- Tests: `mod tests` (lines 625-1052, ~427 lines)

The pure helpers have no shared mutable state and depend only on `Instance`, `AppHandle`, and the registry - no circular dependency with the engine.

## Approach
Convert `when_done.rs` to a module:
1. Create `src-tauri/src/when_done/mod.rs` - keep types, engine, and `pub use` re-exports.
2. Create `src-tauri/src/when_done/helpers.rs` - move the pure functions (lines 94-337) there. Keep them `pub(super)` so only the engine can call them.
3. Move the `mod tests` block (or keep it in `mod.rs` since it tests the engine).
4. Update `lib.rs` or `main.rs` - the module path stays `when_done`, no callers change.

## Acceptance
- `when_done/mod.rs` drops below 700 lines.
- `cargo build --manifest-path src-tauri/Cargo.toml` clean.
- All tests under `when_done` still pass.
