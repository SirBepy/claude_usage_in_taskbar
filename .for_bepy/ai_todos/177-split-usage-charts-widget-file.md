# src/views/dashboard/widgets/usage-charts.ts should be split

## Goal
Break the 777-line `src/views/dashboard/widgets/usage-charts.ts` into per-concern modules instead of one file covering chart rendering, bar-view rendering, and the graph detail modal.

## Context
`src/views/dashboard/widgets/usage-charts.ts` visibly interleaves three separate rendering concerns with almost no shared state beyond `UsageRecord[]` and the exported widget objects:

- Line-chart building: `buildWindowProjectsHTML` (usage-charts.ts:56), `buildChart` (usage-charts.ts:132), `applyLineVisibility`/`setupLegendToggles`/`setupPaginationButtons`/`formatHoverLabel`/`setupChartHover` (usage-charts.ts:258-421).
- Bar-view building: `BAR_COLORS`, `buildProjectBarsView` (usage-charts.ts:422-521), `wireBarsMore` (usage-charts.ts:522).
- Graph detail modal: `GraphCardOpts`, `graphDetailConfigs`, `buildGraphCard`, `detailTitle`, `openGraphDetail`, `wireDetailNav` (usage-charts.ts:537-646).
- Window math + widget wiring: `WindowState`, `legendItem`, `sessionWindow`, `weeklyWindow`, `mountUsageWidget`, and the four exported widget objects (`sessionChartWidget`, `sessionBarsWidget`, `weeklyChartWidget`, `weeklyBarsWidget`, usage-charts.ts:647-777).

Each block only needs `UsageRecord[]`/`WindowState` as input, so the split is mechanical, not a design change.

## Approach
Split into:
- `usage-chart-view.ts` - the line-chart building + hover/legend/pagination wiring.
- `usage-bars-view.ts` - the bar view + `wireBarsMore`.
- `usage-chart-detail.ts` - the graph detail modal (`buildGraphCard`, `openGraphDetail`, `wireDetailNav`).
- Keep `usage-charts.ts` as the widget-registration surface: `WindowState`/`sessionWindow`/`weeklyWindow`/`mountUsageWidget` and the four exported `Widget` objects, importing the above.

## Acceptance
- `pnpm tsc --noEmit` passes.
- Each new file is under ~300 lines and covers one concern.
- The four exported widgets (`sessionChartWidget`, `sessionBarsWidget`, `weeklyChartWidget`, `weeklyBarsWidget`) render/behave identically (chart hover, legend toggle, pagination, bar-more, and graph detail modal all still work).
