//! Session-lifecycle RPC methods: start/send/cancel/end/attach/detach plus the
//! global notifier subscription and settings replacement. Each method is wired
//! into the Router with the SessionMap captured by the closure.

use crate::daemon::lifecycle::{self, LifecycleError, StartSessionParams};
use crate::daemon::notifier::Notifier;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::state::DaemonState;
use crate::types::EndReason;
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

/// Debug-only: see the `simulate_rate_limit` RPC.
#[cfg(debug_assertions)]
#[derive(Debug, Deserialize)]
struct SimulateRateLimitParams {
    session_id: String,
    /// Seconds from now until the fake window resets. Defaults to 120, long
    /// enough to inspect the banner and short enough to watch the resume fire.
    #[serde(default)]
    resets_in_secs: Option<i64>,
    /// `five_hour` (default) | `seven_day` | `weekly`.
    #[serde(default)]
    kind: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MoveSessionParams {
    session_id: String,
    target_account_id: String,
}

pub(super) fn err_to_rpc(e: LifecycleError) -> RpcError {
    use LifecycleError::*;
    match e {
        InvalidConfig(_, _)
        | CwdMissing(_)
        | NoAccounts
        | NoDefault
        | AccountNotFound(_)
        | AccountDrift(_) => RpcError::invalid_params(e.to_string()),
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

pub fn register(router: &mut Router, state: Arc<DaemonState>) {
    let map = state.sessions.clone();
    {
        let state = state.clone();
        router.register("start_session", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: StartSessionParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let cwd = p.cwd.clone();
                let model = p.model.clone();
                let effort = p.effort.clone();
                let session = lifecycle::spawn_session(&state, p).await.map_err(err_to_rpc)?;
                let sid = session.session_id.clone();
                let account_id = session.account_id.clone();
                let now = chrono::Utc::now().to_rfc3339();
                let (project_id, created_new) = {
                    let mut snap = state.settings.snapshot();
                    crate::settings::upsert_project_for_cwd(&mut snap, &cwd, &now)
                };
                if created_new {
                    state.notifier.publish("project_created", json!({
                        "project_id": project_id,
                        "cwd": cwd.to_string_lossy(),
                        "now": now,
                    }));
                }
                state.registry.upsert_interactive(&sid, &cwd, &project_id, &now);
                state.registry.set_model_effort(&sid, &model, &effort);
                state.registry.set_account(&sid, &account_id);
                crate::sessions::chat_config::record(&sid, &model, &effort);
                crate::sessions::chat_config::set_account(&sid, &account_id);
                state.registry.set_awaiting(&sid, None);
                // Deliberately NOT set_busy(true) here: no turn is in flight yet
                // (claude emits nothing until its first stdin message, so the
                // pump can never clear a busy set now). The caller's follow-up
                // send_message sets busy the moment a real turn starts. Setting
                // it at spawn left a started-but-never-messaged session busy
                // forever, deferring scheduled messages into it until they went
                // Missed and spinning the sidebar indefinitely (ai_todo 212).
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"session_id": sid}))
            }
        });
    }
    {
        let map = map.clone();
        let state = state.clone();
        router.register("send_message", move |params, _ctx| {
            let map = map.clone();
            let state = state.clone();
            async move {
                let p: SendMessageParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let session = map.get(&p.session_id)
                    .ok_or_else(|| err_to_rpc(LifecycleError::NotFound(p.session_id.clone())))?
                    .clone();
                lifecycle::send_message(&session, &p.text).await.map_err(err_to_rpc)?;
                state.registry.set_awaiting(&p.session_id, None);
                state.registry.set_busy(&p.session_id, true);
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let map = map.clone();
        let state = state.clone();
        router.register("cancel_turn", move |params, _ctx| {
            let map = map.clone();
            let state = state.clone();
            async move {
                let p: SessionIdOnly = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                lifecycle::cancel_turn(&map, &p.session_id).await.map_err(err_to_rpc)?;
                state.registry.set_busy(&p.session_id, false);
                // The interrupted turn's verdict (an AUQ's "question", a prior
                // turn's "waiting") is dead with the cancel - clear it so the
                // sidebar doesn't keep flagging a question nobody is asking.
                state.registry.set_awaiting(&p.session_id, None);
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let map = map.clone();
        let state = state.clone();
        router.register("end_session", move |params, _ctx| {
            let map = map.clone();
            let state = state.clone();
            async move {
                let p: SessionIdOnly = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                lifecycle::end_session(&map, &p.session_id).await.map_err(err_to_rpc)?;
                let now = chrono::Utc::now().to_rfc3339();
                state.registry.mark_ended(&p.session_id, EndReason::Manual, &now);
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let map = map.clone();
        let state = state.clone();
        router.register("move_session_to_account", move |params, _ctx| {
            let map = map.clone();
            let state = state.clone();
            async move {
                let p: MoveSessionParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let old = state.registry.get(&p.session_id).ok_or_else(|| {
                    RpcError::invalid_params(format!("session {} not found", p.session_id))
                })?;
                if old.account_id.as_deref() == Some(p.target_account_id.as_str()) {
                    return Err(RpcError::invalid_params(format!(
                        "session {} is already on account {}",
                        p.session_id, p.target_account_id
                    )));
                }
                let cwd = old.cwd.clone();
                let model = if old.model.is_empty() { "opus".to_string() } else { old.model.clone() };
                let effort = if old.effort.is_empty() { "high".to_string() } else { old.effort.clone() };

                // Reclaim the pending rate-limit resume queued for the old session,
                // if any - its prompt is what should continue on the new account.
                // handle_rate_limit_rejection dedupes to at most one such resume per
                // session, so the first match is the only match.
                let pending_resume = crate::sessions::scheduled_items::list()
                    .into_iter()
                    .find(|item| {
                        matches!(item.status, crate::sessions::scheduled_items::ScheduledStatus::Pending)
                            && matches!(
                                &item.kind,
                                crate::sessions::scheduled_items::ScheduledKind::Message { session_id, .. }
                                    if session_id == &p.session_id
                            )
                    });
                let prompt = if let Some(item) = pending_resume {
                    crate::sessions::scheduled_items::delete(&item.id);
                    item.prompt
                } else {
                    "Continue from where you left off.".to_string()
                };

                let session = lifecycle::spawn_session(&state, StartSessionParams {
                    cwd: cwd.clone(),
                    model: model.clone(),
                    effort: effort.clone(),
                    resume_id: Some(p.session_id.clone()),
                    remote: false,
                    account_id: Some(p.target_account_id.clone()),
                    fork: true,
                }).await.map_err(err_to_rpc)?;
                let new_id = session.session_id.clone();
                let account_id = session.account_id.clone();
                let now = chrono::Utc::now().to_rfc3339();
                let (project_id, created_new) = {
                    let mut snap = state.settings.snapshot();
                    crate::settings::upsert_project_for_cwd(&mut snap, &cwd, &now)
                };
                if created_new {
                    state.notifier.publish("project_created", json!({
                        "project_id": project_id,
                        "cwd": cwd.to_string_lossy(),
                        "now": now,
                    }));
                }
                state.registry.upsert_interactive(&new_id, &cwd, &project_id, &now);
                state.registry.set_model_effort(&new_id, &model, &effort);
                state.registry.set_account(&new_id, &account_id);
                crate::sessions::chat_config::record(&new_id, &model, &effort);
                crate::sessions::chat_config::set_account(&new_id, &account_id);
                state.registry.set_awaiting(&new_id, None);

                lifecycle::send_message(&session, &prompt).await.map_err(err_to_rpc)?;
                state.registry.set_busy(&new_id, true);

                // Retire the old session. A rate-limited session's `claude -p` child
                // has usually already exited, so a NotFound error here is expected
                // and not surfaced.
                let _ = lifecycle::end_session(&map, &p.session_id).await;
                state.registry.mark_ended(&p.session_id, EndReason::Moved, &now);

                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                state.notifier.publish("scheduled_items_changed", json!({"items": crate::sessions::scheduled_items::list()}));
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"session_id": new_id}))
            }
        });
    }
    // Debug builds only: drive the whole rate-limit flow without waiting hours
    // for a real window to run out. Feeds `handle_rate_limit_rejection` the same
    // payload shape `chat/parser.rs` builds from the CLI's `rate_limit_event`,
    // so the blocked state, the banner, and the staggered scheduled resume all
    // come from the production path, not a test-only branch.
    #[cfg(debug_assertions)]
    {
        let map = map.clone();
        let state = state.clone();
        router.register("simulate_rate_limit", move |params, _ctx| {
            let map = map.clone();
            let state = state.clone();
            async move {
                let p: SimulateRateLimitParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let session = map
                    .get(&p.session_id)
                    .ok_or_else(|| err_to_rpc(LifecycleError::NotFound(p.session_id.clone())))?
                    .clone();
                let resets_at = chrono::Utc::now().timestamp() + p.resets_in_secs.unwrap_or(120);
                let kind = p.kind.unwrap_or_else(|| "five_hour".to_string());
                let body = json!({
                    "status": "rejected",
                    "rateLimitType": kind,
                    "resetsAt": resets_at,
                    "utilization": 100.0,
                })
                .to_string();
                lifecycle::handle_rate_limit_rejection(&state, &session, &body, false);
                Ok(json!({"resets_at": resets_at, "rate_limit_type": kind}))
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
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                                log::warn!(
                                    "attach forwarding lagged for {session_id_for_task}: dropped {n} chat events"
                                );
                                continue;
                            }
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
    {
        // Explicit daemon stop: kill channels and any live chat sessions, then
        // signal the main loop to exit the process. Sessions are NOT spared -
        // this is the deliberate full stop.
        let state = state.clone();
        router.register("shutdown_daemon", move |_params, _ctx| {
            let state = state.clone();
            async move {
                for c in state.channels.list() {
                    let _ = crate::daemon::channels::stop_channel(&state, &c.project_id);
                }
                for entry in state.sessions.iter() {
                    crate::channels::kill::kill_tree(entry.pid);
                }
                state.shutdown.notify_one();
                Ok(json!({"ok": true}))
            }
        });
    }
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
    let cache_get = cache.clone();
    router.register("get_settings", move |_params, _ctx| {
        let cache = cache_get.clone();
        async move {
            let snap = cache.snapshot();
            serde_json::to_value(&snap).map_err(|e| RpcError::internal(e.to_string()))
        }
    });
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
