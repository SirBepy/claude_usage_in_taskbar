# daemon/lifecycle.rs spawn_session absorbed the coalescing pump inline: extract it

## Goal
Pull the stdout pump loop (with its snapshot-coalescing state) out of the ~330-line `spawn_session`.

## Context
The 2026-07-09 perf pass (commit c54a1ffd) added the `pending_snapshot`/`flush_deadline` `tokio::select!` coalescing logic directly inside spawn_session's stdout-pump loop (src-tauri/src/daemon/lifecycle.rs:74-406, file is 672 lines). Self-contained streaming-throttle concern living inline in an already-large function.

## Approach
Extract the read_until/select! pump loop into its own function taking the parser/session/state handles (e.g. `run_stdout_pump(...)`), called from spawn_session. Pure move, no behavior change. Mind the `line_buf.clear()` placement - it must stay after full line consumption (cancel-safety of read_until under select!, see commit c54a1ffd message).

## Acceptance
`cargo build --manifest-path src-tauri/Cargo.toml` passes; coalescing behavior unchanged (100ms deadline, flush-before-other-events, EOF flush). Do NOT run cargo test if the dev daemon is live.
