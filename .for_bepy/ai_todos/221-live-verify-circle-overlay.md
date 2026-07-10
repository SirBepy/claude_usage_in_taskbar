# Live-verify the circle-dial usage overlay redesign

**Type:** task

## Goal

Eyes-on verification of the redesigned tray usage overlay (per-account circle dials, shipped by the autopilot run on 2026-07-11, commits `d1d7ac43` + `dfd2875f` on master). Logic-verified only so far (tsc + full vitest 624 tests + cargo build green); the actual native overlay window was never launched, because a dev instance risks bouncing Joe's live daemon/chats and the WebdriverIO/e2e path can't drive a native Tauri window from Claude's tool context (see memory `e2e-devtoolsactiveport-launch-fail`).

## Context

The overlay now renders one dial per account: dimmed account icon centered, OUTER thick ring = 5h window, INNER thin ring = 7d window. Ring colour = the app's safe-pace colour (`getPaceColor` via `valueColor(..., "overlay")`), with layered arcs: under pace = solid current + faded (opacity .3) ghost to the safe mark; over pace = darker (`color-mix ... 52%, #08060c`) up to safe + bright overshoot; equal = one solid bar. Hover a dial => a panel appears ON TOP of it (name + `5h`/`7d` rows as `current% / safe%`); hover a % row => session tooltip (`5h session` / time-left / `resets <clock>`). Design source of truth: `.for_bepy/overlay-circle-mockup.html`.

Two things need special attention (both are why this can't be self-verified):

1. **Hover-grow window resize.** The window is now tight to the dial row (`#ocPanel { width: fit-content }`, `resizeOverlayToContent` measures real width+height). Because a tight native window would clip the on-top popup, `attachOverlayHoverResize()` (in `overlay-drag.ts`) GROWS the window on hover to fit the popup+tooltip, then shrinks back on hover-out. Confirm this doesn't feel janky/flickery and that the shrink-back is reliable (no stuck-large window).
2. **Screen-edge clipping (known limitation).** Hover-grow extends the window right/down keeping top-left fixed; it does NOT flip its anchor away from the nearest monitor edge. For the common right-docked position, a hover near the screen's right edge can push part of the popup past the monitor edge. If Joe hits this, the fix is `currentMonitor()`-aware anchor-flipping (same technique the flick-to-corner drag already uses) - spin that into its own ai_todo.

Also confirm the overlay still respects the transparent-window darkening/theme rules (memory `overlay-opacity-darkens`, `overlay-ignores-theme-fixed`) - no black backing, theme applied on refresh.

## Approach

1. With Joe's go-ahead (relaunch bounces daemon/chats), run the installed build or `cargo tauri dev`.
2. Open the overlay; eyeball: dials tight (no oversized container), rings differentiated (outer 5h thick / inner 7d thin), colours match pace state, over-pace ring shows darker-up-to-safe + bright overshoot.
3. Hover each dial: panel lands centered on the dial, window grows to fit, tooltip on a % row reads right, window shrinks back cleanly on hover-out.
4. Multi-account: confirm the row widens with more accounts and stays tight.
5. Burst-capture per the transient-visual-verify rule; keepers to `.for_bepy/screenshots/`.

## Acceptance

- Overlay container hugs the dial row (visibly smaller than the old ~320px stacked-bar card).
- Ring colours + layered safe-pace arcs match the mockup; icons disambiguate accounts.
- Hover popup + tooltip render fully (not clipped) and the window shrinks back afterward.
- No black backing / theme regression; no console errors.
