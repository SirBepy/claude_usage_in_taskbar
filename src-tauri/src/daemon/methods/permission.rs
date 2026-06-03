//! Permission/question responder RPC methods. The app calls these to resolve
//! the pending oneshot channels that the hooks server is blocking on while it
//! waits for a user decision.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use std::sync::Arc;

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
                let Some(tx) = tx else {
                    return Err(RpcError {
                        code: -32004,
                        message: format!("unknown request_id {}", b.request_id),
                        data: None,
                    });
                };
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
                Ok(serde_json::json!({"ok": true}))
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
            let Some(tx) = tx else {
                return Err(RpcError {
                    code: -32004,
                    message: format!("unknown request_id {}", b.request_id),
                    data: None,
                });
            };
            let _ = tx.send(serde_json::json!({"answers": b.answers}));
            Ok(serde_json::json!({"ok": true}))
        }
    });
}
