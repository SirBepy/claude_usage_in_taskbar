# Fix the stale file map in the local-session-chat skill

## Goal
Update `.claude/skills/local-session-chat/SKILL.md` so its "read these files" map points at files that actually exist post daemon-pivot.

## Context
The skill's onboarding list references `src-tauri/src/chat/runner.rs` (per-turn spawn / stdout pump) and `src-tauri/src/chat/parser.rs`. After the daemon pivot, the per-turn `claude` spawn + stdout pump live in `src-tauri/src/daemon/lifecycle.rs` (`base_claude_args`/`spawn_session`); `runner.rs` no longer exists. `parser.rs` and `sessions/registry.rs` still exist. This cost several greps to locate the spawn site during the session that produced this todo.

## Approach
In SKILL.md "What to do on invoke" file list and the "Common fix areas" table, replace `src-tauri/src/chat/runner.rs` with `src-tauri/src/daemon/lifecycle.rs` (note: it owns spawn / send_message / cancel_turn / end_session and the stdout reader). Verify the other listed paths still resolve and fix any that don't.

## Acceptance
Every path in the SKILL.md file map resolves to an existing file; the spawn/turn-lifecycle entry points to `daemon/lifecycle.rs`.
