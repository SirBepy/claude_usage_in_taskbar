# Componentize the kebab/context menu shared by convention from project-detail.css

**Type:** task

## Goal

One real shared module for the kebab menu (`.menu-anchor`/`.menu-popover`/`.menu-item`) instead of four-plus views reusing CSS that happens to be globally loaded from `project-detail.css`.

## Context

Found during the 2026-07 settings rewrite inventory: `src/views/settings/subviews/accounts/accounts.ts` builds its account-row kebab menu against CSS defined in `src/views/project-detail/project-detail.css`, with a comment admitting the pattern is copy-shared ("already loaded globally, same pattern as session-detail/characters/news"). Works only because every stylesheet is global. Deferred from the rewrite because it touches 4+ non-settings views.

## Approach

- New `src/shared/kebab-menu.ts` (+ css) exposing an open/close/position helper and the markup factory; move the `.menu-*` rules out of project-detail.css.
- Migrate call sites: accounts.ts, session-detail, characters, news (grep `.menu-popover` for the full list).
- Keep DOM classes identical first pass to avoid visual churn; the win is ownership, not restyling.

## Acceptance

- All kebab menus render/behave identically (open, dismiss-on-outside-click, positioning near edges).
- `.menu-*` rules exist in exactly one CSS file.
- `pnpm tsc --noEmit` + vitest green.
