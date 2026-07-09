# Live-verify the overlay whole-window idle-dim feature

**Type:** task

## Goal

Bring the app up via `/supervised-run` and visually confirm the new whole-overlay-window idle-dim behavior (committed `bfbf7d0b`, 2026-07-09) looks and feels right - it was implemented and typechecked but never seen running, since a rebuild at the time would have bounced a live chat session Joe was using for a different task (ai_todo 91 investigation).

## Context

Ported from the sibling app `pomodoro-overlay`'s hover-dim mechanism per Joe's request: the whole floating-overlay window's content (text/icons included) now dims to the persisted `overlayOpacity` value (Settings -> Visuals slider, 0-100%, default 72%) when the mouse is not over the window, and pops to fully opaque on `mouseenter`. This is layered ON TOP of the pre-existing per-card `.oc-row` hover-reveal (background box only) - both effects coexist, per Joe's explicit choice among 3 scope options and his choice to reuse the existing slider rather than add a second one.

Files touched: `src/views/overlay/overlay.ts` (mouseenter/mouseleave listeners on `document.body`, `applyBodyOpacity()` helper, wired into the existing `settings-changed` refresh path), `src/views/settings/subviews/visuals/visuals.ts` (tooltip text updated to describe both effects).

## Approach

1. `/supervised-run` the app (check project memory for run mechanics - env file, ports - before starting).
2. Open the floating overlay window, move the mouse in and out of it, confirm: content dims smoothly to roughly the configured opacity level when idle, pops fully opaque on hover, and the existing per-card background reveal still works underneath/alongside it.
3. Change the `overlayOpacity` slider in Settings -> Visuals while the overlay is open and mouse is outside it; confirm the dim level updates live without needing to re-hover.
4. Screenshot per the UI-change convention (`.for_bepy/screenshots/`, disposable) and share with Joe.

## Acceptance

- Whole-window dim visually matches the configured `overlayOpacity` %, not just the per-card effect.
- No regression to drag, click-to-dashboard, or the existing per-card hover-reveal.
- Live settings-slider changes apply without an overlay restart.
