# event-store swap() merge branch leaks the losing entry's watch listener

**Type:** task

## Goal

Close the last known listener leak in `src/shared/chat/event-store.ts`: when `swap()` merges a placeholder entry into a real one, the losing entry's `unlistenWatch()` is never called.

## Context

Found during the 2026-07-09 eviction work (commit c208e471) by the implementing agent, deliberately left out of scope there. `swap()` (placeholder-id promotion when a new chat gets its real session id) deletes the losing cache entry but only calls its `unlisten()`, not `unlistenWatch()` in the merge branch - a small, bounded leak (one watch listener per new-chat promotion) of the same class the eviction work fixed. The teardown helper added by that commit already handles both listener kinds - reuse it.

## Approach

- In `swap()`'s merge branch, route the losing entry through the existing full-teardown helper (minus cache.delete ordering it already does) instead of the bare `unlisten()` call.
- Check both swap branches (merge vs plain rename) for symmetry.

## Acceptance

- Grep shows no path where an entry is deleted from `cache` while either of its two listener handles is still registered.
- Starting several new chats in a row does not accumulate `chat-watch:*` (or equivalent) Tauri listeners - verifiable in a dev console by counting listeners, or by unit test if the suite fakes the Tauri event layer.
- Fast vitest suite stays green.
