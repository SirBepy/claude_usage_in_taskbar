# Duplicate: submenu-positioning math (dashboard vs view-more-menu)

## Goal
Extract the "position a submenu to the right (or left if no room) of its parent item, clamped to the viewport" math into one shared helper instead of hand-copying it.

## Context
The dashboard add-widget submenu positioning added this session (`src/views/dashboard/dashboard.ts`, in `openAddWidgetSubmenu`, the `itemRect`/`subRect`/`left`/`top` clamp block) is a line-for-line copy of the when-done submenu positioning in `src/views/sessions/view-more-menu.ts:148-161`. Both compute `left = itemRect.right + 4`, flip to `itemRect.left - subRect.width - 4` when it overflows, clamp `top` to the viewport, and set `sub.style.left/top`.

## Approach
Add a `positionSubmenu(sub: HTMLElement, parent: HTMLElement)` next to `positionDropdown` in `src/views/sessions/position-dropdown.ts` (it already owns the sibling `positionDropdown` and is dependency-free). Replace both call sites with it. Keep the 4px gap/clamp constants identical so neither menu shifts.

## Acceptance
- Both `dashboard.ts` and `view-more-menu.ts` call the shared helper; the inline math is gone from both.
- Dashboard add-widget submenu and the sessions when-done submenu still open in the correct position, including near the right/bottom viewport edges.
- `pnpm tsc --noEmit` green.
