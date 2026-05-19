//! Hook HTTP server hosted by the daemon. Receives stop/notify/permission
//! requests from external claude processes (via global ~/.claude hook scripts
//! and per-session MCP children) and from `claude -p` subprocesses spawned by
//! the daemon itself. Same endpoint shape as the previous app-hosted server
//! (`src/hooks/server.rs`); HookCtx swaps `AppHandle` for `Arc<DaemonState>`
//! and event emission for daemon notifier publishes.

use crate::daemon::state::DaemonState;
use crate::settings::paths;
use anyhow::Result;
use axum::{
    extract::State as AxState,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::TcpListener;

use crate::tokens as token_stats;

#[derive(Clone)]
pub struct HookCtx { pub state: Arc<DaemonState> }

async fn health_endpoint(AxState(_ctx): AxState<Arc<HookCtx>>) -> impl IntoResponse {
    (StatusCode::OK, Json(json!({"daemon": "ok"})))
}

/// Payload shape used by the existing hook client in `~/.claude/hooks/*`
/// (unchanged from the app-hosted server so the hooks stay compatible).
#[derive(Deserialize, Debug, Default)]
struct RefreshPayload {
    #[serde(default)] session_id: Option<String>,
    #[serde(default)] transcript_path: Option<String>,
    #[serde(default)] cwd: Option<String>,
    // origin.* fields are kept around for future notification-click focus
    // support but aren't used yet on the daemon side.
    #[serde(default)] #[allow(dead_code)] origin: Option<serde_json::Value>,
}

async fn on_refresh(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(payload): Json<RefreshPayload>,
) -> impl IntoResponse {
    log::info!(
        "hook /refresh: session={} cwd={} transcript={}",
        payload.session_id.as_deref().unwrap_or("-"),
        payload.cwd.as_deref().unwrap_or("-"),
        payload.transcript_path.as_deref().unwrap_or("-"),
    );

    // Tell the app to kick a poll + play a sound. App handles audio + scraper.
    ctx.state.notifier.publish(
        "refresh_requested",
        json!({"cwd": payload.cwd, "session_id": payload.session_id}),
    );

    // Token-history append in background. Daemon owns the file write now.
    if let (Some(session_id), Some(transcript_path)) =
        (payload.session_id.clone(), payload.transcript_path.clone())
    {
        let state = ctx.state.clone();
        let cwd = payload.cwd.clone();
        tokio::spawn(async move {
            let transcript = PathBuf::from(transcript_path);
            let totals = tokio::task::spawn_blocking({
                let t = transcript.clone();
                move || token_stats::parse_transcript(&t)
            }).await.unwrap_or_default();

            let Ok(history_path) = paths::token_history_file() else { return };
            let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            let record = token_stats::TokenRecord {
                session_id,
                cwd,
                date: chrono::Utc::now().format("%Y-%m-%d").to_string(),
                input_tokens: totals.input_tokens,
                output_tokens: totals.output_tokens,
                cache_read_tokens: totals.cache_read_tokens,
                cache_creation_tokens: totals.cache_creation_tokens,
                turns: totals.turns,
                started_at: now.clone(),
                last_active_at: now.clone(),
                recorded_at: now,
                live: None,
                merged_subagents: None,
            };
            let updated = tokio::task::spawn_blocking(move || {
                token_stats::append_session(&history_path, record)
            }).await;
            if let Ok(Ok(history)) = updated {
                state.notifier.publish("token_history_updated", json!({"history": history}));
            }
        });
    }

    (StatusCode::NO_CONTENT, Json(json!({})))
}

async fn on_notify(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(payload): Json<RefreshPayload>,
) -> impl IntoResponse {
    log::info!("hook /notify: cwd={}", payload.cwd.as_deref().unwrap_or("-"));
    ctx.state.notifier.publish("notify_requested", json!({"cwd": payload.cwd}));
    StatusCode::OK
}

async fn on_quit(AxState(ctx): AxState<Arc<HookCtx>>) -> impl IntoResponse {
    log::info!("hook /quit received");
    ctx.state.notifier.publish("quit_requested", json!({}));
    (StatusCode::NO_CONTENT, Json(json!({})))
}

use crate::sessions::kinds::InstanceKind;
use crate::sessions::registry::RegisterInput;

#[derive(Deserialize, Debug, Default)]
struct SessionStartPayload {
    pub session_id: String,
    #[serde(default)] pub cwd: Option<String>,
    #[serde(default)] pub transcript_path: Option<String>,
    #[serde(default)] pub pid: Option<u32>,
    #[serde(default)] pub source: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
struct SessionEndPayload {
    pub session_id: String,
    #[serde(default)] pub reason: Option<String>,
}

async fn on_session_start(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(payload): Json<SessionStartPayload>,
) -> impl IntoResponse {
    log::info!(
        "hook /hooks/session-start: session={} cwd={} pid={:?} source={:?}",
        payload.session_id,
        payload.cwd.as_deref().unwrap_or("-"),
        payload.pid,
        payload.source,
    );

    let Some(cwd) = payload.cwd.clone() else {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "missing cwd"})));
    };
    let cwd_path = std::path::PathBuf::from(&cwd);

    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

    // Decision 10: kind = External until Phase 4 moves channels into daemon.
    let kind = InstanceKind::External;
    let is_remote = false;

    let transcript_path_buf = payload.transcript_path.clone().map(std::path::PathBuf::from);

    // Mutate daemon cache first so the cache contains the new project_id.
    let (project_id, created_new) =
        ctx.state.settings.upsert_project_for_cwd(&cwd_path, &now);

    // Take fresh snapshot AFTER the cache mutation; the shim mutex below will
    // already contain the new project so Registry's internal upsert finds it.
    let snapshot = ctx.state.settings.snapshot();
    let shim_mutex = std::sync::Mutex::new(snapshot);

    let input = RegisterInput {
        session_id: payload.session_id.clone(),
        cwd: cwd_path.clone(),
        pid: payload.pid.unwrap_or(0),
        kind,
        is_remote,
        transcript_path: transcript_path_buf.clone(),
        started_at: now.clone(),
    };
    let (_registered_project_id, _registered_created_new) =
        ctx.state.registry.register(input, &shim_mutex, &now);

    if created_new {
        ctx.state.notifier.publish(
            "project_created",
            json!({"project_id": project_id, "cwd": cwd, "now": now}),
        );
    }

    // Background enrichment: pid + bridgeSessionId via session_files, name from transcript.
    let state = ctx.state.clone();
    let sid = payload.session_id.clone();
    let payload_pid = payload.pid;
    let transcript_path_opt = transcript_path_buf;
    tokio::spawn(async move {
        let mut changed = false;
        if payload_pid.is_none() || payload_pid == Some(0) {
            if let Some(meta) = crate::hooks::session_files::resolve_session_meta(&sid).await {
                if state.registry.set_pid(&sid, meta.pid) { changed = true; }
                if let Some(bridge) = meta.bridge_session_id {
                    state.registry.set_bridge_session_id(&sid, bridge);
                    changed = true;
                }
            }
        } else if let Some(pid) = payload_pid {
            if let Some(bridge) = crate::hooks::session_files::resolve_bridge_session_id(pid).await {
                state.registry.set_bridge_session_id(&sid, bridge);
                changed = true;
            }
        }
        if let Some(path) = transcript_path_opt {
            if let Some(name) = poll_first_user_prompt(&path).await {
                if state.registry.set_name(&sid, name) { changed = true; }
            }
        }
        if changed {
            state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
        }
    });

    ctx.state.notifier.publish("instances_changed", json!({"instances": ctx.state.registry.list()}));
    (StatusCode::NO_CONTENT, Json(json!({})))
}

