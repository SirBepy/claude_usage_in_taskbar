# Drop dead statusbar cache exports

## Goal

Remove two exported-but-unused helpers from `src/views/sessions/session-statusbar.ts`: `getCachedGitInfo` and `getCachedMeta`. The `SessionStatusbar` constructor reads `gitInfoCache` / `metaCache` maps directly; the public getters were added speculatively and have zero callers outside the module.

## Context

Verified with grep — both symbols appear exactly once in the codebase (their own `export function` declaration). They were added in commit `fc6b448` ("smooth out statusbar pop-in") alongside the still-used `fetchGitInfo`, on the assumption other modules might want sync cache lookups. None do.

Files:
- `src/views/sessions/session-statusbar.ts:76` — `export function getCachedGitInfo`
- `src/views/sessions/session-statusbar.ts:91` — `export function getCachedMeta`

## Approach

1. Delete both `export function` blocks.
2. Confirm `npx tsc --noEmit` passes (no other module imports either name).
3. Keep `fetchGitInfo` and the module-scope `gitInfoCache` / `metaCache` maps — those are still in use.

## Acceptance

- Both functions removed from `session-statusbar.ts`.
- `npx tsc --noEmit` reports no new errors (pre-existing `main.ts:113` warning is unrelated).
- Statusbar cache behavior unchanged (revisit still warms from cache instantly).
