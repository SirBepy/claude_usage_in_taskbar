# Remove duplicate tauri::Manager imports in misc.rs

## Goal
Delete redundant local `use tauri::Manager` statements that shadow the file-level import.

## Context
`src-tauri/src/ipc/misc.rs` has a top-level `use tauri::Manager` import, but the trait is re-imported locally inside at least two functions (`read_log_file` around line 37 and `check_for_updates` around line 149). This compiles fine but is dead noise - the top-level import already brings the trait into scope for all functions in the file.

## Approach
Delete the local `use tauri::Manager;` statements at the function scope (around lines 37 and 149). Confirm `cargo check` still passes.

## Acceptance
- `cargo check` exits 0.
- No `use tauri::Manager` inside any function body in the file.
