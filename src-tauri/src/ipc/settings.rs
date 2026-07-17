use crate::state::AppState;
use crate::types::Settings;
use crate::settings::{self, paths};
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub async fn save_settings(updated: Settings, state: State<'_, AppState>, app: AppHandle)
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
    // Keep the daemon's in-memory settings cache (used e.g. for
    // default_account_id resolution on session spawn) from going stale for
    // the lifetime of an already-connected session - see push_settings_to_daemon.
    crate::daemon_link::push_settings_to_daemon(&state, &updated).await;
    let _ = app.emit("settings-changed", updated.clone());
    // Sync screen-capture exclusion immediately so toggling the setting
    // mid-meeting takes effect without waiting for the next meeting edge.
    {
        use std::sync::atomic::Ordering;
        let meeting = state.meeting_active.load(Ordering::Relaxed);
        crate::meeting::apply_capture_affinity(meeting && updated.hide_in_meeting());
    }
    Ok(())
}
