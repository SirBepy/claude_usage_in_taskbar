# WebView2 renderer crash auto-recovery

## Goal
When the main window's WebView2 renderer crashes (window goes white with no content), automatically detect the failure and reload the page so the user never has to manually open from tray.

## Context
`src-tauri/src/lib.rs` sets up the main window. The existing boot watchdog only covers the first 2 minutes; after that, if the WebView2 renderer crashes (OOM, GPU fault, etc.), `frontend_alive` remains `true` and nothing triggers a reload. The user sees a persistent white "Claude Usage" window. Their current workaround is tray → "Open Dashboard" which re-emits `navigate-to-dashboard` — this only works if the renderer is still alive; a true crash leaves the window white permanently until app restart.

`tauri::WebviewEvent` in Tauri 2.10.3 does NOT include `ProcessFailed` — the enum only has `DragDrop`. There is no post-build hook for process failure in the current Tauri version.

## Approach
Option A — upgrade Tauri and use `ProcessFailed`:
Check if a newer Tauri 2.x version adds `ProcessFailed` to `WebviewEvent`. If yes, register `window.on_webview_event(|e| { if matches!(e, WebviewEvent::ProcessFailed) { navigate(start_url) } })` in `lib.rs` setup.

Option B — JS heartbeat watchdog (no Tauri upgrade needed):
1. Add `pub last_frontend_ping: Arc<Mutex<Option<std::time::Instant>>>` to `AppState`.
2. Add a `frontend_ping` IPC command that updates `last_frontend_ping`.
3. Call `invoke("frontend_ping")` from JS every 10 seconds while the window is visible (`document.addEventListener("visibilitychange", ...)`).
4. In `lib.rs` setup, spawn a background task that checks every 15 seconds: if the window is visible AND `last_frontend_ping` is older than 30 seconds AND `frontend_alive` is true, call `w.navigate(start_url)` + `state.pending_main_nav = Some("dashboard")`.

Option B is the safe choice since it doesn't require a Tauri upgrade.

## Acceptance
- Simulate a renderer crash (or navigate the webview to `about:blank` via Tauri devtools) while the dashboard is visible.
- Within 30 seconds the window should automatically reload and show the dashboard without any user action.
- `cargo build` passes; no new clippy warnings.
