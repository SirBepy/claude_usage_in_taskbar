# Extract tokensAllIn shared helper

## Goal
Replace the two duplicate `tokenTotal` functions with one shared helper that takes a `TokenBreakdown`.

## Context
- `src/views/statistics/skill-usage-widget.ts:14-17` defines `tokenTotal(e: SkillUsageEntry)` returning `input + output + cache_read + cache_create`.
- `src/views/skill-detail/skill-detail.ts:18-21` defines the same body but takes `SkillUsageEvent`.

Both signatures collapse to "sum the four fields of a TokenBreakdown".

## Approach
1. Add `export function tokensAllIn(t: TokenBreakdown): number { return Number(t.input) + Number(t.output) + Number(t.cache_read) + Number(t.cache_create); }` to `src/shared/tokens.ts` (next to the existing `formatTokens`/`totalTok` exports). Import the `TokenBreakdown` type from `../types/ipc.generated`.
2. In both view files, import `tokensAllIn` and replace `tokenTotal(x)` with `tokensAllIn(x.tokens)`.
3. Delete the local `tokenTotal` definitions.
4. Run `npx tsc --noEmit -p tsconfig.json`.

## Acceptance
`grep -rn "function tokenTotal" src/` returns zero results. Both view files import `tokensAllIn` from `shared/tokens`. Statistics widget and skill-detail render identical numbers as before.
