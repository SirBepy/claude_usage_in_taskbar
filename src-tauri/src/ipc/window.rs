//! Window and chat-window-opening commands. Extracted from `misc.rs`
//! (ai_todo 101). Owns the `session-chats` window lifecycle plus the
//! dashboard-surfacing and pending-open handoff commands.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

/// Show + focus an already-built main window.
pub fn surface_main(w: &tauri::WebviewWindow) {
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
}

#[tauri::command]
pub fn open_dashboard(app: AppHandle) {
    use tauri::Emitter;
    if let Some(w) = app.get_webview_window("main") {
        surface_main(&w);
        let alive = app
            .try_state::<crate::state::AppState>()
            .map(|s| s.frontend_alive.load(Ordering::SeqCst))
            .unwrap_or(true);
        if alive {
            let _ = w.emit("navigate-to-dashboard", ());
        } else {
            // Webview is still loading; queue for frontend_ready to drain.
            if let Some(state) = app.try_state::<crate::state::AppState>() {
                *state.pending_main_nav.lock().unwrap() = Some("dashboard".into());
            }
        }
    } else {
        // Not built yet (main is lazy - see build_main_window). Build it; the
        // SPA boots to the dashboard view by default, so no nav queue needed.
        let _ = build_main_window(&app, None);
    }
}

/// Surfaces the main dashboard window and tells it to navigate to a specific
/// project's detail page. Called from the chats window's per-chat menu so the
/// user can jump to a project's dashboard view without leaving the chat
/// window's process (it stays open in the background).
#[tauri::command]
pub fn open_dashboard_project(app: AppHandle, cwd: String) {
    use tauri::Emitter;
    if let Some(w) = app.get_webview_window("main") {
        surface_main(&w);
        let alive = app
            .try_state::<crate::state::AppState>()
            .map(|s| s.frontend_alive.load(Ordering::SeqCst))
            .unwrap_or(true);
        if alive {
            let _ = w.emit("navigate-to-project", cwd);
        } else {
            if let Some(state) = app.try_state::<crate::state::AppState>() {
                *state.pending_main_nav.lock().unwrap() = Some(format!("project:{cwd}"));
            }
        }
    } else {
        // Lazy build; queue the project nav for frontend_ready to drain on load.
        let _ = build_main_window(&app, Some(&format!("project:{cwd}")));
    }
}

/// Build the main dashboard window (label `main`) lazily, on first open, rather
/// than eagerly at startup. An eagerly-created window (whether via
/// `tauri.conf.json app.windows` or in `setup()`) is the process's first window
/// and Windows briefly shows + activates it while WebView2 initialises its
/// controller, painting a white "ghost"/flash frame even with `visible(false)`
/// - and that internal show cannot be intercepted (ai_todo 143). Building it
/// on demand, after the desktop has settled, sidesteps the whole problem (the
/// chats window has never had the bug for the same reason). Usage polling does
/// NOT depend on this window: `scheduler::spawn` runs an independent backend
/// poll loop, so the dashboard webview is purely UI.
///
/// Built hidden and shown + focused only after the page finishes loading (via
/// `on_page_load`), so the first open shows the rendered dashboard, never a
/// white webview-boot frame. `nav` queues a navigation (e.g. `"project:<cwd>"`)
/// for `frontend_ready` to drain once the SPA mounts; pass `None` for the
/// default dashboard view.
pub fn build_main_window(app: &AppHandle, nav: Option<&str>) -> Result<(), String> {
    use std::sync::atomic::AtomicBool;
    use tauri::webview::PageLoadEvent;
    if let (Some(nav), Some(state)) = (nav, app.try_state::<crate::state::AppState>()) {
        *state.pending_main_nav.lock().unwrap() = Some(nav.to_string());
    }
    let shown = Arc::new(AtomicBool::new(false));
    let window =
        tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
            .title("Claude Conductor")
            .inner_size(520.0, 720.0)
            // Config used minWidth only (no min height); 200 is a harmless floor
            // well below the 720 default. The builder needs both dimensions.
            .min_inner_size(360.0, 200.0)
            .resizable(true)
            .decorations(true)
            .visible(false)
            .on_page_load(move |w, payload| {
                if payload.event() == PageLoadEvent::Finished && !shown.swap(true, Ordering::SeqCst)
                {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            })
            .build()
            .map_err(|e| e.to_string())?;
    // Hide-to-tray on close instead of destroying, mirroring the chats window.
    // A destroyed window means every reopen is a cold webview boot; a hidden one
    // reopens instantly. Real quit (tray menu) sets should_quit and passes.
    {
        let w = window.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let quitting = w
                    .app_handle()
                    .try_state::<crate::state::AppState>()
                    .map(|s| s.should_quit.load(Ordering::SeqCst))
                    .unwrap_or(false);
                if quitting {
                    return;
                }
                api.prevent_close();
                let _ = w.hide();
            }
        });
    }
    Ok(())
}

