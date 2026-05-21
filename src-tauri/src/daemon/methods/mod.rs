//! RPC method registration, grouped by category. Each submodule exposes one or
//! more `register_*` fns; the daemon bin (`src/bin/cc_companion_daemon.rs`)
//! calls them in sequence at startup to populate the Router.

mod channels;
mod lifecycle;
mod permission;
mod registry;

pub use channels::register_channels;
pub use lifecycle::{register, register_notifier, register_settings};
pub use permission::register_responders;
pub use registry::register_chat_registry;

#[cfg(test)]
mod tests {
    use super::{register, register_channels, register_chat_registry, register_responders};
    use crate::daemon::rpc::{ConnectionContext, Request, Router};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;
    use serde_json::json;

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    fn dummy_state() -> std::sync::Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    #[tokio::test]
    async fn unknown_session_returns_not_found_rpc_error() {
        let mut r = Router::new();
        register(&mut r, dummy_state());
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
        register(&mut r, dummy_state());
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
        register(&mut r, dummy_state());
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
        register(&mut r, dummy_state());
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
        let st = dummy_state();
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
        let mut r = Router::new();
        register_responders(&mut r, dummy_state());
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "respond_permission".into(),
            params: Some(json!({"request_id": "ghost", "allow": true})),
        }, dummy_ctx()).await;
        assert_eq!(resp.error.as_ref().map(|e| e.code), Some(-32004));
    }

    #[tokio::test]
    async fn list_channels_empty_returns_array() {
        let mut r = Router::new();
        register_channels(&mut r, dummy_state());
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "list_channels".into(),
            params: None,
        }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "expected no error, got {:?}", resp.error);
        assert_eq!(resp.result, Some(json!([])));
    }

    #[tokio::test]
    async fn mark_session_ended_unknown_is_ok() {
        let mut r = Router::new();
        register_chat_registry(&mut r, dummy_state());
        let resp = r.dispatch(Request { jsonrpc: "2.0".into(), id: json!(1),
            method: "mark_session_ended".into(), params: Some(json!({"session_id":"ghost"})) }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
    }

    #[tokio::test]
    async fn list_instances_empty_returns_array() {
        let mut r = Router::new();
        register_chat_registry(&mut r, dummy_state());
        let resp = r.dispatch(Request { jsonrpc: "2.0".into(), id: json!(1),
            method: "list_instances".into(), params: None }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert_eq!(resp.result, Some(json!([])));
    }

    #[tokio::test]
    async fn shutdown_daemon_returns_ok() {
        let mut r = Router::new();
        register(&mut r, dummy_state());
        let resp = r.dispatch(Request { jsonrpc: "2.0".into(), id: json!(1),
            method: "shutdown_daemon".into(), params: None }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert_eq!(resp.result, Some(json!({"ok": true})));
    }

    #[tokio::test]
    async fn start_session_invalid_cwd_does_not_register() {
        let st = dummy_state();
        let reg = st.registry.clone();
        let mut r = Router::new();
        register(&mut r, st);
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "start_session".into(),
            params: Some(json!({"cwd": "Z:\\does\\not\\exist", "model": "opus", "effort": "high", "resume_id": null})),
        }, dummy_ctx()).await;
        assert!(resp.error.is_some(), "invalid cwd must error");
        assert_eq!(reg.list().len(), 0, "no registry entry on failed spawn");
    }
}
