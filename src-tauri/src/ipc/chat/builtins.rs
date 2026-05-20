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

    // For external sessions (the user's own `claude` terminal), kill the
    // claude process tree by its registered pid so closing the chat row
    // actually terminates the underlying CLI. Interactive sessions are
    // handled by the per-turn kill above; only external needs this step.
    let cached = state
        .cached_instances
        .lock()
        .unwrap()
        .iter()
        .find(|i| i.session_id == session_id)
        .cloned();
    if let Some(inst) = cached {
        if inst.kind == crate::sessions::kinds::InstanceKind::External && inst.pid != 0 {
            let _ = crate::channels::kill::kill_tree(inst.pid);
        }
    }

    // TODO(Phase 5): forward mark_ended + snapshot save to daemon via RPC.
    // For now we emit the event so the UI removes the row optimistically;
    // the next instances_changed from the daemon will reconcile.
    let _ = EndReason::Manual;
    let _ = app.emit(
        "instances-changed",
        state.cached_instances.lock().unwrap().clone(),
    );
    Ok(())
}
