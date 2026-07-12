# Duplicate: ended/vanished-session eviction diff copy-pasted in sessions.ts

## Goal
One shared helper for the ended-session reconcile block used by both instances-changed handlers.

## Context
`src/views/sessions/sessions.ts:331-339` (main sessions view) and `src/views/sessions/sessions.ts:667-675` (detached-window view) contain an identical ~9-line block: snapshot previousIds, await refreshSessions(), gate on success, diff ids, unmarkEnded survivors, evictEnded the vanished. The second copy's comment even admits the duplication. Added in the 2026-07-09 perf pass (commits c208e471 + a3065785).

## Approach
Factor into e.g. `reconcileEndedSessions(previousIds: Set<string>, refreshed: boolean)` (module-local to sessions.ts is fine), called from both handlers. Keep the stale-mount guards at the call sites.

## Acceptance
One implementation, two call sites; `pnpm exec tsc --noEmit` clean; vitest suite green; eviction still gated on successful refresh (do not regress commit a3065785).
