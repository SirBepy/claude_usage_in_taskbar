# src-tauri/src/daemon/lifecycle.rs should be split

## Goal
Move rate-limit rejection handling out of `daemon/lifecycle.rs` into its own module.

## Context
`src-tauri/src/daemon/lifecycle.rs` is 847 lines and mixes two distinct concerns:
process lifecycle management (`spawn_session`, `send_message`, `cancel_turn`,
`end_session`) and rate-limit rejection handling (`handle_rate_limit_rejection`,
`src-tauri/src/daemon/lifecycle.rs:463-540`). The latter was added in this diff and
is fully self-contained: it only touches `state.registry`
(`set_rate_limited_for_account`/`clear_rate_limit_for_account`),
`crate::sessions::scheduled_items` (dedupe + upsert), and
`crate::daemon::schedule::next_stagger_slot`. It has no dependency on the process
spawning machinery that dominates the rest of the file, and is invoked from just
one call site inside `spawn_session`'s event pump plus one debug-only RPC
(`daemon/methods/lifecycle.rs::simulate_rate_limit`).

## Approach
Extract `handle_rate_limit_rejection` (and its imports/doc comment) into a new
`src-tauri/src/daemon/rate_limit.rs` module, `pub(crate)` as today. Update the two
call sites (`daemon/lifecycle.rs`'s event pump and
`daemon/methods/lifecycle.rs::simulate_rate_limit`) to reference the new path, and
move the `rate_limited_sentinel_round_trips` test (which exercises
`daemon::schedule::parse_rate_limited`, unrelated to this function) if it makes more
sense alongside the new module.

## Acceptance
`cargo build --manifest-path src-tauri/Cargo.toml` passes; `daemon/lifecycle.rs`
drops to purely process-lifecycle concerns; rate-limit rejection logic lives in its
own file with its own tests.
