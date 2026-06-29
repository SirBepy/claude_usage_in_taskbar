# 143 - Dashboard shows a white "ghost" window on startup

## Symptom
On app start (reproduces in BOTH `cargo tauri dev` via supervised-run AND a
release build), a white `Claude Conductor` window appears. It:
- has NO taskbar icon (a real dashboard open via tray DOES get one),
- shows on ALL virtual desktops,
- is frozen / uninteractable (right-click falls through to the desktop; F12/devtools impossible),
- is "fixed" by tray > Open Dashboard, which shows the real, rendered window.

## Confirmed diagnosis (verified by screen-pixel capture, not window APIs)
- The Tauri main window reports `is_visible() == false` AND Win32 `IsWindowVisible`/`WS_VISIBLE`
  is clear for it, yet a white window is painted on screen. It's a **stale/ghost frame**:
  the window (or its WebView2 host) is composited once while the webview is still
  showing its white default background (before first content paint), then logically
  hidden — but the white frame lingers (no taskbar entry, all-desktops = orphaned webview frame).
- The DOM actually renders fine: instrumentation showed `navigateTo 'dashboard' render OK;
  root.childCount=1`. So content exists; it's a paint/compositing/show-timing problem, not a render or JS error.
- `Focused(true)` window events DO fire at startup, so something shows/focuses the window
  despite `visible: false` in tauri.conf.json. The exact shower was not pinned down
  (not open_dashboard - that's only logged on the user's tray click; no window-state file
  exists for the new identifier `com.sirbepy.claudeconductor`).
- The **chats window does NOT have this bug** because it's built on-demand in code with a
  `visible(false)` + `on_page_load(Finished) -> show()` gate (see `build_chats_window` in
  `src-tauri/src/ipc/window.rs`). Showing only after the page paints avoids the white frame.

## Hard constraint on the fix
The main window CANNOT simply be made on-demand like the chats window: usage scraping is
**frontend-driven** - `src/views/dashboard/dashboard.ts:100-101` runs `maybeAutoPoll` on a
60s `setInterval` -> `invoke("poll_now")` (CDP scrape). If the main window/webview doesn't
exist at startup, tray usage stops updating until the dashboard is opened. So the window
MUST be created at startup and its webview kept alive - just never shown until tray > Open Dashboard.

## Approaches tried that did NOT fix it
- Disable WebView2 native occlusion (`--disable-features=CalculateNativeWinOcclusion` via
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`).
- `window.hide()` in `.setup()` + repeated delayed `hide()` at 150ms..5s. (APIs think it's
  already hidden, so hide is a no-op / can't target the ghost frame.)
- The boot render-gate `.catch` fix (commit 2dab1f1) - that was a real latent bug but a
  different one.

## Proposed fix (needs implementation + screenshot verification)
Build the main window in code (mirroring `build_chats_window`) instead of via
`tauri.conf.json` `app.windows`, so its show lifecycle is fully controlled:
- create at startup, `visible(false)`, webview loads (keeps polling alive),
- NEVER auto-show (no on_page_load show - unlike chats; main is tray-only),
- `open_dashboard` shows it on demand.
This removes Tauri's auto-created config window (the thing being shown white) while keeping
the webview alive for polling. Requires moving the close-to-tray `on_window_event`, the boot
watchdog, and `frontend_ready`/`open_dashboard` "main" lookups to tolerate code-created timing.
Alternative to investigate first: find exactly what shows the config window at startup
(instrument `on_window_event` Focused + try removing the window-state plugin) - if it's a
single identifiable shower, stopping it is a smaller fix.

## Verification method that works
Window-enumeration APIs LIE here (report the ghost as not-visible). Use actual screen capture:
PowerShell `System.Drawing` `CopyFromScreen` to a PNG, then view it. The supervisor exposes
the dev app's logs at `GET http://127.0.0.1:<api_port>/procs/claude-usage-in-taskbar:cargo-tauri/logs`
(token in `%APPDATA%\com.sirbepy.server-supervisor\supervisor\api_token.txt`), and can
restart it via `POST .../restart` - so the whole fix/verify loop can run without the dev present.
