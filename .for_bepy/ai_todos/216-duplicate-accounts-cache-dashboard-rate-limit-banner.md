# Duplicate: accountsCache / getCachedAccount

## Goal
De-duplicate the two independent "cached account list for sync lookup" module
caches.

## Context
`src/shared/chat/rate-limit-banner.ts:73` introduces a new module-level
`let accountsCache: Account[] = []` plus `refreshAccountsCache()`
(`rate-limit-banner.ts:75`) and `getCachedAccount()` (`rate-limit-banner.ts:82`),
whose only job is to let synchronous render code look up an `Account` by id
without threading an async fetch through every call. `src/views/dashboard/
dashboard.ts:41` already has a module-level `let accountsCache: Account[] = []`
with the same shape and purpose (populated at `dashboard.ts:553`, read via
`.find((a) => a.id === ...)` throughout the file). Two independent, same-named,
same-purpose caches now exist with no shared source.

## Approach
Extract a small shared `accounts-cache.ts` (e.g. under `src/shared/`) exporting
`refreshAccountsCache()` / `getCachedAccount(id)` / a read-only accessor for the
full list, and have both `dashboard.ts` and `rate-limit-banner.ts` import it
instead of keeping private copies. Note `dashboard.ts`'s cache resets per mount
call, so the shared version needs to preserve that reset semantics (or confirm a
shared singleton is fine for both consumers) before merging.

## Acceptance
Only one `accountsCache` implementation exists; both `dashboard.ts` and
`rate-limit-banner.ts` (and `active-session.ts`, which already imports
`getCachedAccount`) read from it; `pnpm tsc --noEmit` passes.
