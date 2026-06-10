# Remove the now-dead `isModel` export from effort-presets.ts

## Goal

Delete the orphaned `isModel` type-guard (and tidy any stale import), or re-wire it if a caller is actually wanted.

## Context

On 2026-06-10 the model list became data-driven (`settings.models`), so model validation was loosened: `readPresets` and `readLastChoice` now accept any non-empty model string, and `src/views/settings/subviews/presets/presets.ts` validates a preset's model against the live editable list instead of `isModel`. Result: `isModel` (`src/shared/effort-presets.ts:27`) is now defined-but-never-called — a repo-wide grep for `\bisModel\b` returns count 1 (the definition only). `isEffort` right below it is still used and must stay.

## Approach

Delete the `export function isModel(...)` block in `src/shared/effort-presets.ts`. Grep `\bisModel\b` again to confirm zero remaining references before/after. Run `pnpm tsc --noEmit` (should stay clean). If any consumer turns out to want model validation, the correct replacement is membership in `readModels(settings)`, not a fixed-tuple guard.

## Acceptance

- `isModel` removed (or deliberately re-wired with a real caller).
- `grep \bisModel\b` returns 0.
- `pnpm tsc --noEmit` clean; vitest green.
