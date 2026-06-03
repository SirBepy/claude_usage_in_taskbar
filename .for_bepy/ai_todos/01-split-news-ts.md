# Split news.ts into list + detail/generation modules

## Goal
`src/views/news/news.ts` is 422 lines and mixes three concerns in one file: the list view, the detail view, and the AI-summary generation/streaming logic. Split it at that seam so each unit is focused.

## Context
The file grew across the news redesign. It currently holds: state + helpers (fetchPosts/refresh/markAllRead/notify), the header + kebab menu (`template`, `renderMenu`, `renderDetailMenu`), the list (`renderBody`, `renderItem`), the detail view (`renderDetail`, `renderSummaryBlock`), and the generation/streaming layer (`openDetail`, `ensureSummary`, `regenerate`, `openOriginal`, plus the `generatingSlugs`/`errorBySlug`/`streamBySlug`/`phaseBySlug` maps and the `news-summary-phase`/`news-summary-delta` event wiring in `renderNewsView`). The clean boundary is the detail+generation cluster vs the list+header shell.

## Approach
Extract the detail view + summary generation into `src/views/news/news-detail.ts`: `renderDetail`, `renderDetailMenu`, `renderSummaryBlock`, `openDetail`, `ensureSummary`, `regenerate`, `openOriginal`, and the markdown-it instance. Keep shared `state` + `paint` accessible (either pass them in, or move `state` to a small `news-state.ts` both import). `news.ts` keeps the view shell (template/header/menu/list) and `renderNewsView` wiring. Confirm with `pnpm tsc --noEmit -p tsconfig.json` (the real typecheck gate) and the `news-redesign.e2e.js` spec.

## Acceptance
- news.ts under ~300 lines; detail/generation logic in its own file.
- `pnpm tsc --noEmit` clean (modulo the pre-existing main.ts:157/163 errors).
- No behavior change: list, detail, streaming, kebab, regenerate all still work.
