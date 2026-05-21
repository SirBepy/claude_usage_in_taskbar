//! Channel-lifecycle RPC methods: start/stop/restart/show/hide/list. Each
//! delegates to `crate::daemon::channels` and is keyed by project_id.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;

pub fn register_channels(router: &mut Router, state: Arc<DaemonState>) {
    #[derive(serde::Deserialize)]
    struct ProjectIdParams {
        project_id: String,
    }

    {
        let state = state.clone();
        router.register("start_channel", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: ProjectIdParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                crate::daemon::channels::start_channel(state, p.project_id)
                    .map_err(RpcError::internal)?;
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("stop_channel", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: ProjectIdParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                crate::daemon::channels::stop_channel(&state, &p.project_id)
                    .map_err(RpcError::internal)?;
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("restart_channel", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: ProjectIdParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                crate::daemon::channels::restart_channel(state, p.project_id)
                    .map_err(RpcError::internal)?;
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("show_channel", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: ProjectIdParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                crate::daemon::channels::show_channel(&state, &p.project_id)
                    .map_err(RpcError::internal)?;
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("hide_channel", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: ProjectIdParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                crate::daemon::channels::hide_channel(&state, &p.project_id)
                    .map_err(RpcError::internal)?;
                Ok(json!({"ok": true}))
            }
        });
    }
    router.register("list_channels", move |_params, _ctx| {
        let state = state.clone();
        async move { Ok(json!(crate::daemon::channels::list_channels(&state))) }
    });
}
