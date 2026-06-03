# Unexport rootChildOf from chat-pagination.ts

## Goal

`rootChildOf` is exported from `src/shared/chat/chat-pagination.ts` but has no callers outside that file. Remove the `export` keyword.

## Context

`src/shared/chat/chat-pagination.ts:20` defines `export function rootChildOf(...)`. Grep across `src/` shows it is only called at `chat-pagination.ts:122` (inside `ChatPaginator.prependEvents`). No other file imports it.

## Approach

Remove `export` from the function declaration on line 20. No callers to update.

## Acceptance

- `pnpm tsc --noEmit` clean.
- Grep for `rootChildOf` finds exactly 2 hits (definition + one internal call), both in `chat-pagination.ts`.
