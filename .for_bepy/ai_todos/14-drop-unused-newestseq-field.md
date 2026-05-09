# Drop unused newestSeq from SessionEventStore CacheEntry

## Goal

Remove the `newestSeq` field from `CacheEntry` and its assignments — it's populated by `loadInitial` and `swap` but never read anywhere.

## Context

In `src/shared/chat/event-store.ts` the `CacheEntry` interface has:

```ts
oldestSeq: number | null;
newestSeq: number | null;
```

Pagination only needs `oldestSeq` (passed as `before_seq` to fetch the previous page). `newestSeq` was added speculatively during the pagination feature but no consumer reads it. Live-tail events arrive via the listener and are pushed onto `entry.events` directly without consulting any seq.

## Approach

In `src/shared/chat/event-store.ts`:
1. Remove `newestSeq: number | null;` from the `CacheEntry` interface.
2. Remove the `entry.newestSeq = Number(page.newest_seq);` assignment in `loadInitial`.
3. Remove `existing.newestSeq = fromEntry.newestSeq ?? existing.newestSeq;` in `swap`.
4. Remove `newestSeq: null` from `makeEntry`.

Backend `HistoryPage.newest_seq` can stay — it's harmless on the wire and could be useful for future debug/logging.

## Acceptance

- Field removed from CacheEntry; no references remain (`grep -n newestSeq src/`).
- `pnpm tsc --noEmit` clean.
- `pnpm vitest run tests/event-store.test.mjs` still passes.
