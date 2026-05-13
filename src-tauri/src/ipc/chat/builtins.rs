//! Built-in slash command IPC handlers. Currently just `clear_session`
//! (used by the frontend's `/clear` built-in handler).

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::ipc::chat::ChatState;
use crate::state::AppState;
use crate::types::EndReason;

#[tauri::command]
pub async fn clear_session(
    app: AppHandle,
    session_id: String,
    state: State<'_, AppState>,
    chat_state: State<'_, Arc<ChatState>>,
) -> Result<(), String> {
    // Best-effort kill any in-flight turn. If no turn is running this is a no-op.
    if let Some(slot) = chat_state.slot(&session_id) {
        let pid = slot.lock().unwrap().take();
        if let Some(pid) = pid {
            let _ = crate::channels::kill::kill_tree(pid);
        }
    }

    // Mark the session ended in the registry so it disappears from the active list.
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    state.instances.mark_ended(&session_id, EndReason::Manual, &now);
    // Drop the ended session from the on-disk snapshot too, so it doesn't
    // reappear in the sidebar after the next app restart.
    crate::sessions::persistence::save_snapshot_default(&state.instances);

    let _ = app.emit("instances-changed", state.instances.list());
    Ok(())
}
