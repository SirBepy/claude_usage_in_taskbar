//! RPC method registration for session lifecycle. Each method is wired
//! into the Router with the SessionMap captured by the closure.

use crate::daemon::lifecycle::{self, LifecycleError, StartSessionParams};
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
        router.register("start_session", move |params| {
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
        router.register("send_message", move |params| {
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
        router.register("cancel_turn", move |params| {
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
        router.register("end_session", move |params| {
            let map = map.clone();
            async move {
                let p: SessionIdOnly = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                lifecycle::end_session(&map, &p.session_id).await.map_err(err_to_rpc)?;
                Ok(json!({"ok": true}))
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::rpc::Request;
    use crate::daemon::session::new_session_map;

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
        }).await;
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
        }).await;
        let err = resp.error.expect("error");
        assert_eq!(err.code, -32602);
    }
}
