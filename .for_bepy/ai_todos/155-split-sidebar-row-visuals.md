# sidebar.ts should be split

## Goal
Bring src/views/sessions/sidebar.ts (449 lines) back under the 400-line bar by extracting its row-visual helpers into their own module.

## Context
sidebar.ts mixes three concerns: (1) drain-chip state + debounced refresh (drainMap, refreshDrainMap at sidebar.ts:41-75, drainChipHtml), (2) row-visual HTML builders (projBadgeHtml, avatarWrap, leadingVisual, draftLeadingVisual at sidebar.ts:84-140), (3) session refresh/render orchestration (refreshSessions at sidebar.ts:145, renderSidebar at sidebar.ts:219). The visual builders are pure HTML-string functions with no sidebar state dependency. Reminder: sidebar.ts must not be statically imported into the permission-modal/state cluster (import cycle crashes vitest) - the extraction direction (helpers OUT of sidebar.ts) is safe, but do not add new imports INTO sidebar.ts from that cluster.

## Approach
Move the pure row-visual builders (projBadgeHtml, avatarWrap, leadingVisual, draftLeadingVisual, and drainChipHtml if it stays presentation-only) into src/views/sessions/sidebar-row-visuals.ts; keep drain state + refresh orchestration in sidebar.ts. Verbatim moves, re-export or update the few importers of projBadgeHtml.

## Acceptance
sidebar.ts under ~350 lines; new module holds only pure HTML builders; `pnpm tsc --noEmit` and full `pnpm vitest run` green; no new static import cycle (vitest would crash if introduced).
