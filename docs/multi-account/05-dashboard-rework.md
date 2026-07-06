# Milestone 05 - Dashboard rework (account selector + widget registry, remove Statistics)

Depends on: 03 (per-account usage feeds the cards + scoped widgets). See `00-overview.md`.

## Goal
Turn the dashboard into an account selector plus a set of user-chosen widgets, some global and some
account-scoped; delete the standalone Statistics screen, migrating its widgets in.

## Context
- Dashboard (`views/dashboard/dashboard.ts:224-260`) = two fixed stat-cards + `buildPinnedCardsHTML`.
- `pinnedCards` is a closed 5-id enum (`today`, `session-chart`, `session-bars`, `weekly-chart`,
  `weekly-bars`) borrowed from `statistics.ts` (`:82-112,1067-1092`).
- Statistics widgets (`statistics.ts`): today table (global), session chart+bars, weekly chart+bars
  (account-scoped), skill-usage (`skill-usage-widget.ts`, global). Data via `get_usage_history`,
  token-history, `getSkillUsageWeek`.
- Safe-pace colouring via `valueColor(pct, safePct, settings)` (`formatters.ts:150-162`).

## Approach
1. Account-selector cards: one per account, showing 5h + 7d as `usage%/safepace%` (number format
   from the mockup), safe-pace tick on each bar, current % coloured under/over. Active card =
   border+glow (no checkmark). Clicking a card sets `selectedAccountId`.
2. Widget registry: `Widget { id, title, render(root, ctx), scope: "global"|"account", dataDeps }`.
   Account-scoped widgets take `selectedAccountId` and re-render on selection; global widgets ignore
   it. Migrate: today=global, skill-usage=global, session/weekly chart+bars=account-scoped.
3. Replace `pinnedCards` with a `dashboardWidgets` layout setting (ordered ids + on/off). Quiet
   "add widget" affordance (per mockup).
4. Delete the Statistics view + its route (`router`/`main.ts`); its module-local chart state dies
   with the file. Preserve everything else it read (shared with dashboard/tray).

## Files
- `views/dashboard/*`, remove `views/statistics/*`
- new widget-registry module, `router.ts`/`main.ts` (drop stats route)
- `shared/settings-save.ts` (`dashboardWidgets`), reuse `formatters.ts` `valueColor`

## Acceptance
- Dashboard shows every account; clicking a card re-scopes the account-tied widgets, global widgets
  stay; safe pace shows for 5h + 7d.
- Statistics screen is gone with no widget lost (all reachable on the dashboard).
- Widget layout persists across restart.
