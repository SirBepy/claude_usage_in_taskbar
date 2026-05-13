# Resolve persisted-Interactive session names on rehydrate

## Goal

When `rehydrate_persisted_interactive_sessions` restores Interactive sessions on app startup, also resolve each session's `name` (first user prompt from the transcript) so the sidebar shows readable titles instead of bare session_id slices for resumed chats.

## Context

`src-tauri/src/lib.rs::rehydrate_persisted_interactive_sessions` calls `crate::sessions::persistence::populate_registry`, which only applies the `name` field stored in `<app-data>/interactive-sessions.json`. The snapshot only contains a name when one was set during the live session via `Registry::set_name` (e.g. by `rehydrate_instances_from_session_files` for External entries, or by some future hook for Interactive). For Path C sessions started fresh in this app, `set_name` is never called - the `name` field is `None` and the sidebar falls back to slicing the session_id.

The live-pid rehydrate in `lib.rs:448-468` already does the right resolution for External entries:

```rust
let transcript_path = crate::tokens::transcript_for_session(&s.cwd, &s.session_id)
    .or_else(|| crate::tokens::latest_transcript_for_cwd(&s.cwd));
let name = transcript_path
    .as_deref()
    .and_then(|p| crate::tokens::first_user_prompt(p, 60));
```

Persisted Interactive rehydrate doesn't do this yet.

## Approach

1. In `src-tauri/src/sessions/persistence.rs::populate_registry`, after `upsert_interactive`, if `name` is `None`, attempt to resolve it from the transcript:
   - `crate::tokens::transcript_for_session(&s.cwd, &s.session_id)` then `crate::tokens::first_user_prompt(&p, 60)`.
   - Cross-module call - persistence.rs currently has no dep on `crate::tokens`. That's fine, both are in the same crate.
2. Alternative if you want to keep persistence.rs pure: move the resolution into `rehydrate_persisted_interactive_sessions` in lib.rs - iterate the loaded `Vec<PersistedInteractive>`, fill `name` before calling `populate_registry`, OR call `set_name` after population.
3. Either way: cache the resolved name back to the snapshot file so we don't redo this on every startup. Easiest: after `populate_registry`, call `save_snapshot_default` once.
4. Run `cargo test --lib persistence` to confirm tests still pass.

## Acceptance

- After app restart, resumed Interactive sessions in the sidebar show their first-user-prompt name (truncated to 60 chars), not the bare session_id.
- If the transcript jsonl is missing (e.g. claude side cleared it), the entry falls back to whatever `name` was on disk, or `None` (sidebar handles bare id gracefully).
- The snapshot file ends up with resolved names persisted, so the next startup doesn't redo the work.
- All existing `persistence::tests` continue to pass; ideally add one new test that verifies name backfill from a fake transcript path.
