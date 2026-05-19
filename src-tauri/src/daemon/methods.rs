//! RPC method registration for session lifecycle. Each method is wired
//! into the Router with the SessionMap captured by the closure.

use crate::daemon::lifecycle::{self, LifecycleError, StartSessionParams};
use crate::daemon::notifier::Notifier;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::session::SessionMap;
use serde::Deserialize;
use serde_json::{json, Value};

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
}
