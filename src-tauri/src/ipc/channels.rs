use crate::state::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn spawn_channel(project_id: String, app: AppHandle) -> Result<(), String> {
    crate::channels::start_channel(app, project_id).await
}

#[tauri::command]
pub fn stop_channel(project_id: String, app: AppHandle) -> Result<(), String> {
    crate::channels::stop_channel(&app, &project_id)
}

#[tauri::command]
pub async fn restart_channel(project_id: String, app: AppHandle) -> Result<(), String> {
    crate::channels::restart_channel(app, project_id).await
}

#[tauri::command]
pub fn show_terminal(project_id: String, state: State<AppState>) -> Result<(), String> {
    let snap = state.channels.snapshot(&project_id)
        .ok_or("no channel for that project")?;
    let hwnd = snap.hwnd.ok_or("console not resolved yet")?;
    crate::channels::show_hwnd(hwnd);
    Ok(())
}

#[tauri::command]
pub fn hide_terminal(project_id: String, state: State<AppState>) -> Result<(), String> {
    let snap = state.channels.snapshot(&project_id)
        .ok_or("no channel for that project")?;
    let hwnd = snap.hwnd.ok_or("console not resolved yet")?;
    crate::channels::hide_hwnd(hwnd);
    Ok(())
}

#[tauri::command]
pub fn list_channels(state: State<AppState>) -> Vec<serde_json::Value> {
    state.channels.list().iter().map(crate::channels::channel_snapshot_to_json).collect()
}
