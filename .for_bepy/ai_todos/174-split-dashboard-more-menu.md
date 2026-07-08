# dashboard.ts should be split (extract the kebab "more options" menu)

## Goal
Extract the dashboard's "more options" kebab menu into its own module so `dashboard.ts` shrinks back toward one concern (mount/lifecycle/refresh + widget shell), not menu DOM construction.

## Context
`src/views/dashboard/dashboard.ts` is 657 lines and mixes several concerns: poll/lifecycle wiring, account selection, legacy stat cards, the setup banner, widget shell rendering, full refresh, AND the whole kebab menu. The menu block is a clean, self-contained seam added this session: `closeDashMenu`, `onDashMoreClick`, `openDashMenu`, `openAddWidgetSubmenu`, and the `triggerRefresh` helper (roughly dashboard.ts:203-330). It only needs a handful of injected dependencies (`editMode` getter + `onToggleEditMode`, `triggerRefresh`/`api.pollNow`, `dashboardWidgets` + `setWidgetEnabled` + `persistDashboardWidgets`, `getWidget`, and a re-render callback).

## Approach
Create `src/views/dashboard/dashboard-more-menu.ts` exporting something like `openDashMenu(anchor, deps)` / `closeDashMenu()` (keep `registerMenuCloser(closeDashMenu)` there). Pass the small dependency bag from dashboard.ts rather than importing module state back and forth (avoid an import cycle - see the sidebar.ts import-cycle memory). dashboard.ts keeps only the `#dashMoreBtn` template button + an `onDashMoreClick` that delegates. Do the extraction as a pure move; no behaviour change.

## Acceptance
- `dashboard.ts` no longer contains the menu-building functions; it imports them.
- Kebab menu still opens, edit-toggle / refresh / add-widget submenu all work, and closing on outside-click + on unmount still works.
- `pnpm tsc --noEmit` green.
