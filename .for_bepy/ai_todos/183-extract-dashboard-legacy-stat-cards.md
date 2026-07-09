# src/views/dashboard/dashboard.ts should shed its legacy fallback card renderer

## Goal
Move the pre-onboarding "legacy two-card" fallback UI out of dashboard.ts into its own module so dashboard.ts's remaining bulk is just the widget-shell/account-selector orchestration it already split toward today.

## Context
`src/views/dashboard/dashboard.ts` is 572 lines. Today's diff already extracted the kebab menu into `dashboard-more-menu.ts`, but `legacyStatCardsHtml` + its local `renderReset` closure (dashboard.ts:267-358, ~90 lines) is a fully self-contained, reusable unit: it takes only `UsageRecord[]` + `Settings`, does its own percent/reset-window math, and returns a plain HTML string. It's only reached from `renderShell` (dashboard.ts:400-402) when `accountsCache.length === 0` - the pre-multi-account fallback path - and has no other dependency on dashboard.ts's module state.

## Approach
Extract `legacyStatCardsHtml` (and its private `renderReset` helper) into a new `src/views/dashboard/legacy-stat-cards.ts`, exporting just `legacyStatCardsHtml(history: UsageRecord[]): string`. Import it back into `dashboard.ts`'s `renderShell`.

## Acceptance
`dashboard.ts` drops by ~90 lines; `pnpm tsc --noEmit` passes; the empty-registry dashboard view (no accounts added yet) still renders the two legacy stat cards identically.
