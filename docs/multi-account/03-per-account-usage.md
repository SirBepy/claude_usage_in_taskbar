# Milestone 03 - Per-account usage + pace/capacity

Depends on: 01 (accounts + per-account cookies). See `00-overview.md`.

## Goal
Scrape and track usage independently per account (5h + 7d, safe pace, capacity), turning every
single-snapshot structure into a per-account collection.

## Context (current single-account reality)
- `scraping/client.rs:29-101` `fetch_usage(base_url, session_key)` -> `GET /api/organizations`
  then `/organizations/{id}/usage`, always `orgs.first()` (`:60-62`).
- `AppState.current_usage: Mutex<Option<UsageSnapshot>>` (`state.rs:9`); `UsageSnapshot`
  (`types/usage.rs:6-12`) has NO account id.
- `AppState.auth_state: Mutex<AuthState>` (`state.rs:11`) - one global enum.
- `usage_snapshots` table (`storage/usage_store.rs:19-27`) - no account column.
- `tokens/capacity.rs` `CapacityEstimate` - one persisted file (`settings/paths.rs:115-117`).
- One poll loop (`scheduler.rs:19-87`, `PollOnce` `:165-248`) reading the single `session.txt`.

## Approach
1. Poll loop iterates accounts; for each, `fetch_usage` with that account's stored `sessionKey`
   (from 01). Keep the existing HTTP path; just loop + key by account.
2. `UsageSnapshot` gains an `account_id`. `AppState.current_usage` ->
   `Mutex<HashMap<AccountId, UsageSnapshot>>`. `AppState.auth_state` -> per-account map.
3. `usage_snapshots` table + `CapacityEstimate` gain an account dimension (column / keyed file).
   Safe pace + capacity computed per account (each account's own window reset times).
4. Migration: re-key the existing single account's usage history + capacity to account #1
   (coordinate with 01's identity migration).

## Files
- `src-tauri/src/scraping/client.rs`, `src-tauri/src/scheduler.rs`
- `src-tauri/src/types/usage.rs`, `src-tauri/src/state.rs`
- `src-tauri/src/storage/usage_store.rs` (+ schema migration)
- `src-tauri/src/tokens/capacity.rs`, `src-tauri/src/settings/paths.rs`

## Acceptance
- Each account's 5h/7d usage, safe pace, and capacity are tracked and persisted independently.
- The poll covers every account each tick; one account's failure does not drop the others.
- Existing history/capacity is migrated to account #1 with no loss.
