//! Scheduled-message / scheduled-new-chat RPC methods. The daemon is the sole
//! writer of `scheduled-items.json` (mirrors `chat-config.json`'s "daemon
//! sole writer" rule): every mutation goes through one of these methods so it
//! composes correctly with the scheduler tick loop (`daemon::schedule`)
//! reading and rewriting the same file. Reads (`schedule_list`) are NOT an
//! RPC method - the app reads the store directly, same as `get_session_config`
//! / `list_auto_accept` in `ipc/misc.rs` read `chat-config.json` directly.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::sessions::scheduled_items::{self, Recurrence, ScheduledItem, ScheduledKind};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Debug, Deserialize)]
struct CreateParams {
    kind: ScheduledKind,
    prompt: String,
    fire_at: String,
    #[serde(default)]
    recurrence: Option<Recurrence>,
}

#[derive(Debug, Deserialize)]
struct IdParams {
    id: String,
}

pub fn register_schedule(router: &mut Router, state: Arc<DaemonState>) {
    router.register("schedule_create", move |params, _ctx| {
        async move {
            let p: CreateParams = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let item = ScheduledItem::new(p.kind, p.prompt, p.fire_at, p.recurrence);
            scheduled_items::upsert(item.clone());
            serde_json::to_value(&item).map_err(|e| RpcError::internal(e.to_string()))
        }
    });

    router.register("schedule_update", move |params, _ctx| {
        async move {
            let item: ScheduledItem = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            if item.id.is_empty() {
                return Err(RpcError::invalid_params("schedule_update: id must not be empty"));
            }
            if scheduled_items::get(&item.id).is_none() {
                return Err(RpcError {
                    code: -32004,
                    message: format!("scheduled item {} not found", item.id),
                    data: None,
                });
            }
            scheduled_items::upsert(item);
            Ok(json!({"ok": true}))
        }
    });

    router.register("schedule_delete", move |params, _ctx| {
        async move {
            let p: IdParams = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let existed = scheduled_items::delete(&p.id);
            Ok(json!({"ok": existed}))
        }
    });

    {
        let state = state.clone();
        router.register("schedule_fire_now", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: IdParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                crate::daemon::schedule::fire_now(&state, &p.id).await;
                Ok(json!({"ok": true}))
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::rpc::{ConnectionContext, Request};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use serde_json::json;

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    fn dummy_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    #[tokio::test]
    async fn schedule_update_unknown_id_returns_not_found() {
        let mut r = Router::new();
        register_schedule(&mut r, dummy_state());
        let item = ScheduledItem::new(
            ScheduledKind::Message { session_id: "s".into(), cwd: "C:/x".into() },
            "hi".into(),
            "2026-01-01T00:00:00Z".into(),
            None,
        );
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "schedule_update".into(),
            params: Some(serde_json::to_value(&item).unwrap()),
        }, dummy_ctx()).await;
        assert_eq!(resp.error.as_ref().map(|e| e.code), Some(-32004));
    }

    #[tokio::test]
    async fn schedule_delete_unknown_id_reports_ok_false() {
        let mut r = Router::new();
        register_schedule(&mut r, dummy_state());
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "schedule_delete".into(),
            params: Some(json!({"id": "ghost"})),
        }, dummy_ctx()).await;
        assert!(resp.error.is_none());
        assert_eq!(resp.result, Some(json!({"ok": false})));
    }

    #[tokio::test]
    async fn schedule_fire_now_unknown_id_is_ok_noop() {
        let mut r = Router::new();
        register_schedule(&mut r, dummy_state());
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "schedule_fire_now".into(),
            params: Some(json!({"id": "ghost"})),
        }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
    }
}
