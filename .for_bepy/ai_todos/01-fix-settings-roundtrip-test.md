# Fix settings_roundtrip_renders.rs test file

## Goal
Make the external integration test compile and pass by adding the fields added since the test was written.

## Context
`src-tauri/tests/settings_roundtrip_renders.rs` has been broken since `updating: bool` was added to `IconCtx` (pre-existing, not introduced this session). This session added `safe_sess_color: SafePaceColorMode` and `safe_weekly_color: SafePaceColorMode` to `IconSettings`, which is a second missing-field regression on top of the existing one.

The test initializes `IconCtx` without `updating` and `IconSettings::default()` already fills `safe_*` fields correctly, so only the `IconCtx` struct literal needs `updating: false` added.

Cargo test error (pre-existing): `error[E0063]: missing field 'updating' in initializer of 'IconCtx<'_>'` at `tests/settings_roundtrip_renders.rs:13` (two occurrences).

## Approach
1. Read `src-tauri/tests/settings_roundtrip_renders.rs`
2. Add `updating: false` to every `IconCtx { ... }` literal in that file
3. Run `cargo test` in `src-tauri/` to confirm all tests pass

## Acceptance
- `cargo test` exits 0 with no compile errors
- `switching_icon_style_changes_rendered_bytes` test passes
- No other tests regress
