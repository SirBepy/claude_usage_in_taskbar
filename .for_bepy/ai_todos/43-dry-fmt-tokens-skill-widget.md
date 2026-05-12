# Reuse shared formatTokens in skill-usage widget

## Goal
Drop the local `fmtTokens` from `skill-usage-widget.ts` and use the project's existing `formatTokens`.

## Context
`src/views/statistics/skill-usage-widget.ts:21-25` defines a local `fmtTokens(n: number): string` that re-implements `formatTokens` from `src/shared/tokens.ts:38`. The shapes are nearly identical (k/M abbreviation), but the file maintains its own copy. `src/shared/formatters.ts:8` also exports a `formatTokens` (slightly different breakpoints); the canonical pick for views is `src/shared/tokens.ts` since `statistics.ts:13` already imports from there.

## Approach
1. In `skill-usage-widget.ts`, import `formatTokens` from `../../shared/tokens`.
2. Replace every call site `fmtTokens(x)` with `formatTokens(x)`.
3. Delete the local `fmtTokens` function.
4. Run `npx tsc --noEmit -p tsconfig.json` and `npx vitest run`.

## Acceptance
`grep -n "fmtTokens" src/views/statistics/skill-usage-widget.ts` returns zero results, and the widget still renders identical-looking k/M labels in the dev build.
