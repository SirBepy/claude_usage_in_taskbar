# Duplicate: formatCountdown

## Goal
Reuse the existing "in Xh Ym" relative-time formatter instead of a second copy.

## Context
`src/shared/chat/rate-limit-banner.ts:47` adds `formatCountdown(remainingMs)`,
computing `h = floor(totalMin / 60)`, `m = totalMin % 60`, and returning
`` `in ${h}h ${m}m` `` / `` `in ${m}m` ``. `src/shared/formatters.ts:90`
(`fmtResetDisplay`) already computes the identical relative string the same way
(`h = Math.floor(diffMs / 3_600_000)`, `m = Math.floor((diffMs % 3_600_000) /
60_000)`, `` `in ${h}h ${m}m` `` / `` `in ${m}m` ``) and is actively used by
`overlay-logic.ts`, `dashboard.ts`, and `account-selector.ts`. The only real
differences are that `formatCountdown` clamps negative input to 0 and adds an
"in under a minute" case for `<1` minute remaining.

## Approach
Add the "in under a minute" / negative-clamp behavior to `fmtResetDisplay` (or
extract just its relative-string math into a small shared `formatRelativeMinutes
(diffMs)` helper in `shared/formatters.ts`), and have `rate-limit-banner.ts`'s
`formatCountdown` call that instead of recomputing the same division/modulo logic.

## Acceptance
Only one implementation of the "in Xh Ym" countdown math exists in
`shared/formatters.ts`; `rate-limit-banner.ts` delegates to it; existing
`tests/rate-limit-banner.test.mjs` countdown-format assertions still pass.
