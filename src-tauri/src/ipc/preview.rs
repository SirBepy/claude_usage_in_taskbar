//! Desktop IPC mirror for the daemon-owned HTML preview store (ai_todo 138).
//! Proxies to the daemon over its RPC/pipe connection (`state.daemon_client`),
//! same pattern as `ipc/schedule.rs` - the daemon is a SEPARATE process from
//! this app's `AppState`, so these commands never touch daemon state directly.

use crate::daemon::preview::{PreviewMeta, PreviewSnapshot};
use crate::state::AppState;
use tauri::State;

/// Push (or, for a repeated `slug`, replace-in-place) an HTML preview
/// snapshot. Mirrors the terminal-Claude curl to `POST /hooks/preview`; this
/// is the in-app-triggered write path (e.g. a `/brainstorm` mockup). Returns
/// the snapshot id.
#[tauri::command]
pub async fn push_preview(
    title: String,
    slug: Option<String>,
    html: String,
    source: Option<String>,
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .push_preview(&title, slug.as_deref(), &html, source.as_deref(), session_id.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Preview history metadata (no html), newest (most-recently-pushed/replaced)
/// first, for the history rail.
#[tauri::command]
pub async fn list_previews(state: State<'_, AppState>) -> Result<Vec<PreviewMeta>, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client.list_previews().await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

/// Full preview snapshot (html included) by id, for the iframe render.
#[tauri::command]
pub async fn get_preview(id: String, state: State<'_, AppState>) -> Result<PreviewSnapshot, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client.get_preview(&id).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}
