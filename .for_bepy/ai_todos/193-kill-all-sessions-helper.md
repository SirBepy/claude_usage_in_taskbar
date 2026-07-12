# Duplicate: session kill-tree loop in both daemon shutdown paths

## Goal
One `kill_all_sessions(state)` helper instead of two identical reap loops.

## Context
`src-tauri/src/daemon/mod.rs:238-240` (Ctrl-C/main-loop exit) and `src-tauri/src/daemon/methods/lifecycle.rs:209-211` (`shutdown_daemon` RPC) both gained `for entry in state.sessions.iter() { crate::channels::kill::kill_tree(entry.pid); }` in the 2026-07-09 perf pass (commit e1bd7523).

## Approach
Extract `kill_all_sessions(state: &DaemonState)` next to the sessions map or in the daemon module root; call from both paths.

## Acceptance
One definition, two calls; `cargo build` passes; both shutdown paths still reap live chat children (no orphaned claude.exe after daemon exit mid-turn).