/// Build the chats window (label `session-chats`). Built hidden so
/// tauri-plugin-window-state can restore the saved size + position before the
/// window is ever painted. Without this the window flashes briefly at the
/// inner_size default in the OS-default spot, then jumps to its remembered
/// geometry. Shown + focused only after the page finishes loading (via
/// `on_page_load`) to avoid the white flash while WebView2 initialises.
fn build_chats_window(app: &AppHandle) -> Result<(), String> {
    use std::sync::atomic::AtomicBool;
    use tauri::webview::PageLoadEvent;
    let shown = Arc::new(AtomicBool::new(false));
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "session-chats",
        tauri::WebviewUrl::App("index.html?chatswindow=1#sessions".into()),
    )
    .title("Claude Chats")
    .inner_size(1280.0, 860.0)
    .min_inner_size(600.0, 400.0)
    .resizable(true)
    .visible(false)
    .on_page_load(move |w, payload| {
        if payload.event() == PageLoadEvent::Finished && !shown.swap(true, Ordering::SeqCst) {
            let _ = w.show();
            let _ = w.set_focus();
        }
    })
    .build()
    .map_err(|e| e.to_string())?;
    // Hide on close instead of destroying, mirroring the main window's
    // hide-to-tray. A destroyed window means every reopen is a cold webview
    // boot ("Setting up..." each time); a hidden one reopens instantly with
    // its state intact. Real quit (tray menu) sets should_quit and passes.
    {
        let w = window.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let quitting = w
                    .app_handle()
                    .try_state::<crate::state::AppState>()
                    .map(|s| s.should_quit.load(Ordering::SeqCst))
                    .unwrap_or(false);
                if quitting {
                    return;
                }
                api.prevent_close();
                let _ = w.hide();
            }
        });
    }
    Ok(())
}

#[tauri::command]
pub fn open_chats_window(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("session-chats") {
        let _ = existing.show();
        let _ = existing.unminimize();
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    build_chats_window(&app)
}

/// Open (or focus) the chats window and tell it to surface a specific session.
/// `mode` is "live" (select the running session) or "history" (open it
/// read-only in the History view). When the window already exists we emit
/// `chats-open-session` for its live listener; when it must be created fresh we
/// stash the request in `AppState.pending_chat_open` for the window to drain on
/// boot (the freshly-built webview can't reliably catch an event emitted before
/// its listener mounts).
#[tauri::command]
pub fn open_chats_for_session(app: AppHandle, session_id: String, mode: String) -> Result<(), String> {
    use tauri::Emitter;
    if let Some(existing) = app.get_webview_window("session-chats") {
        let _ = existing.show();
        let _ = existing.unminimize();
        existing.set_focus().map_err(|e| e.to_string())?;
        let _ = app.emit(
            "chats-open-session",
            serde_json::json!({ "sessionId": session_id, "mode": mode }),
        );
        return Ok(());
    }
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        if let Ok(mut pending) = state.pending_chat_open.lock() {
            *pending = Some((session_id, mode));
        }
    }
    build_chats_window(&app)
}

/// Drain the pending "open this session" request (set by `open_chats_for_session`
/// when it creates the window). Returns `(session_id, mode)` or null.
#[tauri::command]
pub fn take_pending_chat_open(app: AppHandle) -> Option<(String, String)> {
    let state = app.try_state::<crate::state::AppState>()?;
    let mut pending = state.pending_chat_open.lock().ok()?;
    pending.take()
}

/// Open (or focus) the chats window and tell it to start a new chat for a
/// project with the given model/effort. When the window already exists we emit
/// `chats-new-chat` for its live listener; when it must be created fresh we
/// stash the request in `AppState.pending_new_chat` for the window to drain on
/// boot.
#[tauri::command]
pub fn open_chats_new_chat(
    app: AppHandle,
    project_path: String,
    project_name: String,
    model: String,
    effort: String,
) -> Result<(), String> {
    use tauri::Emitter;
    if let Some(existing) = app.get_webview_window("session-chats") {
        let _ = existing.show();
        let _ = existing.unminimize();
        existing.set_focus().map_err(|e| e.to_string())?;
        let _ = app.emit(
            "chats-new-chat",
            serde_json::json!({
                "projectPath": project_path,
                "projectName": project_name,
                "model": model,
                "effort": effort,
            }),
        );
        return Ok(());
    }
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        if let Ok(mut pending) = state.pending_new_chat.lock() {
            *pending = Some((project_path, project_name, model, effort));
        }
    }
    build_chats_window(&app)
}

/// Drain the pending "start a new chat" request (set by `open_chats_new_chat`
/// when it creates the window). Returns `(project_path, project_name, model, effort)` or null.
#[tauri::command]
pub fn take_pending_new_chat(app: AppHandle) -> Option<(String, String, String, String)> {
    let state = app.try_state::<crate::state::AppState>()?;
    let mut pending = state.pending_new_chat.lock().ok()?;
    pending.take()
}
