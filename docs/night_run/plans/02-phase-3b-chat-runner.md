# Phase 3b - chat/runner.rs (per-turn process spawn)

## Context

Implements Task 3.2 of `docs/superpowers/plans/2026-05-07-claude-chat-hub.md`. Depends on Phase 3a (parser.rs) being merged. Read the parent plan's "Task 3.2: chat/runner.rs - per-turn process spawn" section for the canonical code.

Path C architecture: each user turn = one `claude -p --resume <id>` process. The runner spawns it via `std::process::Command`, pipes stdout, line-buffers through `ParserContext`, emits `ChatEvent`s via callback, blocks until claude exits.

## Goal

Replace the stub at `src-tauri/src/chat/runner.rs` with the full implementation. Include:
- `RunError` enum (thiserror-derived)
- `pub fn run_turn<F>(cwd: &PathBuf, session_id: Option<&str>, prompt: &str, on_event: F) -> Result<(), RunError>` where `F: FnMut(ChatEvent)`
- One `#[ignore]`'d integration test that requires `claude` on PATH

## Implementation

1. Replace `src-tauri/src/chat/runner.rs` content with the exact code block from the parent plan's Task 3.2 Step 1.
2. Verify `thiserror` is in `[dependencies]` of `src-tauri/Cargo.toml`. If not, add `thiserror = "1"`.
3. Run `cargo build -p claude-usage-tauri`. Expected: clean.
4. Run `cargo test -p claude-usage-tauri --lib`. Expected: still 170 (the new ignored test doesn't run by default).

## Gotchas

- `std::process::Command::new("claude")` resolves via PATH. On Windows that includes both `~/.local/bin/claude.exe` and the system Claude install. Use whichever the user's PATH prefers; this matches what other parts of the repo do.
- The flags MUST be in this exact order and form:
  ```
  -p
  --output-format=stream-json
  --verbose
  --include-partial-messages
  --resume <session_id>   (only if session_id is Some)
  <prompt>                (positional, last)
  ```
  Per `claude --help`, `--include-partial-messages` requires `--print` (`-p`) AND `--output-format=stream-json`. `--verbose` is required for stream-json to emit anything.
- `Stdio::null()` for stdin (claude won't read from it in `-p` mode anyway). `Stdio::piped()` for stdout AND stderr. We read stdout in real time; stderr is captured at the end if exit is non-zero.
- The function is synchronous and blocks. The IPC layer (Phase 4) wraps it in `tauri::async_runtime::spawn_blocking`.
- Don't add a timeout. Long turns are normal. Cancellation comes via `cancel_turn` (Phase 4) which kills the child process.

## Don't

- Don't commit. Don't touch other files. Don't add features beyond `run_turn`.
- Don't introduce a tokio runtime here. Plain blocking I/O.
- Don't emit `ChatEvent::SessionEnded` from the runner; the parser already maps the `result` line to a finalized AssistantMessage.

## Acceptance

- `cargo build -p claude-usage-tauri` clean.
- `cargo test -p claude-usage-tauri --lib` shows 170 passed.
- `chat::runner::run_turn` is callable from the rest of the crate (Phase 4 will use it).
- No orphan processes from test runs.
