# Remove dead export keyword from showChatLoadingOverlay

## Goal
`showChatLoadingOverlay` in `active-session.ts` is exported but has no external callers; make it module-private.

## Context
`src/views/sessions/active-session.ts:17` exports `showChatLoadingOverlay`. Grepping the repo shows its only call site is inside `active-session.ts` itself (line ~112). No other file imports it.

## Approach
Remove the `export` keyword from `showChatLoadingOverlay`'s declaration. Run `pnpm tsc --noEmit` to confirm nothing breaks.

## Acceptance
- `showChatLoadingOverlay` is no longer exported.
- No TS errors.
