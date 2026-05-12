# Consolidate duplicate formatTokens into one canonical export

## Goal
Remove the duplicate `formatTokens` in `src/shared/tokens.ts` and point all callers at the canonical version in `src/shared/formatters.ts`.

## Context
`formatTokens` is defined in both `src/shared/tokens.ts:38` and `src/shared/formatters.ts:8` with different implementations (tokens.ts handles null/undefined and has a 10K threshold; formatters.ts uses `Number.isFinite` guard). All current callers import from `tokens.ts`, leaving `formatters.ts` unreachable. A comment in `formatters.ts` marks it as the canonical source.

## Approach
1. Delete `formatTokens` from `src/shared/tokens.ts` (lines 38-44).
2. Add a re-export in `src/shared/tokens.ts`: `export { formatTokens } from "./formatters";` so existing import paths don't break.
3. Run `pnpm tsc --noEmit` to verify.

## Acceptance
- `formatTokens` has exactly one implementation (in `formatters.ts`).
- All callers still work without changing their import path.
- No TS errors.
