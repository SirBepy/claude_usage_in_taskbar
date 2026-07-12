# event-store.ts gained an eviction subsystem: extract it

## Goal
Separate the idle-eviction/TTL lifecycle policy from event-store.ts's core dedup/cache job.

## Context
The 2026-07-09 perf pass (commits c208e471, a3065785) added ~120 lines to src/shared/chat/event-store.ts (now 553 lines): IDLE_TTL_MS/SWEEP_INTERVAL_MS consts, lastAccess bookkeeping threaded through nearly every method, and teardown/evictEnded/unmarkEnded/sweep (lines ~42-56, ~442-505). Distinct concern layered onto the dedup/cache core.

## Approach
Extract the eviction policy (teardown, evictEnded, unmarkEnded, sweep, TTL consts) into a companion module the store composes with; lastAccess stays a CacheEntry field but is touched via a tiny helper. Related pending cleanup: ai_todo 189 (swap() unlistenWatch leak) - do together, same file.

## Acceptance
`pnpm exec tsc --noEmit` clean; vitest green; eviction semantics unchanged: never evict subscribed entries, never evict on failed refresh, ended-latch clearable via unmarkEnded.
