# Overlay window ignores the user's theme (stuck on void/dark)

**Type:** task

## Goal

The floating usage overlay should follow the user's chosen theme/mode like every other window.

## Context

Pre-existing gap surfaced during the 2026-07-09 overlay entry split (commit cc7bedf4): the overlay never ran `applyThemeFromSettings` - that call lives in `initBoot()` in the old `src/main.ts` path, which the overlay branch always skipped, so the overlay has always rendered with the static `data-theme="void" data-mode="dark"` default from its HTML. The new `src/overlay-main.ts` deliberately preserved that behavior rather than changing it as a drive-by. Theme CSS (tokens + 4 theme palette files) IS already loaded by `overlay.html`.

## Approach

- In `src/overlay-main.ts`, after the one-shot settings fetch, apply the same `data-theme`/`data-mode` attributes `applyThemeFromSettings` sets (import that helper if it is importable without dragging in heavy modules; otherwise replicate its few lines).
- The overlay already listens for `settings-changed` inside `renderOverlay` (src/views/overlay/overlay.ts:131) - re-apply theme attributes there too so live theme switches propagate.

## Acceptance

- Switching theme/mode in Settings updates the overlay live (or at worst on next overlay open).
- Idle-dim (overlayOpacity) and drag behavior unaffected.
- `pnpm exec tsc --noEmit` clean; `pnpm exec vite build` emits overlay chunk with no size blow-up (theme helper must not pull chat/view code into the overlay graph).
