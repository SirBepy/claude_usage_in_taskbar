# Dedupe projectNameFromCwd with projectName helper

## Goal
Remove `projectNameFromCwd` from `history.ts` and reuse the existing `projectName` from `sessions-helpers.ts`.

## Context
`history.ts:28` defines `projectNameFromCwd(cwd: string)` which splits on `/\` and returns the last segment. `sessions-helpers.ts:10` defines `projectName(i: Instance)` that does the exact same split on `i.cwd`. Both are live code. DRY violation introduced during History view rework.

## Approach
Two options:
1. Export a `projectNameFromCwd(cwd: string)` from `sessions-helpers.ts` (rename the existing `projectName` or add an overload), then import it in `history.ts`.
2. Keep `projectName(i)` in sessions-helpers, export a standalone `cwdToProjectName(cwd: string)` helper next to it, and use that in history.ts.

Either way: delete the private `projectNameFromCwd` in `history.ts` and import the shared version.

## Acceptance
- `grep -r "projectNameFromCwd" src/` returns 0 results (or only the one in sessions-helpers).
- History sidebar still shows project names correctly.
- No other callers broken.
