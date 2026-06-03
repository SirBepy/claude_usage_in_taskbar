//! Built-in slash command IPC handlers. Currently just `clear_session`
//! (used by the frontend's `/clear` built-in handler).

use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn clear_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
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

    let guard = state.daemon_client.lock().await;
    if let Some(client) = guard.as_ref() {
        let _ = client.mark_session_ended(&session_id).await;
        // Re-seed the instance cache directly rather than waiting for the
        // `instances_changed` notification: that broadcast is lossy (can be
        // dropped under pipe backpressure), and if the frame carrying this
        // session's `ended_at` is dropped, `cached_instances` stays stale and
        // the closed chat reappears in the sidebar on the next window reopen.
        // Same direct-sync pattern register_historical uses for the inverse race.
        if let Ok(instances) = client.list_instances().await {
            if let Ok(parsed) = serde_json::from_value::<Vec<crate::types::Instance>>(instances) {
                *state.cached_instances.lock().unwrap() = parsed;
            }
        }
    }
    Ok(())
}
