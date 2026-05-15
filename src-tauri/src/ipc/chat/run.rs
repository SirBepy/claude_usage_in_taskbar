//! Per-turn chat execution (Path C).
//!
//! - `start_session`: first turn, no `--resume`. Captures the session_id from
//!   the first `SessionStarted` event and registers an Interactive entry.
//! - `send_message`: subsequent turns, with `--resume <session_id>`.
//! - `cancel_turn`: OS-kills the in-flight runner child via `kill_tree(pid)`.
//!
//! The runner emits to `chat:<id>` once we know the id; before that, the
//! webview is responsible for using the placeholder id returned synchronously
//! to the caller.
//!
//! Mutations to the Registry also emit `instances-changed` (per existing
//! convention, the IPC layer fires it after the registry call).

use super::ChatState;
use crate::chat::runner::run_turn;
use crate::state::AppState;
use crate::types::chat::{ChatEvent, ContentBlock};
use chrono::Utc;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// Validate a frontend-supplied placeholder id. Must start with "pending-"
/// and contain only [A-Za-z0-9_-] otherwise. Length-capped. Returning Err
/// indicates the caller should fall back to the server-generated placeholder
/// instead of using attacker-supplied input as an event channel suffix.
fn validate_placeholder_id(id: &str) -> Result<(), &'static str> {
    if id.len() < 9 || id.len() > 64 {
        return Err("placeholder length out of range");
    }
    if !id.starts_with("pending-") {
        return Err("placeholder must start with 'pending-'");
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("placeholder charset");
    }
    Ok(())
}

/// Shared per-turn execution. Runs `claude -p` on a blocking thread, captures
/// session_id from the first SessionStarted event, registers the session,
/// emits ChatEvents over Tauri events, returns the resolved session_id.
///
/// `placeholder_id_in` is an optional caller-supplied placeholder used when
/// `session_id_in` is None (i.e. brand-new session, frontend-driven). If
/// supplied and well-formed (validate_placeholder_id), the SessionStarted
/// event is mirrored on `chat:<placeholder>` so the frontend renderer can
/// subscribe BEFORE invoking `start_session` and capture the real id from
/// the stream itself rather than waiting for the entire turn to finish.
async fn run_session_turn(
    session_id_in: Option<String>,
    cwd: String,
    prompt: String,
    model: String,
    effort: String,
    placeholder_id_in: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let cwd_path = PathBuf::from(&cwd);
    let captured: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(session_id_in.clone()));
    let captured_for_closure = Arc::clone(&captured);
    let registry_for_closure = Arc::clone(&state.instances);
    let app_for_closure = app.clone();
    let initial_id = session_id_in.clone();

    if let Some(ref id) = session_id_in {
        state.instances.set_busy(id, true);
        let _ = app.emit("instances-changed", ());
    }

    // Allocate cancel slot under either the known id, a caller-supplied
    // "pending-..." placeholder (validated), or a server-generated fallback.
    let placeholder_id = match (&session_id_in, placeholder_id_in.as_deref()) {
        (Some(id), _) => id.clone(),
        (None, Some(supplied)) if validate_placeholder_id(supplied).is_ok() => supplied.to_string(),
        _ => format!("pending-{}", Utc::now().timestamp_millis()),
    };
    let chat_state: State<'_, Arc<ChatState>> = app.state();
    let slot = chat_state.allocate(&placeholder_id);
    let placeholder_for_closure = placeholder_id.clone();
    let slot_for_closure = Arc::clone(&slot);

    // Resolve project_id BEFORE spawn_blocking - settings::Mutex isn't shareable
    // through the closure (lifetimes), and we want the upsert to happen anyway
    // regardless of whether SessionStarted ever fires.
    let now_str = Utc::now().to_rfc3339();
    let project_id = {
        let mut s = state.settings.lock().unwrap();
        let (pid, _) = crate::settings::upsert_project_for_cwd(&mut s, &cwd_path, &now_str);
        pid
    };

    let project_id_for_closure = project_id.clone();
    let cwd_for_closure = cwd.clone();
    let now_str_for_closure = now_str.clone();

    // Cleanup guard: ensures chat_state.running entries get removed even if
    // the spawn_blocking closure panics or the runner errors out. Created
    // before spawn_blocking; dropped at the end of the function or via
    // early `?` return. The guard captures placeholder_id by value and
    // looks up the chat_state via the AppHandle when it runs.
    struct Cleanup {
        app: AppHandle,
        placeholder: String,
    }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let chat_state: tauri::State<'_, Arc<ChatState>> = self.app.state();
            chat_state.remove(&self.placeholder);
        }
    }
    let _cleanup = Cleanup {
        app: app.clone(),
        placeholder: placeholder_id.clone(),
    };

    // Resume turns (initial_id is Some) suppress forwarded SessionStarted events
    // so the user doesn't see "Session started (model)" in the chat on every
    // turn. The first turn (initial_id None) still surfaces it once - that's
    // the only one that matters for the user.
    // If this is an existing session, ensure the registry knows the model+effort
    // (handles takeover paths where set_model_effort wasn't called before).
    if let Some(ref id) = session_id_in {
        state.instances.set_model_effort(id, &model, &effort);
    }

    let is_resume_turn = initial_id.is_some();
    let model_for_closure = model.clone();
    let effort_for_closure = effort.clone();
    let model_for_registry = model.clone();
    let effort_for_registry = effort.clone();
    let tracking_id_for_closure = placeholder_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_turn(
            &cwd_path,
            initial_id.as_deref(),
            &tracking_id_for_closure,
            &prompt,
            &model_for_closure,
            &effort_for_closure,
            Some(slot_for_closure),
            |ev: ChatEvent| {
                let mut just_captured: Option<String> = None;
                if let ChatEvent::SessionStarted { ref session_id, .. } = ev {
                    let mut g = captured_for_closure.lock().unwrap();
                    if g.is_none() {
                        *g = Some(session_id.clone());
                        just_captured = Some(session_id.clone());
                        // Insert directly without re-resolving project_id.
                        registry_for_closure.upsert_interactive(
                            session_id,
                            std::path::Path::new(&cwd_for_closure),
                            &project_id_for_closure,
                            &now_str_for_closure,
                        );
                        registry_for_closure.set_model_effort(
                            session_id,
                            &model_for_registry,
                            &effort_for_registry,
                        );
                        registry_for_closure.set_busy(session_id, true);
                        // Snapshot to disk so this session re-appears in the
                        // sidebar after an app restart (Path C has no live
                        // process between turns, so the live-pid rehydrate
                        // would otherwise miss it).
                        crate::sessions::persistence::save_snapshot_default(
                            &registry_for_closure,
                        );
                    }
                }
                // CRITICAL ordering for the new-session sidebar bug fix:
                // when we just captured the real id, emit the SessionStarted
                // event on `chat:<placeholder>` FIRST so the frontend captures
                // the real id (and sets pendingNewSession.realId) BEFORE the
                // `instances-changed` listener fires refreshSessions+renderSidebar.
                // Otherwise the user briefly sees a duplicate row in the sidebar.
                if let Some(ref real_id) = just_captured {
                    if real_id != &placeholder_for_closure {
                        let _ = app_for_closure
                            .emit(&format!("chat:{}", placeholder_for_closure), &ev);
                    }
                }
                if just_captured.is_some() {
                    let _ = app_for_closure.emit("instances-changed", ());
                }
                // Suppress SessionStarted forwarding on resume turns. Each
                // `claude -p --resume` invocation re-emits a `system init`
                // line with the same session_id; surfacing it as a
                // "Session started" system message in the chat on every
                // turn pollutes the transcript. The first turn (initial_id
                // None) still gets it once.
                let is_session_started = matches!(ev, ChatEvent::SessionStarted { .. });
                if is_session_started && is_resume_turn {
                    return;
                }
                let target = captured_for_closure
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| placeholder_for_closure.clone());
                let _ = app_for_closure.emit(&format!("chat:{}", target), &ev);
            },
        )
    })
    .await
    .map_err(|e| format!("join: {}", e))?;

    let final_id = captured.lock().unwrap().clone().unwrap_or_default();
    if !final_id.is_empty() {
        state.instances.set_busy(&final_id, false);
    }
    if !final_id.is_empty() && final_id != placeholder_id {
        chat_state.remove(&final_id);
    }
    let _ = app.emit("instances-changed", ());
    // _cleanup drops here, removing placeholder_id from chat_state.running.

    result.map_err(|e| format!("run_turn: {}", e))?;
    Ok(final_id)
}

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
    run_session_turn(None, cwd, prompt, model, effort, placeholder_id, state, app).await
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
        let inst = state.instances.get(&session_id);
        match inst {
            Some(i) if !i.model.is_empty() && !i.effort.is_empty() => (i.model.clone(), i.effort.clone()),
            _ => ("opus".to_string(), "high".to_string()),
        }
    };
    run_session_turn(Some(session_id), cwd, prompt, model, effort, None, state, app).await
}

