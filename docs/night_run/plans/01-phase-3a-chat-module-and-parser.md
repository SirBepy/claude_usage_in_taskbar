# Phase 3a - Chat module skeleton + parser.rs

## Context

This is one of 14 night-run plans implementing Phases 3-10 of the chat-hub feature. Architectural choice: **Path C** (per-turn `claude -p --resume <id>`, no PTY, no ANSI parser). Phases 0-2 already merged on master.

Read these BEFORE writing code:
- `docs/superpowers/plans/2026-05-07-claude-chat-hub.md` - the canonical plan; this night-run plan implements Task 3.1.
- `docs/superpowers/specs/2026-05-07-claude-chat-hub-design.md` - "Phase 0 result" + "Phase 0 extension - Path C discovered" sections.

Repo conventions:
- Tauri 2 / Rust backend at `src-tauri/`. Cargo package `claude-usage-tauri` (lib `claude_usage_tauri_lib`).
- Tests inline `#[cfg(test)] mod tests` blocks. Run with `cargo test -p claude-usage-tauri --lib` from `src-tauri/`.
- Module declaration pattern: `name.rs` + `name/` directory (NOT `name/mod.rs`). See `src-tauri/src/sessions.rs` for an example.
- Don't touch `docs/`, `.for_bepy/`, `CLAUDE.md`, or `README.md` unless the parent plan says to.

## Goal

Add the `chat` module with two real submodules and stubs for the rest:
- `src-tauri/src/chat.rs` - module-decl
- `src-tauri/src/chat/parser.rs` - line-delimited stream-json -> ChatEvent (FULLY IMPLEMENTED with 7 tests)
- `src-tauri/src/chat/runner.rs`, `src-tauri/src/chat/takeover.rs`, `src-tauri/src/chat/history.rs` - empty stub files (implemented in later plans)
- `src-tauri/src/lib.rs` - declare `pub mod chat;`

## Implementation

Follow the EXACT step-by-step in `docs/superpowers/plans/2026-05-07-claude-chat-hub.md` under "PHASE 3 - Chat backend (Path C)" -> "Task 3.1: Chat module skeleton + parser.rs". The parser code block in that section is the source of truth - copy it verbatim.

Steps in order:
1. Create `src-tauri/src/chat.rs` with the four `pub mod ...;` lines.
2. Add `pub mod chat;` to `src-tauri/src/lib.rs` alphabetically.
3. Create the three stub files (`runner.rs`, `takeover.rs`, `history.rs`) with one-line doc comments referencing later plans.
4. Create `src-tauri/src/chat/parser.rs` with the full implementation from the parent plan (the `ParserContext`, `parse_line`, `extract_content_blocks`, plus all 7 inline tests).
5. Run `cargo test -p claude-usage-tauri --lib chat::parser::tests` - expect 7 passing.
6. Run `cargo test -p claude-usage-tauri --lib` - expect 170 passing (was 163 + 7 new).

## Gotchas

- The repo uses `ts_rs` unconditionally (no `cfg_attr` feature gating). Match the existing pattern in `src-tauri/src/types/chat.rs` from Phase 2.
- `serde_json::Value` is already a dependency.
- Keep tests in the same `mod tests` block. Don't split into separate test files.
- The parser intentionally treats every `assistant` line as `streaming: true` and only marks `streaming: false` when it sees the `result` line. Don't second-guess this; it's deliberate and matches Path C semantics where `--include-partial-messages` emits multiple `assistant` chunks per turn.

## Don't

- Don't commit. The night-run tick handles `/commit` automatically.
- Don't create `chat/mod.rs` - use `chat.rs` per repo convention.
- Don't add unrequested submodules.
- Don't touch any file outside the ones listed in the Goal section.
- Don't modify the spec or the parent plan.

## Acceptance

- `cargo build -p claude-usage-tauri` is clean (4 pre-existing warnings in `lib.rs` unrelated to this work are OK).
- `cargo test -p claude-usage-tauri --lib chat::parser::tests` shows 7 passed.
- Total lib test count is 170.
- `cargo test -p claude-usage-tauri` (full suite including integration tests) is also clean.
- No `claude.exe` orphan processes related to test runs (Joe's normal claude/Claude Desktop processes are fine).
