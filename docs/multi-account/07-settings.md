# Milestone 07 - Settings: removals, global colour, account management

Depends on: 05, 06 (they introduce the widget layout + overlay/tray settings). See `00-overview.md`.

## Goal
Apply the remove/change/new settings, keep colour config one global preference applied across every
account and the overlay, and add an account-management UI.

## Context
- Settings study lists remove/change/new (see `00-overview.md`).
- `colorApplyTo` = `{icon,number,dashboard,tooltip}` (booleans).
- Pace/colour logic is duplicated and hand-synced: `src/shared/formatters.ts:130-162` (webview) and
  `src-tauri/src/tray/threshold.rs` (tray). Editors in `views/settings/subviews/visuals/visuals.ts`.
- Single "Log Out" button (`settings.ts:198`).

## Approach
1. Remove: `sync` (dead), and after a no-reader confirm `threshold_warn`/`threshold_crit` and
   `display_mode`; `pinnedCards` (replaced by 05's `dashboardWidgets`).
2. Keep global: `colorMode`, `paceBand` (10), `paceColors`, `colorThresholds`. Extend `colorApplyTo`
   with an `overlay` target and ensure both twins apply the colour to the overlay + the per-account
   dashboard cards. Update BOTH `formatters.ts` and `threshold.rs` in lockstep.
3. Account-management settings subview: list accounts (colour/icon/tier), add account (01 flow),
   remove / re-auth one, set default (`defaultAccountId`). Replaces the single Log Out.
4. `overlayOpacity` slider (06) + tray content-mode UI (06) surfaced here.

## Files
- `src-tauri/src/types/notifications.rs` (drop legacy fields)
- `src/shared/formatters.ts` + `src-tauri/src/tray/threshold.rs` (overlay target, apply everywhere)
- `views/settings/subviews/visuals/*`, new accounts subview, `shared/settings-save.ts`

## Acceptance
- Dead/legacy fields gone; build clean, no dangling readers.
- One global colour preference colours every account's numbers, the dashboard, and the overlay
  (both twins in sync).
- Add / remove / re-auth / set-default account all work; overlay opacity + tray mode persist.
