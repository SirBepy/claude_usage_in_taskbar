//! Registry-mutation RPC methods: mark-ended, externalize, set-effort,
//! register-historical, manual takeover, and the list-instances snapshot fetch.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::types::EndReason;
use serde_json::{json, Value};
use std::sync::Arc;

pub fn register_chat_registry(router: &mut Router, state: Arc<DaemonState>) {
    #[derive(serde::Deserialize)]
    struct SessionId { session_id: String }
    #[derive(serde::Deserialize)]
    struct EffortParams { session_id: String, effort: String }
    #[derive(serde::Deserialize)]
    struct HistoricalParams { session_id: String, cwd: String }

    {
        let state = state.clone();
        router.register("mark_session_ended", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: SessionId = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let now = chrono::Utc::now().to_rfc3339();
                state.registry.mark_ended(&p.session_id, EndReason::Manual, &now);
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("externalize_session", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: SessionId = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                state.registry.externalize_session(&p.session_id);
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                // Now External: drop it from the Interactive snapshot so a daemon
                // restart doesn't resurrect it as a ghost Interactive entry.
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("set_session_effort", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: EffortParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                state.registry.set_effort(&p.session_id, &p.effort);
                crate::sessions::chat_config::record(&p.session_id, "", &p.effort);
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("register_historical", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: HistoricalParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let cwd = std::path::PathBuf::from(&p.cwd);
                let now = chrono::Utc::now().to_rfc3339();
                let (project_id, created_new) = {
                    let mut snap = state.settings.snapshot();
                    crate::settings::upsert_project_for_cwd(&mut snap, &cwd, &now)
                };
                if created_new {
                    state.notifier.publish("project_created", json!({
                        "project_id": project_id, "cwd": p.cwd, "now": now,
                    }));
                }
                state.registry.upsert_interactive(&p.session_id, &cwd, &project_id, &now);
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("takeover_manual", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct TakeoverParams { manual_pid: u32, model: String, effort: String }
                let p: TakeoverParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let shim = std::sync::Mutex::new(state.settings.snapshot());
                let sid = crate::chat::takeover::takeover(p.manual_pid, &p.model, &p.effort, &state.registry, &shim)
                    .map_err(|e| RpcError::internal(e.to_string()))?;
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"session_id": sid}))
            }
        });
    }
    // Snapshot fetch so a freshly-connected app can seed its instance cache
    // without waiting for the next instances_changed notification (ai_todo 63).
    router.register("list_instances", move |_params, _ctx| {
        let state = state.clone();
        async move { Ok(json!(state.registry.list())) }
    });
}
