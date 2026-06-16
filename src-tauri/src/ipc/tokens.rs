use crate::state::AppState;
use crate::storage::token_store;
use crate::tokens::{self, BackfillResult, TokenRecord};
use crate::settings::paths;
use tauri::{AppHandle, Emitter, State};

/// Loads the full token history from the consolidated SQLite store (the daemon
/// now writes records there). Filters out empty session ids to match the old
/// JSONL `load_history` behaviour.
fn load_history_from_db(state: &AppState) -> Vec<TokenRecord> {
    let mgr = state.db.lock().unwrap();
    match token_store::get_token_records(mgr.conn(), 0) {
        Ok(records) => records
            .into_iter()
            .filter(|r| !r.session_id.is_empty())
            .collect(),
        Err(e) => {
            log::warn!("get_token_records failed: {e:#}");
            Vec::new()
        }
    }
}

#[tauri::command]
pub async fn get_token_history(state: State<'_, AppState>) -> Result<Vec<TokenRecord>, String> {
    Ok(load_history_from_db(&state))
}

#[tauri::command]
pub async fn get_active_sessions(state: State<'_, AppState>) -> Result<Vec<TokenRecord>, String> {
    let history = load_history_from_db(&state);
    tauri::async_runtime::spawn_blocking(move || tokens::active_sessions_from_history(&history))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn backfill_transcripts(app: AppHandle) -> Result<BackfillResult, String> {
    let path = paths::token_history_file().map_err(|e| e.to_string())?;
    let path2 = path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || tokens::backfill_all(&path2))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    let history = tokens::load_history(&path);
    let _ = app.emit("token-history-updated", history);
    Ok(result)
}