async fn on_session_end(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(payload): Json<SessionEndPayload>,
) -> impl IntoResponse {
    log::info!(
        "hook /hooks/session-end: session={} reason={}",
        payload.session_id,
        payload.reason.as_deref().unwrap_or("-"),
    );
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

    let inst = ctx.state.registry.get(&payload.session_id);
    let is_interactive = inst.as_ref().map(|i| i.kind) == Some(InstanceKind::Interactive);
    let is_busy = inst.map(|i| i.busy).unwrap_or(false);
    if is_interactive && is_busy {
        log::debug!("ignoring SessionEnd for busy Interactive session {}", payload.session_id);
        return StatusCode::NO_CONTENT;
    }
    if ctx.state.registry.mark_ended(&payload.session_id, crate::types::EndReason::HookSessionEnd, &now) {
        ctx.state.notifier.publish("instances_changed", json!({"instances": ctx.state.registry.list()}));
    }
    StatusCode::NO_CONTENT
}

async fn poll_first_user_prompt(path: &std::path::Path) -> Option<String> {
    let path = path.to_path_buf();
    for _ in 0..30 {
        let p = path.clone();
        let found = tokio::task::spawn_blocking(move || {
            crate::tokens::first_user_prompt(&p, 60)
        }).await.ok().flatten();
        if let Some(name) = found { return Some(name); }
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    }
    None
}

/// Fixed port matching the Electron app + README + installer + global hook
/// scripts at `~/.claude/aiusage-hook.{ps1,sh}`. Pinned; do not change.
pub const HOOK_PORT: u16 = 27182;

pub async fn spawn(state: Arc<DaemonState>) -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", HOOK_PORT)).await?;
    let port = listener.local_addr()?.port();
    log::info!("daemon hook server listening on 127.0.0.1:{port}");

    if let Ok(port_file) = paths::hooks_port_file() {
        let _ = std::fs::write(&port_file, port.to_string());
    }

    let ctx = Arc::new(HookCtx { state });
    let router = Router::new()
        .route("/health", get(health_endpoint))
        .route("/refresh", post(on_refresh))
        .route("/notify", post(on_notify))
        .route("/quit", post(on_quit))
        .route("/hooks/session-start", post(on_session_start))
        .route("/hooks/session-end", post(on_session_end))
        .with_state(ctx);

    tokio::spawn(async move {
        if let Err(e) = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        ).await {
            log::error!("daemon hook server exited: {e}");
        }
    });

    Ok(port)
}
