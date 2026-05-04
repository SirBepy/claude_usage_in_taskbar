//! IPC commands for character listing, assignment, asset URLs, and folder ops.

use crate::characters::{self, Character};
use crate::characters::slots::Slot;
use crate::state::AppState;
use crate::settings::{self, paths};
use crate::types::Avatar;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub fn list_characters() -> Vec<Character> {
    characters::list()
}

#[tauri::command]
pub fn assign_character(
    project_id: String,
    character_id: Option<String>,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let snapshot = {
        let mut s = state.settings.lock().unwrap();
        let Some(p) = s.projects.iter_mut().find(|p| p.id == project_id) else {
            return Err(format!("project not found: {project_id}"));
        };
        p.avatar = match character_id {
            Some(id) if !id.is_empty() => Avatar::Character(id),
            _ => Avatar::None,
        };
        s.clone()
    };
    if let Ok(path) = paths::settings_file() {
        let _ = settings::save(&path, &snapshot);
    }
    let _ = app.emit("settings-changed", &snapshot);
    Ok(())
}

#[tauri::command]
pub fn play_character_slot(
    character_id: String,
    slot: Slot,
    app: AppHandle,
) -> Result<(), String> {
    let Some(c) = characters::get(&character_id) else {
        return Err(format!("unknown character: {character_id}"));
    };
    let files = c.slot_files(slot);
    let Some(pick) = characters::slots::random_pick(files) else {
        return Err("slot has no files".into());
    };
    let path = c.asset_path(pick);
    crate::notifications::audio::play_path(&app, &path);
    Ok(())
}

#[tauri::command]
pub fn character_asset_url(character_id: String, file: String) -> Option<String> {
    let c = characters::get(&character_id)?;
    characters::assets::file_data_url_at(&c.asset_path(&file))
}

#[tauri::command]
pub fn preview_character_file(
    character_id: String,
    file: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let Some(c) = characters::get(&character_id) else {
        return Err(format!("unknown character: {character_id}"));
    };
    let path = c.asset_path(&file);
    if !path.exists() {
        return Err(format!("asset not found: {file}"));
    }
    state.preview.play(path, app);
    Ok(())
}

#[tauri::command]
pub fn stop_character_preview(state: State<AppState>) {
    state.preview.stop();
}

#[tauri::command]
pub fn get_characters_dir() -> Result<String, String> {
    paths::characters_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}
