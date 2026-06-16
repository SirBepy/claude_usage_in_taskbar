# SQLite storage migration + user-controlled retention

## Decision (Joe, 2026-06-16)
**Proceed per the design spec, with the specced defaults: usage_snapshots 90d, token_records 90d, skill_events KeepForever.** Migration is non-destructive (old JSONL renamed to .bak, gated by `storage_migrated_v1`). Before pinning, run the package safety check on `rusqlite` 0.40.x (bundled) + `cargo audit` per the global Packages rule.

## Goal

Replace the three JSONL/daily-file data stores with a single SQLite database, remove the hard-coded 90-day pruning cap, and add a Settings "Data" section where the user can configure per-dataset retention policies and clear data manually.

## Context

Full design spec at `docs/superpowers/specs/2026-06-15-sqlite-storage-retention-design.md` (gitignored, local only). Brainstormed 2026-06-15.

Current data files:
- `~/.claude/history.jsonl` - 10-min usage snapshots (pruned at 90 days, hard-coded in `src-tauri/src/history.rs`)
- `~/.claude/token_history.jsonl` - per-message token records (same pruning)
- `~/.claude/skill-usage/events-YYYY-MM-DD.jsonl` - per-invocation skill events (daily files, globbed by `src-tauri/src/ipc/usage.rs`)

The 90-day cap is the pain point. Graphs are limited to 5h/7d windows but could show months or years with retained data.

Key files to know:
- `src-tauri/src/history.rs` - usage snapshot read/write + current pruning logic
- `src-tauri/src/scheduler.rs` - calls pruning on scheduler tick
- `src-tauri/src/ipc/usage.rs` - IPC handlers for get_history, skill usage queries
- `src-tauri/src/state.rs` - AppState (needs db connection added)
- `src/views/settings/` - existing Settings view (add Data section here)

## Approach

See full spec for detail. Summary:

**1. Add rusqlite dependency** (`version = "0.40", features = ["bundled"]`). Run `cargo audit` before pinning.

**2. Create `src-tauri/src/storage/` module:**
- `db.rs` - `open_db()`, `init_schema()`, schema versioned via `PRAGMA user_version = 1`
- `usage_store.rs` - insert/query usage snapshots
- `token_store.rs` - insert/query token records
- `skill_store.rs` - insert/query skill events
- `retention.rs` - `RetentionPolicy` enum (KeepForever / KeepDays(u32)), `prune_all()`
- `migration.rs` - one-time JSONL import on first launch

**3. Schema** (three tables, identical shape):
```sql
CREATE TABLE usage_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX idx_usage_ts ON usage_snapshots(timestamp);
-- same for token_records, skill_events
```
Existing structs stored as JSON blobs - no type migration needed.

**4. One-time migration** (gated by `"storage_migrated_v1"` settings flag):
- Read each JSONL source line by line, insert into SQLite
- On failure: log and skip that line/file; don't abort
- After all three attempted: write migration flag, rename originals to `.bak`

**5. Retention policies** stored in settings.json under `"retention"` key. Defaults: usage_snapshots=90d, token_records=90d, skill_events=forever. Presets: Never / 1 year / 90 days / 30 days / 7 days. Pruning runs at startup + once daily via scheduler.

**6. New IPC handlers** in `src-tauri/src/ipc/storage.rs`:
- `get_storage_info()` → `Vec<DatasetInfo>` (record_count, oldest_entry, newest_entry, retention)
- `set_retention_policy(dataset, policy)` → updates settings + prunes immediately
- `clear_dataset(dataset)` → DELETE all + VACUUM
- Add to `generate_handler!` in main.rs. No capabilities entry needed.
- Add new types to `src-tauri/tests/export_types.rs`, regen `ipc.generated.ts` via `CARGO_TARGET_DIR=src-tauri/target-export cargo test --test export_types`

**7. Settings UI "Data" section** - three dataset cards each showing: name, record count, date range, retention dropdown, "Clear all" button. Footer: total DB file size (`fs::metadata(db_path).len()`). No per-table size breakdown.

Rejected alternatives: kit-first extraction (premature - no second consumer yet), retention-only layer over JSONL (JSONL doesn't scale), start fresh (Joe wants existing data preserved).

## Acceptance

- `cargo build` passes clean
- First launch imports existing JSONL into SQLite; `.bak` files appear at `~/.claude/`
- Dashboard graphs show same data as before (no regression in 5h/7d views)
- Settings > Data section renders three cards with correct record counts and date ranges
- Changing retention dropdown prunes immediately and refreshes counts
- "Clear all" empties dataset (count drops to 0)
- Data persists across app restarts
- No automatic 90-day pruning unless user explicitly sets 90d policy
- `cargo audit` clean on rusqlite before shipping
