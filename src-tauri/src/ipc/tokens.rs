use crate::tokens::{self, BackfillResult, TokenRecord};
use crate::settings::paths;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn get_token_history() -> Vec<TokenRecord> {
    let Ok(path) = paths::token_history_file() else { return vec![] };
    tauri::async_runtime::spawn_blocking(move || tokens::load_history(&path))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn get_active_sessions() -> Vec<TokenRecord> {
    let path = match paths::token_history_file() { Ok(p) => p, Err(_) => return vec![] };
    tauri::async_runtime::spawn_blocking(move || tokens::active_sessions(&path))
        .await
        .unwrap_or_default()
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
