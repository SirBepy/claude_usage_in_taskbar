//! Permission/question responder RPC methods. The app calls these to resolve
//! the pending oneshot channels that the hooks server is blocking on while it
//! waits for a user decision.
//!
//! Both responders tolerate GHOST prompts: if the session's `claude -p` child
//! died while the prompt was open, its hook `curl` died with it and axum
//! dropped the blocked handler future on client disconnect - so the handler's
//! own post-await cleanup (remove_prompt + awaiting clear) never ran. The
//! prompt record then kept resurrecting the card on every
//! `list_pending_prompts` poll, and answering it hit "unknown request_id" and
//! changed nothing: the row sat on "Input Needed" forever. Answering any
//! prompt - live or ghost - now always tears the record down and settles the
//! registry state.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use std::sync::Arc;

/// Shared tail of both responders: drop the prompt record (ghost or live) and,
/// for question prompts, clear a lingering `awaiting == "question"` and tell
/// every window. `clear_awaiting` is false for permission prompts - they never
/// set `awaiting`, and a coincident real question from another prompt must
/// survive a permission answer.
async fn settle_prompt(state: &Arc<DaemonState>, request_id: &str, clear_awaiting: bool) {
    let session_id = state.prompt_session_id(request_id).await;
    state.remove_prompt(request_id).await;
    if !clear_awaiting {
        return;
    }
    if let Some(sid) = session_id.as_deref() {
        if state.registry.clear_awaiting_if_question(sid) {
            state.notifier.publish(
                "instances_changed",
                serde_json::json!({"instances": state.registry.list()}),
            );
        }
    }
}

pub fn register_responders(router: &mut Router, state: Arc<DaemonState>) {
    {
        let state = state.clone();
        router.register("respond_permission", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct Body {
                    request_id: String,
                    allow: bool,
                    #[serde(default)] updated_input: Option<serde_json::Value>,
                    #[serde(default)] message: Option<String>,
                }
                let b: Body = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let tx = state.pending.lock().await.remove(&b.request_id);
                let delivered = match tx {
                    Some(tx) => {
                        let payload = if b.allow {
                            serde_json::json!({
                                "behavior": "allow",
                                "updatedInput": b.updated_input.unwrap_or(serde_json::Value::Object(Default::default())),
                            })
                        } else {
                            serde_json::json!({
                                "behavior": "deny",
                                "message": b.message.unwrap_or_default(),
                            })
                        };
                        let _ = tx.send(payload);
                        true
                    }
                    None => false,
                };
                settle_prompt(&state, &b.request_id, false).await;
                Ok(serde_json::json!({"ok": true, "delivered": delivered}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("list_pending_prompts", move |_params, _ctx| {
            let state = state.clone();
            // Reliable poll path: the app fetches open prompts over RPC instead
            // of relying on the lossy notifier broadcast (which silently dropped
            // question_request frames and hung AskUserQuestion turns).
            async move { Ok(serde_json::Value::Array(state.list_prompts().await)) }
        });
    }
    router.register("respond_question", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct Body { request_id: String, answers: serde_json::Value }
            let b: Body = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let tx = state.pending.lock().await.remove(&b.request_id);
            let delivered = match tx {
                Some(tx) => {
                    let _ = tx.send(serde_json::json!({"answers": b.answers}));
                    true
                }
                None => false,
            };
            settle_prompt(&state, &b.request_id, true).await;
            Ok(serde_json::json!({"ok": true, "delivered": delivered}))
        }
    });
}
