# Reuse util::process::hide_console in files::scan

## Goal

`src-tauri/src/files/scan.rs` reimplements its own `no_window` Windows function inline. The repo already has `src-tauri/src/util/process.rs::hide_console(&mut Command)` doing the exact same thing (CREATE_NO_WINDOW flag via std::os::windows::process::CommandExt). Reuse it.

## Context

- `src-tauri/src/files/scan.rs:35-42` — defines a local `no_window(cmd: &mut Command)` with the cfg-gated Windows impl using `CREATE_NO_WINDOW = 0x0800_0000`.
- `src-tauri/src/util/process.rs:1-31` — exposes the shared helper `hide_console`. Already used by other Command spawns in the codebase (channels, news, etc.).
- Memory rule "UI freeze + flashing windows = audit process spawns" calls out exactly this kind of duplication.

The scan was added in Plan 2 (`FEAT: list_project_files IPC via git ls-files`, commit `0aadffc`); I missed the existing helper.

## Approach

1. Open `src-tauri/src/files/scan.rs`.
2. Replace the local `no_window` definition + the two `cfg`-gated stubs with `use crate::util::process::hide_console;`.
3. Change the call site from `no_window(&mut cmd);` to `hide_console(&mut cmd);`.
4. Run `cargo check --manifest-path src-tauri/Cargo.toml` to confirm.
5. Run `cargo test --manifest-path src-tauri/Cargo.toml --test files_scan` to confirm the 3 integration tests still pass.
6. `/commit` with prefix `REFACTOR: reuse hide_console helper in files::scan`.

## Acceptance

- `files/scan.rs` no longer defines its own `no_window` fn or its cfg-gated stubs.
- `files/scan.rs` calls `crate::util::process::hide_console(&mut cmd)` before `cmd.output()`.
- `cargo check` passes.
- `files_scan` integration tests (3) pass.
- Windows behavior unchanged (git still spawns hidden, no console flash).
