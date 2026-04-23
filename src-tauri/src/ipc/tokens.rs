use crate::token_stats::{self, BackfillResult, TokenRecord};
use crate::paths;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub fn get_token_history() -> Vec<TokenRecord> {
    let Ok(path) = paths::token_history_file() else { return vec![] };
    token_stats::load_history(&path)
}

#[tauri::command]
pub async fn get_active_sessions() -> Vec<TokenRecord> {
    let path = match paths::token_history_file() { Ok(p) => p, Err(_) => return vec![] };
    tauri::async_runtime::spawn_blocking(move || token_stats::active_sessions(&path))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn backfill_transcripts(app: AppHandle) -> Result<BackfillResult, String> {
    let path = paths::token_history_file().map_err(|e| e.to_string())?;
    let path2 = path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || token_stats::backfill_all(&path2))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    let history = token_stats::load_history(&path);
    let _ = app.emit("token-history-updated", history);
    Ok(result)
}
