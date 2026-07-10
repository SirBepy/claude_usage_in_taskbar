# src-tauri/src/sessions/scheduled_items.rs should be split

## Goal
Move recurrence date-math out of `sessions/scheduled_items.rs` into its own module.

## Context
`src-tauri/src/sessions/scheduled_items.rs` is 682 lines and mixes two unrelated
concerns: the instance-scoped JSON store CRUD (`config_path`/`config_path_for`,
`load_map`/`write_atomic`, `list`/`get`/`upsert`/`delete`/`claim_for_fire`/
`finish_fire`/`sweep_firing_to_failed`, lines ~114-288) and pure recurrence
date-math (`next_occurrence`, `parse_hhmm`, `local_at`, `next_daily`, `next_weekly`,
`next_every_n_days`, `src-tauri/src/sessions/scheduled_items.rs:290-373`). The
recurrence functions take no dependency on the file store at all - they operate
purely on `DateTime`/`NaiveDate`/`Recurrence` - so they are a clean, already-obvious
module boundary independent of the file-backed persistence logic around them.

## Approach
Extract `next_occurrence`, `parse_hhmm`, `local_at`, `next_daily`, `next_weekly`,
and `next_every_n_days` (plus their dedicated tests) into a new
`src-tauri/src/sessions/recurrence.rs`, re-exporting `next_occurrence` from
`scheduled_items` (or updating call sites to the new path) so existing callers are
unaffected.

## Acceptance
`cargo build --manifest-path src-tauri/Cargo.toml` passes; recurrence math lives in
its own file with its own tests; `scheduled_items.rs` is left holding only the
store CRUD.
