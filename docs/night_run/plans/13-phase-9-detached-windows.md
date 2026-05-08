# Phase 9 - Detachable session windows

## Context

Implements Tasks 9.1 + 9.2 of `docs/superpowers/plans/2026-05-07-claude-chat-hub.md`. Read "PHASE 9 - Detached windows" in the parent plan.

A session can pop out into its own Tauri window. Closing the window doesn't kill the session - it just hides the dedicated window; the row remains in the main sidebar.

## Goal

- Add `detach_window` and `reattach_window` IPC commands.
- Frontend: detect `#detached?session=<id>` URL hash on app startup; if present, render only the chat pane bound to that session (no sidebar).

## Implementation

Backend (`src-tauri/src/ipc/chat.rs`):

```rust
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
pub async fn detach_window(session_id: String, app: tauri::AppHandle) -> Result<(), String> {
    let label = format!("session-{}", session_id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }
    let url = format!("index.html#detached?session={}", session_id);
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App(url.into()))
        .title(format!("Session {}", &session_id[..session_id.len().min(8)]))
        .inner_size(800.0, 600.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn reattach_window(session_id: String, app: tauri::AppHandle) -> Result<(), String> {
    let label = format!("session-{}", session_id);
    if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

Register both in `lib.rs` invoke handler. Add to capabilities/default.json. May need `core:webview:default` and `core:window:default` permission sets - check existing capabilities for the pattern. If the project doesn't currently allow webview window creation, this may require a new permission group.

Frontend (`src/dashboard.js`):

Near the top of the app-init code:

```js
const hash = window.location.hash || '';
if (hash.startsWith('#detached')) {
  const params = new URLSearchParams(hash.slice('#detached?'.length));
  const sessionId = params.get('session');
  if (sessionId) {
    document.body.classList.add('detached-mode');
    bootstrapDetached(sessionId);
    return; // skip normal app init
  }
}
```

Define `bootstrapDetached`:

```js
async function bootstrapDetached(sessionId) {
  const root = document.getElementById('view-sessions');
  if (!root) return;
  // Hide the main sidebar - we only want the session pane.
  const sidebar = root.querySelector('.sessions-sidebar');
  if (sidebar) sidebar.hidden = true;
  // Hide the burger button so the user can't open the menu in a detached window.
  const burger = root.querySelector('[data-burger]');
  if (burger) burger.hidden = true;
  // Show the view.
  root.hidden = false;
  // Reuse the sessions-view module to render the session pane.
  const m = await import('./modules/sessions-view.js');
  if (typeof m.selectSessionDetached === 'function') {
    const pane = document.getElementById('session-pane');
    await m.selectSessionDetached(sessionId, pane);
  } else {
    // Fallback: call activate then programmatically click the row.
    await m.activate();
    setTimeout(() => {
      const li = document.querySelector(`#sessions-list li[data-session-id="${sessionId}"]`);
      if (li) li.click();
    }, 50);
  }
}
```

Optional: in `sessions-view.js`, export a `selectSessionDetached(sessionId, pane)` helper that mirrors `selectSession` but skips the sidebar wiring. Recommended for cleanliness; otherwise the fallback works.

CSS for detached mode:
```css
body.detached-mode .sessions-sidebar { display: none; }
body.detached-mode #view-sessions header.view-header { display: none; }
```

Wire the detach button in `sessions-view.js` `selectSession` (already references `detach-btn` from Phase 5c):
```js
pane.querySelector('.detach-btn').addEventListener('click', async () => {
  await invoke('detach_window', { sessionId });
});
```

## Gotchas

- Tauri 2 webview window labels can't contain certain characters. Session UUIDs use hyphens which are safe.
- `WebviewUrl::App(url.into())` accepts a relative URL string. The fragment (`#detached?...`) survives the URL parser.
- A detached window subscribes to `chat:<sessionId>` events same as the main window (Tauri events are app-global, not window-scoped).
- Closing the detached window via the OS X button is fine - the session keeps running. The chat events stop being rendered until the user reattaches (clicks the row in main).
- `app.get_webview_window` on a non-existent label returns None, not Err. Use it for the existence check.

## Don't

- Don't commit.
- Don't kill the session when the detached window closes.
- Don't add complex window-state persistence (size/position) - rely on Tauri's defaults for v1.

## Acceptance

- Both IPC commands registered + permitted.
- Frontend detects `#detached?session=<id>` and renders solo chat pane.
- Reading the changes confirms the existing main window still works.
- 176 lib tests still pass.
- `cargo build` clean.
