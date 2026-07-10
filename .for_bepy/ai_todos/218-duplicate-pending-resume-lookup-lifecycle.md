# Duplicate: pending-resume lookup for a session_id

## Goal
Extract the "find the pending scheduled resume for this session" scan into a
shared helper instead of two copies.

## Context
`src-tauri/src/daemon/lifecycle.rs:497-515` (inside `handle_rate_limit_rejection`)
scans `scheduled_items::list()` filtering for a `Pending` `Message` item whose
`session_id` matches, and deletes any match (defensive dedupe before queuing a
fresh resume). `src-tauri/src/daemon/methods/lifecycle.rs:189-203` (inside the
`move_session_to_account` RPC handler) scans `scheduled_items::list()` with the
identical `Pending` + `Message{session_id}` predicate to find and consume the one
pending resume for a session before forking it onto a new account. Both are the
same "does this session have a queued resume" query, written independently.

## Approach
Add a helper to `src-tauri/src/sessions/scheduled_items.rs`, e.g.
`pub fn find_pending_message_for_session(session_id: &str) -> Option<ScheduledItem>`,
and have both `handle_rate_limit_rejection` and `move_session_to_account` call it
instead of re-scanning `list()` with a hand-written predicate.

## Acceptance
`cargo build --manifest-path src-tauri/Cargo.toml` passes; both call sites use the
shared helper; existing scheduling tests
(`src-tauri/tests/daemon_schedule_e2e.rs`) still pass.
