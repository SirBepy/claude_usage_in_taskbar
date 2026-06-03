//! Per-turn chat execution (daemon-backed).
//!
//! - `start_session`: first turn. Spawns the session in the daemon via RPC,
//!   bridges its events to `chat:<real_id>`, and hands the real id to the
//!   frontend via a synthetic `SessionStarted` on the placeholder channel.
//! - `send_message`: subsequent turns on an existing daemon session.
//! - `cancel_turn`: cancels the in-flight turn via daemon RPC.
//!
//! Mutations to the Registry also emit `instances-changed` (per existing
//! convention, the IPC layer fires it after the registry call).

use crate::state::AppState;
use crate::types::chat::{ChatEvent, ContentBlock};
use chrono::Utc;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn start_session(
    cwd: String,
    prompt: String,
    model: String,
    effort: String,
    placeholder_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    start_session_daemon(cwd, prompt, model, effort, placeholder_id, &state, &app).await
}

/// Daemon-backed new session: spawn via RPC, bridge events, hand the real id
/// to the frontend via a synthetic SessionStarted on the placeholder channel.
async fn start_session_daemon(
    cwd: String,
    prompt: String,
    model: String,
    effort: String,
    placeholder_id: Option<String>,
    state: &State<'_, AppState>,
    app: &AppHandle,
) -> Result<String, String> {
    let real_id = {
        let guard = state.daemon_client.lock().await;
        let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
        client.start_session(&cwd, &model, &effort, None).await.map_err(|e| e.to_string())?
    };

    // Bridge daemon chat_event -> chat:<real_id> BEFORE sending the prompt so
    // no turn events are missed.
    super::daemon_bridge::ensure_attached(app, &real_id).await?;

    // Hand the real id to the frontend: emit a synthetic SessionStarted on the
    // placeholder channel the frontend is listening on. The frontend swaps its
    // renderer subscription to chat:<real_id>, matching Path C.
    if let Some(ph) = placeholder_id.as_deref() {
        let synthetic = ChatEvent::SessionStarted {
            session_id: real_id.clone(),
            model: model.clone(),
            cwd: cwd.clone(),
            timestamp: Utc::now().timestamp_millis(),
        };
        let _ = app.emit(&format!("chat:{}", ph), &synthetic);
    }

    // Send the first turn's prompt. Events flow over the attached bridge.
    {
        let guard = state.daemon_client.lock().await;
        let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
        client.send_message(&real_id, &prompt).await.map_err(|e| e.to_string())?;
    }

    Ok(real_id)
}

#[tauri::command]
pub async fn send_message(
    session_id: String,
    cwd: String,
    blocks: Vec<ContentBlock>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let prompt = blocks_to_prompt_text(&blocks);
    let (model, effort) = {
        let inst = state
            .cached_instances
            .lock()
            .unwrap()
            .iter()
            .find(|i| i.session_id == session_id)
            .cloned();
        match inst {
            Some(i) if !i.model.is_empty() && !i.effort.is_empty() => (i.model.clone(), i.effort.clone()),
            _ => ("opus".to_string(), "high".to_string()),
        }
    };

    send_message_daemon(&session_id, &cwd, &prompt, &model, &effort, &state, &app).await
}

/// Daemon-backed turn on an existing session. If the daemon no longer holds the
/// session, respawn with resume_id and retry once.
async fn send_message_daemon(
    session_id: &str,
    cwd: &str,
    prompt: &str,
    model: &str,
    effort: &str,
    state: &State<'_, AppState>,
    app: &AppHandle,
) -> Result<String, String> {
    super::daemon_bridge::ensure_attached(app, session_id).await.ok();

    // First attempt.
    let first = {
        let guard = state.daemon_client.lock().await;
        let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
        client.send_message(session_id, prompt).await
    };

    match first {
        Ok(()) => Ok(session_id.to_string()),
        Err(crate::daemon_client::ClientError::Rpc { code: -32004, .. }) => {
            // Session not live in the daemon: respawn with resume_id, re-attach, retry.
            {
                let guard = state.daemon_client.lock().await;
                let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
                client
                    .start_session(cwd, model, effort, Some(session_id))
                    .await
                    .map_err(|e| e.to_string())?;
            }
            // Force re-attach: the respawned session has a NEW daemon broadcast
            // channel, so the prior subscription is dead. ensure_attached alone
            // would no-op (id still in attached_sessions).
            super::daemon_bridge::reattach(app, session_id).await?;
            let guard = state.daemon_client.lock().await;
            let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
            client.send_message(session_id, prompt).await.map_err(|e| e.to_string())?;
            Ok(session_id.to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn set_session_effort(
    session_id: String,
    effort: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let valid = ["low", "medium", "high", "xhigh", "max"];
    if !valid.contains(&effort.as_str()) {
        return Err(format!("invalid effort: {effort}"));
    }
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.set_session_effort(&session_id, &effort).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn cancel_turn(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.cancel_turn(&session_id).await.map_err(|e| e.to_string())
}

/// Convert ContentBlocks to the single string `claude -p` accepts as its
/// positional prompt arg. Path C does NOT use stream-json input format
/// (interactive doesn't support it), so we flatten to plain text.
/// Image attachments are surfaced as `<file:path>` mentions in Phase 6;
/// this helper just renders Image blocks as a placeholder if they ever
/// arrive without going through the disk-path conversion in the composer.
pub(crate) fn blocks_to_prompt_text(blocks: &[ContentBlock]) -> String {
    let mut out = String::new();
    for b in blocks {
        match b {
            ContentBlock::Text { text } => out.push_str(text),
            ContentBlock::Image { .. } => {
                out.push_str("<image not yet persisted to disk>");
            }
        }
        out.push('\n');
    }
    out.trim_end().to_string()
}

/// Register a historical (ended) session as an Interactive entry in the
/// registry so the Sessions view can find and display it. Called by the
/// History view "Continue this chat" flow before navigating back to Sessions.
#[tauri::command]
pub async fn register_historical_session(
    session_id: String,
    cwd: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    super::attachments::validate_session_id(&session_id)?;
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.register_historical(&session_id, &cwd).await.map_err(|e| e.to_string())?;
    // Sync the instance cache immediately so the Sessions view's list_instances
    // call sees the new entry before the async instances_changed notification
    // arrives via daemon_link (avoids a race that caused the resume to silently
    // no-op when the cache was still stale on mount).
    if let Ok(instances) = client.list_instances().await {
        if let Ok(parsed) = serde_json::from_value::<Vec<crate::types::Instance>>(instances) {
            *state.cached_instances.lock().unwrap() = parsed;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_to_prompt_text_text_only() {
        let blocks = vec![ContentBlock::Text { text: "hi".into() }];
        assert_eq!(blocks_to_prompt_text(&blocks), "hi");
    }
}
