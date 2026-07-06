# Milestone 06 - Tray content modes + floating multi-account overlay

Depends on: 03 (per-account usage). See `00-overview.md`.

## Goal
Let the tray icon be a glyph, a number, or nothing (plain logo) for a chosen account, and add a
translucent floating overlay listing every account's usage.

## Context
- `defaultDisplay` (icon/session/weekly) + `iconStyle` (rings/bars/fourbars) drive the icon face.
- `tray/menu.rs::render_tray_now` (`:208-251`) reads the single `AppState.current_usage`;
  `on_left_click` (`:186-206`) checks one global `auth_state`.
- `tray/threshold.rs` `IconSettings`/`TooltipSettings` consume the pace/colour config (the Rust twin
  of `formatters.ts`).

## Approach
1. Tray content mode setting: `glyph | number | nothing`, plus `tray_account_id` (default =
   `defaultAccountId`) and, for number, a window (default 5h). `glyph` = existing rings/bars render
   of that account; `number` = a % badge; `nothing` = plain Conductor logo. The icon stays
   clickable in ALL modes.
2. `render_tray_now` reads the per-account usage map (03) for `tray_account_id`. Tooltip goes
   per-account (multi-row, reuse `tooltipLayout`), safe pace per account.
3. Left-click toggles the new overlay (replaces "open dashboard"); keep right-click menu.
4. New overlay: a small always-on-top window/panel listing all accounts (5h + 7d, `usage%/safepace%`,
   safe-pace tick), translucent (`overlayOpacity` setting) and opaque on hover. Reuse the number
   format + colour logic. Mirror `open_chats_window` for its window (`ipc/window.rs` +
   `capabilities/default.json`, label `overlay`/`session-*` prefix).

## Files
- `src-tauri/src/tray/menu.rs`, `tray/threshold.rs`, `tray/icon_render.rs`
- new overlay window (`ipc/window.rs`, `capabilities/default.json`), frontend overlay view
- settings: tray content mode, tray account, `overlayOpacity`

## Acceptance
- Tray honours glyph/number/nothing for the chosen account and still opens the overlay.
- Overlay lists all accounts with safe pace for both windows; translucent + opaque on hover;
  opacity slider works.
