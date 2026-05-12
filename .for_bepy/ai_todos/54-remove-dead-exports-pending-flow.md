# Remove dead export keyword from rebindPaneHeader

## Goal
`rebindPaneHeader` in `pending-flow.ts` is exported but has no external callers; make it module-private.

## Context
`src/views/sessions/pending-flow.ts:251` exports `rebindPaneHeader`. Its only call site is within `pending-flow.ts` itself (line ~194). No other file imports it.

## Approach
Remove the `export` keyword from `rebindPaneHeader`'s declaration. Run `pnpm tsc --noEmit` to confirm nothing breaks.

## Acceptance
- `rebindPaneHeader` is no longer exported.
- No TS errors.
