//! IPC commands exposed to the webview via `invoke()`.

use crate::state::AppState;
use crate::types::{AuthState, Settings, UsageSnapshot};
use crate::{history, paths, session, settings};
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub fn get_current_usage(state: State<AppState>) -> Option<UsageSnapshot> {
    state.current_usage.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_history(limit: Option<u32>) -> Vec<UsageSnapshot> {
    let path = match paths::history_file() { Ok(p) => p, Err(_) => return vec![] };
    let mut all = history::load_all(&path).unwrap_or_default();
    if let Some(n) = limit {
        let start = all.len().saturating_sub(n as usize);
        all = all.split_off(start);
    }
    all
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_settings(updated: Settings, state: State<AppState>, app: AppHandle)
    -> Result<(), String>
{
    let path = paths::settings_file().map_err(|e| e.to_string())?;
    settings::save(&path, &updated).map_err(|e| e.to_string())?;
    *state.settings.lock().unwrap() = updated.clone();
    let _ = app.emit("settings-changed", updated);
    Ok(())
}

#[tauri::command]
pub fn auth_status(state: State<AppState>) -> AuthState {
    *state.auth_state.lock().unwrap()
}

#[tauri::command]
pub fn open_dashboard(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

// Deferred to their own tasks:
//   poll_now     -> Task 9 (scheduler)
//   start_login  -> Task 13 (auth)

/// Convenience: clears the stored session.
#[tauri::command]
pub fn logout(state: State<AppState>, app: AppHandle) -> Result<(), String> {
    let path = paths::session_file().map_err(|e| e.to_string())?;
    session::clear(&path).map_err(|e| e.to_string())?;
    *state.auth_state.lock().unwrap() = AuthState::NeedsLogin;
    let _ = app.emit("auth-progress", serde_json::json!({"stage": "needs-login"}));
    Ok(())
}

#[tauri::command]
pub async fn poll_now(app: AppHandle) -> Result<UsageSnapshot, String> {
    match crate::scheduler::poll_once(&app).await {
        Ok(snap) => {
            let _ = app.emit("usage-updated", snap.clone());
            Ok(snap)
        }
        Err(e) => Err(format!("{e:?}")),
    }
}

#[tauri::command]
pub async fn start_login(app: AppHandle, state: State<'_, AppState>)
    -> Result<(), String>
{
    *state.auth_state.lock().unwrap() = AuthState::InProgress;
    let _ = app.emit("auth-progress", serde_json::json!({"stage": "starting"}));
    match crate::auth::run(app.clone()).await {
        Ok(()) => {
            *state.auth_state.lock().unwrap() = AuthState::LoggedIn;
            // Kick an immediate poll so the dashboard shows data right away.
            let h = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::scheduler::poll_once(&h).await;
            });
            Ok(())
        }
        Err(e) => {
            *state.auth_state.lock().unwrap() = AuthState::NeedsLogin;
            Err(e.to_string())
        }
    }
}
