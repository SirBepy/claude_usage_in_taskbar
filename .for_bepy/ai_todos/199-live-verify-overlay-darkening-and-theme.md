# Live-verify overlay: no more darkening + follows the user's theme

**Type:** task

## Goal

Visually confirm two overlay fixes from the 2026-07-09 session that were typechecked but never seen running (a rebuild would have bounced a live chat, so verification was deferred):

1. **No idle darkening** (commit 7187b402): off-hover the overlay reads straight through to the desktop instead of turning into a dark block.
2. **Theme follows settings** (commit 383a0255): the overlay uses the user's chosen theme/mode, not the old static void/dark.

## Context

The idle-dim (`document.body.style.opacity`) was removed because opacity on a transparent WebView2 window's body forces a black compositing backing = darkening, not transparency (see memory project_overlay_opacity_darkens). Transparency is now purely the per-card `.oc-row` hover reveal. Separately, `applyOverlayTheme` was added to `overlay.ts::refresh()` so the overlay picks up the theme (it skips initBoot).

## Approach

1. `/supervised-run` the app (check project memory for run mechanics - env file, ports - first).
2. Toggle the overlay open via the tray. With the mouse OUTSIDE the window, confirm it is see-through (desktop visible behind), NOT a dark box.
3. Hover a card: its background should reveal cleanly (opacity per the Overlay Opacity slider), not read as "darker glass".
4. Switch theme/mode in Settings -> Visuals while the overlay is open; confirm the overlay's colors update live (or at worst on next open).
5. Confirm drag, flick-to-corner, and click-to-dashboard still work.
6. Screenshot to `.for_bepy/screenshots/` (disposable) and share with Joe.

## Acceptance

- Off-hover overlay is transparent to the desktop, never a dark block.
- Hovered card reveals at the configured opacity with no black backing.
- Overlay matches the selected theme; live theme switch propagates.
- No regression to drag / flick-snap / click-to-dashboard.
