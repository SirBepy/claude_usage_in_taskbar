# Split session-detail.ts (457 lines, mixes card-render + chrome/menu/cta + enrich)

## Goal
`src/views/session-detail/session-detail.ts` grew to 457 lines and mixes several concerns. Extract the card-rendering layer into its own module to keep the view file focused on wiring.

## Context
`src/views/session-detail/session-detail.ts` now contains: pure card builders (`pieCard`, `cacheCard`, `countsCard`, `modelEffortRow`, `shortModel`, `dateTimeParts`, `renderCards`, `CardCtx`), live chrome (`renderChrome` - chips + automated actions), the more-options menu (`wireMenu`), the CTA (`wireCta`), historical enrichment (`enrichHistorical`), the entry point (`renderSessionDetailView`), and the lit-html `template`. The card builders are a clean, self-contained seam (no DOM wiring, just string/HTML from data).

## Approach
- Move the card builders + `CardCtx` + `shortModel`/`dateTimeParts`/`totalTok`/`cacheEffPct` helpers into `src/views/session-detail/session-detail-cards.ts`, exporting `renderCards(r, ctx)` and the `CardCtx` type.
- Keep `renderSessionDetailView`, `renderChrome`, `wireMenu`, `wireCta`, `enrichHistorical`, `template` in `session-detail.ts`, importing `renderCards`/`CardCtx`.
- See also ai_todo 12 (`shortModel` dedupe) - resolve that in the same pass if convenient.

## Acceptance
- `session-detail.ts` drops below ~300 lines; card logic lives in `session-detail-cards.ts`.
- No behavior change: live + closed chat detail render identically (overview/model-effort/counts/pie/cache).
- `tsc --noEmit` (no new errors), `vite build`, `vitest run` green.
