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
    let old_device = {
        let mut s = state.settings.lock().unwrap();
        let old = s.audio_output_device.clone();
        *s = updated.clone();
        old
    };
    if old_device != updated.audio_output_device {
        state.audio_stream.reinit(updated.audio_output_device.as_deref());
    }
    let _ = app.emit("settings-changed", updated);
    Ok(())
}
