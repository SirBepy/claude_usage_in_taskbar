# Delete dead formatDate in history.ts

## Goal
Remove the unused `formatDate` function from `history.ts`.

## Context
`history.ts` contains a `formatDate(secs)` function that returns `d.toLocaleString()`. After the sticky-date-separator rework, `renderList` switched to `formatTime` (time-only) for row metadata. `formatDate` now has exactly 1 occurrence (the definition itself) — no callers remain. File: `src/views/history/history.ts`.

## Approach
Delete the `formatDate` function body (~7 lines). Verify no other file imports or calls it.

## Acceptance
- `grep -r "formatDate" src/views/history/` returns 0 results.
- `cargo check` and TypeScript compile cleanly.
