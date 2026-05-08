# Phase 3c - sessions/registry helpers for Path C

## Context

Implements Task 3.3 of `docs/superpowers/plans/2026-05-07-claude-chat-hub.md`. Depends on Phases 3a + 3b. Read "Task 3.3: Wire chat module to sessions::registry" in the parent plan.

The `Registry` struct already exists at `src-tauri/src/sessions/registry.rs` (was `hooks/instances.rs` before Phase 1 rename). Path C needs three helpers and possibly a new field on `InstanceEntry`.

## Goal

Add to `Registry` impl:
- `pub fn record_interactive_session(&self, session_id: &str, cwd: &str)` - inserts (or overwrites) an entry with `kind = InstanceKind::Interactive`, `cwd`, no pid.
- `pub fn set_busy(&self, session_id: &str, busy: bool)` - flips a `busy` flag on the entry. Emits `instances-changed` event.
- `pub fn find_by_session_id(&self, session_id: &str) -> Option<InstanceEntry>` - lookup helper. If this method already exists with a slightly different name (e.g. `get_by_session_id`), reuse rather than duplicate.

If `InstanceEntry` doesn't have a `busy: bool` field, add one (default false). Add an `Interactive` arm anywhere a non-exhaustive match warning fires (Phase 2 may have already covered most call sites; build will tell you).

## Implementation

1. Read `src-tauri/src/sessions/registry.rs` end to end. Find the `Registry` impl block, the `InstanceEntry` struct, and the existing test pattern.
2. Add a failing test in the existing `mod tests`:
   ```rust
   #[test]
   fn record_interactive_session_then_mark_busy() {
       let registry = Registry::new(); // adapt to actual constructor
       registry.record_interactive_session("sess-abc", "/tmp/x");
       let entry = registry.find_by_session_id("sess-abc").expect("recorded");
       assert!(matches!(entry.kind, InstanceKind::Interactive));
       assert!(!entry.busy);

       registry.set_busy("sess-abc", true);
       assert!(registry.find_by_session_id("sess-abc").unwrap().busy);

       registry.set_busy("sess-abc", false);
       assert!(!registry.find_by_session_id("sess-abc").unwrap().busy);
   }
   ```
   Adjust constructor name to match actual code. If existing tests use a `Registry::new_for_test()` or similar harness, mirror it.
3. Run the new test. Expect compile errors for missing methods or `busy` field.
4. Add the `busy: bool` field to `InstanceEntry` (default false, derive `Default` if needed).
5. Implement the three helpers per the parent plan's Step 4 code.
6. Run `cargo build`. Add `Interactive` match arms wherever the compiler complains. Sensible defaults:
   - "is automated" -> false
   - "is remote" -> false
   - kind label / display -> "Interactive"
7. Run `cargo test -p claude-usage-tauri --lib sessions::registry::tests`. Expect all pass including the new one.
8. Run full suite `cargo test -p claude-usage-tauri --lib`. Expect 171 (170 + 1 new).

## Gotchas

- `record_interactive_session` MUST overwrite an existing entry with the same session_id (HashMap insert semantics, not `entry().or_insert()`). The takeover flow in Phase 7 relies on this to convert a Manual entry to Interactive.
- If `InstanceEntry` is serialized to disk anywhere, adding `busy: bool` is a schema change; check `settings/store.rs` and project_groups serialization. If `InstanceEntry` is in-memory-only (which the existing CLAUDE.md suggests), no schema migration needed.
- `instances-changed` Tauri event is already emitted on registry mutations. New helpers must call `self.emit_changed()` (or whatever the existing convention is) at the end of their mutation.

## Don't

- Don't commit. Don't add features beyond what the parent plan specifies.
- Don't refactor unrelated parts of `registry.rs`.
- Don't break existing tests.

## Acceptance

- 171 lib tests pass.
- New helpers are visible to other modules (`pub fn`).
- `instances-changed` continues to fire on mutations (existing event behavior preserved).
- `cargo build` clean, no new warnings beyond pre-existing 4.
