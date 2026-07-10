# Threshold-crossed notification config is now unsurfaced

**Type:** decision

## Goal

Decide what to do with the `colorThresholds` numeric-breakpoint config now that its editor UI is gone.

## Context

The autopilot run on 2026-07-11 removed Settings > Appearance > Usage Colors > Color Mode (commit `d1d7ac43`), hardcoding safe-pace colouring everywhere. That deletion also removed the `#thresholdSection` UI (the numeric green/amber/red breakpoint rows), because its only purpose in the *colouring* system was the now-gone "threshold" colour mode.

BUT `colorThresholds` is ALSO read by a second, independent feature: the Rust "threshold-crossed" notification (`src-tauri/src/scheduler.rs::maybe_notify_threshold_crossed`, reads `IconSettings.color_thresholds` via `tray/threshold.rs`). That value still round-trips through settings (kept intentionally), so the notification keeps firing on whatever `colorThresholds` value is currently saved / its default - but Joe can no longer edit those breakpoints from the UI.

## Options

1. **Leave as-is** - notification fires at the saved/default breakpoints, not user-editable. Simplest; fine if the defaults are good and nobody needs to tune them.
2. **Re-expose it decoupled** - add a small "Alert thresholds" control (under Notifications, not Appearance) that edits `colorThresholds` purely for the notification, with no coupling to colouring. Cleanest if Joe still wants tunable alerts.
3. **Drop the notification too** - if the threshold-crossed notification isn't wanted, remove `maybe_notify_threshold_crossed` + the `color_thresholds` plumbing entirely and stop persisting the key.

## Recommendation

Option 2 if Joe uses the threshold-crossed notification; Option 1 if he doesn't care to tune it; Option 3 only if the notification itself is dead weight. Needs Joe's call on whether he wants tunable usage alerts at all.
