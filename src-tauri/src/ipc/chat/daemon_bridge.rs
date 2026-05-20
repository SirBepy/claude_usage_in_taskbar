//! Bridges daemon per-session `chat_event` notifications onto the app's
//! `chat:<id>` Tauri events (which the frontend renderer already consumes).
//! Daemon chat mode only (Phase 5a). When `experimental.useDaemon` is off,
//! Path C in `run.rs` emits `chat:<id>` directly and this is never used.

use crate::state::AppState;
use crate::types::chat::ChatEvent;
use tauri::{AppHandle, Emitter, Manager};

/// Ensure a pump task is running for `session_id`: attaches to the daemon's
/// per-session stream and re-emits each `chat_event`'s inner ChatEvent onto
/// `chat:<session_id>`. Idempotent - a second call for the same id is a no-op.
/// Returns Err only if the daemon client is unconnected or attach fails.
pub async fn ensure_attached(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut set = state.attached_sessions.lock().unwrap();
        if set.contains(session_id) {
            return Ok(());
        }
        set.insert(session_id.to_string());
    }

    let mut rx = {
        let guard = state.daemon_client.lock().await;
        let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
        match client.attach_session(session_id).await {
            Ok(rx) => rx,
            Err(e) => {
                state.attached_sessions.lock().unwrap().remove(session_id);
                return Err(e.to_string());
            }
        }
    };

    let app = app.clone();
    let sid = session_id.to_string();
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if let Some(ev_val) = frame.pointer("/params/event") {
                if let Ok(ev) = serde_json::from_value::<ChatEvent>(ev_val.clone()) {
                    let _ = app.emit(&format!("chat:{}", sid), &ev);
                }
            }
        }
        let state = app.state::<AppState>();
        state.attached_sessions.lock().unwrap().remove(&sid);
    });

    Ok(())
}
