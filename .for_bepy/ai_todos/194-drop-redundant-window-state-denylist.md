# Dead code: with_denylist("session-overlay") subsumed by with_filter

## Goal
Keep one exclusion mechanism on the window-state plugin, not two overlapping ones.

## Context
`src-tauri/src/lib.rs:172` (2026-07-09 perf pass, commit bc03457a) added both `.with_denylist(&["session-overlay"])` and `.with_filter(|label| label == "session-chats" || !label.starts_with("session-"))`. The filter already rejects `session-overlay`, so the denylist entry never rejects anything on its own.

## Approach
Drop the `.with_denylist(...)` call and rely on the filter alone. Verify the plugin version applies the filter at every persistence point (save AND restore), not just on_window_ready, before deleting - if the denylist covers a path the filter doesn't, keep the denylist and drop the overlay label from the filter instead.

## Acceptance
One mechanism excludes overlay + detached session windows; `session-chats` geometry restore still works; `cargo build` passes.
