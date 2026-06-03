# Extract a shared `to_wide` UTF-16 helper

## Goal

Replace the three copies of the "UTF-8 string -> null-terminated UTF-16 Vec" idiom with one shared util.

## Context

`meeting/windows_source.rs:49` defines `fn to_wide(s: &str) -> Vec<u16>` (`s.encode_utf16().chain(std::iter::once(0)).collect()`). The same idiom is inlined at:
- `src-tauri/src/channels/spawn.rs:73` (`cmdline.encode_utf16().chain(std::iter::once(0)).collect()`)
- `src-tauri/src/daemon/spawn_self.rs:64` (same)

Three copies of a Windows wide-string helper. Low-severity but it's the kind of thing that drifts.

## Approach

Put a single `pub fn to_wide(s: &str) -> Vec<u16>` in a Windows-only util module (e.g. `util/windows.rs` or `util/process.rs` next to the existing `hide_console*` helpers, gated `#[cfg(windows)]`). Point `windows_source.rs` at it (delete its private copy) and swap the two inline call sites to use it. Verify with `cargo build --lib`.

## Acceptance

- One `to_wide` definition; `windows_source.rs`, `channels/spawn.rs`, `daemon/spawn_self.rs` all call it.
- `cargo build --manifest-path src-tauri/Cargo.toml --lib` clean on Windows.
