use crate::state::AppState;
use crate::types::Settings;
use crate::settings::{self, paths};
use tauri::{AppHandle, Emitter, State};

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