#[tauri::command]
pub async fn set_session_effort(
    session_id: String,
    effort: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let valid = ["low", "medium", "high", "xhigh", "max"];
    if !valid.contains(&effort.as_str()) {
        return Err(format!("invalid effort: {effort}"));
    }
    state.instances.set_effort(&session_id, &effort);
    crate::sessions::persistence::save_snapshot_default(&state.instances);
    let _ = app.emit("instances-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn cancel_turn(
    session_id: String,
    chat_state: State<'_, Arc<ChatState>>,
) -> Result<(), String> {
    let slot = chat_state.slot(&session_id);
    if let Some(slot) = slot {
        let pid = slot.lock().unwrap().take();
        if let Some(pid) = pid {
            let _ = crate::channels::kill::kill_tree(pid);
        }
    }
    Ok(())
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
    app: AppHandle,
) -> Result<(), String> {
    super::attachments::validate_session_id(&session_id)?;
    let cwd_path = PathBuf::from(&cwd);
    let now_str = Utc::now().to_rfc3339();
    let project_id = {
        let mut s = state.settings.lock().unwrap();
        let (pid, _) = crate::settings::upsert_project_for_cwd(&mut s, &cwd_path, &now_str);
        pid
    };
    state.instances.upsert_interactive(&session_id, &cwd_path, &project_id, &now_str);
    let _ = app.emit("instances-changed", ());
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

    #[test]
    fn validate_placeholder_id_accepts_well_formed() {
        assert!(validate_placeholder_id("pending-12345").is_ok());
        assert!(validate_placeholder_id("pending-1700000000000").is_ok());
        assert!(validate_placeholder_id("pending-abc-123_xyz").is_ok());
    }

    #[test]
    fn validate_placeholder_id_rejects_malformed() {
        assert!(validate_placeholder_id("").is_err());
        assert!(validate_placeholder_id("pending-").is_err()); // < 9 chars
        assert!(validate_placeholder_id("real-1234567").is_err()); // wrong prefix
        assert!(validate_placeholder_id("60e53cc5-9823-4af3-979f-29e1e891a718").is_err()); // real session id
        assert!(validate_placeholder_id("pending-../etc").is_err()); // path traversal
        assert!(validate_placeholder_id("pending-a/b").is_err());
        assert!(validate_placeholder_id("pending-a b").is_err()); // space
        assert!(validate_placeholder_id(&format!("pending-{}", "x".repeat(60))).is_err()); // too long
    }
}
