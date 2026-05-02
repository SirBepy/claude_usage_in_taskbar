# Cache the characters list to skip per-notification disk scan

## Goal
Stop re-reading and re-validating every character on disk for each `WorkFinished`/`QuestionAsked` notification. Replace with an in-memory cache that invalidates on filesystem change or explicit refresh.

## Context
v1 characters feature shipped with `characters::list()` doing `std::fs::read_dir` + per-character JSON parse + per-slot file `.exists()` checks on every call. `characters::get(id)` calls `list()`. The notification resolver (`src-tauri/src/notifications/rules.rs:resolve_with_character`) calls `get(id)` synchronously on the dispatch thread when a project has `Avatar::Character(id)`.

For 3-10 characters with bundled SSD, this is fast enough. Concern surfaces when characters live on a network drive or grow to dozens. Code review on commit `4d9a838` flagged this as Important.

The v1 spec (`docs/superpowers/specs/2026-05-02-characters-design.md`) explicitly chose "no caching" to keep the loader simple. Refresh strategy was punted: `invalidateCharactersCache` exists on the frontend (`src/shared/characters.ts`) but the Rust side has no corresponding mechanism.

## Approach
- Add `characters::cache::cached_list() -> Vec<Character>` backed by `OnceCell<Mutex<...>>` or `RwLock<Option<...>>`.
- Add `characters::cache::invalidate()` that callers hit after `assign_character`, after the bundled-copy step, after the `/character-creator` skill writes a new character (no in-process trigger; rely on the user clicking refresh in the frontend, which fires an IPC that calls `invalidate`).
- Add an `IPC invalidate_characters_cache()` command and call it from `shared/characters.ts::invalidateCharactersCache`.
- Repoint `characters::get(id)` and `resolve_with_character` to read through the cache.
- Test: assert that two `list()` calls hit the disk only once when no invalidate was issued; assert invalidate forces a re-scan.

Rejected:
- Filesystem watcher (`notify` crate): adds a dep, adds a thread, edge cases on Windows. Frontend-driven invalidation is enough for v1.5.
- Caching only `get(id)` results: half-measure; `list()` is the hot path for the Characters view.

## Acceptance
- `cargo test characters` still green.
- New test in `characters::cache` verifies invalidate semantics.
- `notifications::rules::resolve_with_character` no longer blocks on a full directory scan per notification.
- Frontend "Refresh" button in the Characters view actually invalidates the Rust cache (verify by adding a new character via the skill, clicking Refresh, seeing it appear without restarting the app).

## Bonus: happy-path test for `resolve_with_character`
The same code review noted the resolver has no test that exercises the success path (valid character + non-empty slot returns the synthetic rule with `CHARACTER_PACK_SENTINEL`). Adding the cache makes this easier: inject the cache directly in the test rather than mocking `paths::characters_dir()`. Add a happy-path test as part of this work.
