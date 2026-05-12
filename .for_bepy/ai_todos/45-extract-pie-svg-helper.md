# Extract shared renderPieSvg helper

## Goal
Collapse the two near-identical pie-slice SVG builders into one shared helper.

## Context
- `src/views/statistics/skill-usage-widget.ts` has `renderPie(rows)` (around lines 122-149): builds a 200×200 SVG with center (100,100), radius 80, iterates rows, computes slice angles, emits `<path>` strings, returns a `TemplateResult` wrapping a real DOM `<svg>`.
- `src/views/skill-detail/skill-detail.ts` has `sourcePie(d)` (around lines 107-135): builds a 120×120 SVG with center (60,60), radius 50, otherwise identical math.

The only differences are the viewBox / radius / center and the row shape (`{ label, tokens }` vs `{ label, n }`). Both filter zero-value rows and skip rendering when total is 0.

## Approach
1. Create `src/shared/pie.ts` exporting:

```ts
export interface PieSlice { label: string; value: number; color: string }
export function renderPieSvg(slices: PieSlice[], opts?: { size?: number; radius?: number }): HTMLElement | null
```

The helper returns a DOM `<svg>` element (or null when total is 0), pre-stroked at #0a0a0a / 1.5px. `size` defaults to 200, `radius` defaults to `size * 0.4`. Center is `(size/2, size/2)`.

2. In `skill-usage-widget.ts`, replace `renderPie(rows)` with a thin wrapper that maps `{ label, tokens, color }` → `{ label, value: tokens, color }` and calls `renderPieSvg(slices, { size: 200, radius: 80 })`. Keep the legend rendering separate (the legend is widget-specific, not pie-specific).

3. In `skill-detail.ts`, replace `sourcePie(d)` body the same way with `{ size: 120, radius: 50 }`. The filter-by-n>0 step stays in the caller.

4. Delete the original inline slice math from both view files.

5. Run `npx tsc --noEmit -p tsconfig.json` and visually confirm both pies still render in dev (`cargo tauri dev`).

## Acceptance
`grep -n "Math.cos(start)" src/views` returns one hit (inside `shared/pie.ts`), not two. Both view files visibly render the same shapes as before.
