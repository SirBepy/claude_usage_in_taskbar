# Duplicate: gc_temp_files re-implements gc_attachments' directory sweep

## Goal
One shared stale-file sweep helper instead of two hand-rolled copies.

## Context
`src-tauri/src/daemon/claude_config.rs:87` (`gc_temp_files`, added in the 2026-07-09 perf pass) and `src-tauri/src/ipc/chat/lifecycle.rs:11` (`gc_attachments`, pre-existing) both do: read_dir, compute SystemTime cutoff, iterate entries, check `metadata().modified()`, remove if older. They differ only in target dir, extension filter, and remove_file vs remove_dir_all.

## Approach
Extract `sweep_dir_older_than(dir, max_age, filter, remove_fn)` (or a small enum for file-vs-dir removal) into a common util module; both call sites shrink to one call.

## Acceptance
Both GC paths still remove only their intended stale artifacts (json temp files / attachment dirs older than cutoff); `cargo build --manifest-path src-tauri/Cargo.toml` passes.
