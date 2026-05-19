//! RPC method registration for session lifecycle. Each method is wired
//! into the Router with the SessionMap captured by the closure.

use crate::daemon::lifecycle::{self, LifecycleError, StartSessionParams};
use crate::daemon::notifier::Notifier;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::session::SessionMap;
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::state::DaemonState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Debug, Deserialize)]
struct SendMessageParams {
    session_id: String,
    text: String,
}

#[derive(Debug, Deserialize)]
struct SessionIdOnly {
    session_id: String,
}

fn err_to_rpc(e: LifecycleError) -> RpcError {
    use LifecycleError::*;
    match e {
        InvalidConfig(_, _) | CwdMissing(_) => RpcError::invalid_params(e.to_string()),
        NotFound(_) => RpcError {
            code: -32004,
            message: e.to_string(),
            data: None,
        },
        AlreadyExists(_) => RpcError {
            code: -32005,
            message: e.to_string(),
            data: None,
        },
        MeteredBilling(_) | Io(_) => RpcError::internal(e.to_string()),
    }
}

pub fn register(router: &mut Router, map: SessionMap) {
    {
        let map = map.clone();
        router.register("start_session", move |params, _ctx| {
            let map = map.clone();
            async move {
                let p: StartSessionParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let session = lifecycle::spawn_session(&map, p).await.map_err(err_to_rpc)?;
                Ok(json!({"session_id": session.session_id}))
            }
        });
    }
    {
        let map = map.clone();
        router.register("send_message", move |params, _ctx| {
            let map = map.clone();
            async move {
                let p: SendMessageParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let session = map.get(&p.session_id)
                    .ok_or_else(|| err_to_rpc(LifecycleError::NotFound(p.session_id.clone())))?
                    .clone();
                lifecycle::send_message(&session, &p.text).await.map_err(err_to_rpc)?;
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let map = map.clone();
        router.register("cancel_turn", move |params, _ctx| {
            let map = map.clone();
            async move {
                let p: SessionIdOnly = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                lifecycle::cancel_turn(&map, &p.session_id).await.map_err(err_to_rpc)?;
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let map = map.clone();
        router.register("end_session", move |params, _ctx| {
            let map = map.clone();
            async move {
                let p: SessionIdOnly = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                lifecycle::end_session(&map, &p.session_id).await.map_err(err_to_rpc)?;
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let map = map.clone();
        router.register("attach_session", move |params, ctx| {
            let map = map.clone();
            async move {
                let p: SessionIdOnly = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let session = map.get(&p.session_id)
                    .ok_or_else(|| err_to_rpc(LifecycleError::NotFound(p.session_id.clone())))?
                    .clone();
                let mut rx = crate::daemon::broadcast::subscribe(&session);
                let outbound = ctx.outbound.clone();
                let session_id_for_task = p.session_id.clone();
                let handle = tokio::spawn(async move {
                    loop {
                        match rx.recv().await {
                            Ok(ev) => {
                                let notif = json!({
                                    "jsonrpc": "2.0",
                                    "method": "chat_event",
                                    "params": {
                                        "session_id": session_id_for_task,
                                        "event": ev,
                                    }
                                });
                                if outbound.send(notif).await.is_err() {
                                    break;
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        }
                    }
                });
                let mut subs = ctx.subscriptions.lock().await;
                if let Some(old) = subs.insert(p.session_id.clone(), handle.abort_handle()) {
                    old.abort();
                }
                Ok(json!({"ok": true}))
            }
        });
    }
    router.register("detach_session", move |params, ctx| {
        async move {
            let p: SessionIdOnly = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let mut subs = ctx.subscriptions.lock().await;
            if let Some(handle) = subs.remove(&p.session_id) {
                handle.abort();
            }
            Ok(json!({"ok": true}))
        }
    });
}

pub fn register_notifier(router: &mut Router, notifier: Notifier) {
    router.register("subscribe_global", move |_params, ctx| {
        let notifier = notifier.clone();
        async move {
            let mut rx = notifier.subscribe();
            let outbound = ctx.outbound.clone();
            let handle = tokio::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(notif) => {
                            if outbound.send(notif).await.is_err() {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    }
                }
            });
            let mut slot = ctx.global_sub.lock().await;
            if let Some(old) = slot.replace(handle.abort_handle()) {
                old.abort();
            }
            Ok(serde_json::json!({"ok": true}))
        }
    });
}

pub fn register_settings(router: &mut Router, cache: SettingsCache) {
    router.register("set_settings", move |params, _ctx| {
        let cache = cache.clone();
        async move {
            let v = params.unwrap_or(serde_json::Value::Null);
            let s: crate::types::Settings = serde_json::from_value(v)
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            cache.replace(s);
            Ok(serde_json::json!({"ok": true}))
        }
    });
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::rpc::{ConnectionContext, Request};
    use crate::daemon::session::new_session_map;

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    #[tokio::test]
    async fn unknown_session_returns_not_found_rpc_error() {
        let mut r = Router::new();
        let map = new_session_map();
        register(&mut r, map);
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "send_message".into(),
            params: Some(json!({"session_id": "nope", "text": "hi"})),
        }, dummy_ctx()).await;
        let err = resp.error.expect("error");
        assert_eq!(err.code, -32004);
    }

    #[tokio::test]
    async fn missing_params_returns_invalid_params() {
        let mut r = Router::new();
        let map = new_session_map();
        register(&mut r, map);
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "send_message".into(),
            params: Some(json!({})),
        }, dummy_ctx()).await;
        let err = resp.error.expect("error");
        assert_eq!(err.code, -32602);
    }

    #[tokio::test]
    async fn attach_session_unknown_returns_not_found() {
        let mut r = Router::new();
        let map = new_session_map();
        register(&mut r, map);
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "attach_session".into(),
            params: Some(json!({"session_id": "ghost"})),
        }, dummy_ctx()).await;
        let err = resp.error.expect("error");
        assert_eq!(err.code, -32004);
    }

    #[tokio::test]
    async fn detach_session_unknown_is_ok() {
        let mut r = Router::new();
        let map = new_session_map();
        register(&mut r, map);
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "detach_session".into(),
            params: Some(json!({"session_id": "ghost"})),
        }, dummy_ctx()).await;
        // detach on unknown session is a no-op, not an error
        assert!(resp.error.is_none());
        assert_eq!(resp.result, Some(json!({"ok": true})));
    }

    #[tokio::test]
    async fn respond_permission_resolves_pending_oneshot() {
        use crate::daemon::settings_cache::SettingsCache;
        use crate::daemon::state::DaemonState;
        use crate::types::Settings;
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let (tx, rx) = tokio::sync::oneshot::channel();
        st.pending.lock().await.insert("req-1".to_string(), tx);

        let mut r = Router::new();
        register_responders(&mut r, st.clone());
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "respond_permission".into(),
            params: Some(json!({"request_id": "req-1", "allow": true, "updated_input": {"k": 1}})),
        }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "expected no error, got {:?}", resp.error);

        let payload = rx.await.expect("oneshot resolved");
        assert_eq!(payload["behavior"], json!("allow"));
        assert_eq!(payload["updatedInput"]["k"], json!(1));
    }

    #[tokio::test]
    async fn respond_permission_unknown_request_id_errors() {
        use crate::daemon::settings_cache::SettingsCache;
        use crate::daemon::state::DaemonState;
        use crate::types::Settings;
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let mut r = Router::new();
        register_responders(&mut r, st);
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "respond_permission".into(),
            params: Some(json!({"request_id": "ghost", "allow": true})),
        }, dummy_ctx()).await;
        assert_eq!(resp.error.as_ref().map(|e| e.code), Some(-32004));
    }
}
