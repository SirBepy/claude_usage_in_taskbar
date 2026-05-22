# Split daemon_chat_e2e.rs by concern (low priority)

## Goal

`src-tauri/tests/daemon_chat_e2e.rs` has grown to 548 lines mixing two concerns: chat-turn streaming tests and registry/persistence tests. Consider splitting if it grows further.

## Context

The file now holds: `interactive_survives_session_end_hook`, `takeover_manual_promotes_external_to_interactive`, `mark_session_ended_sets_ended_at`, `externalize_session_flips_interactive_to_external`, `set_session_effort_persists`, `interactive_session_survives_daemon_restart`, `ended_session_not_restored_after_daemon_restart` (all registry/persistence), plus `end_to_end_no_duplicate_events` (chat-turn streaming, billed). All share the `spawn_daemon_and_connect` + `find_instance` helpers defined at the top of the file.

This is LOW priority and possibly not worth doing: the file is cohesive (one daemon e2e harness), and splitting forces either moving the shared helpers into a common module (`tests/common/mod.rs`) or duplicating them. Only act if the file keeps growing past ~700 lines.

## Approach

If pursued: extract `spawn_daemon_and_connect`, `find_instance`, `daemon_exe`, and `interactive_snapshot_path` into `src-tauri/tests/common/mod.rs` (or a shared helper file), then split into `daemon_chat_e2e.rs` (turn streaming) and `daemon_registry_e2e.rs` (registry + persistence). Keep all the `#[ignore]` + `#![cfg(windows)]` + `--test-threads=1` constraints. Verify both files still pass: `cargo test --test daemon_chat_e2e --test daemon_registry_e2e -- --ignored --test-threads=1`.

## Acceptance

- Each test file is single-concern and under ~400 lines.
- No duplicated harness code (shared helpers in a common module).
- All previously-passing tests still pass.
- OR: decide the split isn't worth the shared-helper indirection and delete this todo.
