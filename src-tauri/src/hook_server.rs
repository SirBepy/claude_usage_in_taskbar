//! Local HTTP server that accepts Claude Code CLI stop/notify/quit hook pings
//! and records token stats into `token-history.json`.

use crate::paths;
use crate::settings;
use crate::state::AppState;
use crate::tokens as token_stats;
use anyhow::Result;
use axum::{
    extract::State as AxState,
    http::StatusCode,
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;

#[derive(Clone)]
struct HookCtx { app: AppHandle }

/// Payload shape used by the existing hook client in `~/.claude/hooks/*`
/// (unchanged from the Electron version so the hooks stay compatible).
#[derive(Deserialize, Debug, Default)]
struct RefreshPayload {
    #[serde(default)] session_id: Option<String>,
    #[serde(default)] transcript_path: Option<String>,
    #[serde(default)] cwd: Option<String>,
    // origin.* fields are kept around for future notification-click focus
    // support but aren't used yet on the Tauri side.
    #[serde(default)] #[allow(dead_code)] origin: Option<serde_json::Value>,
}

/// Payload shape for Claude Code's SessionStart / SessionEnd hooks.
/// See claude-code docs — fields surveyed from the CLI's hook emission.
#[derive(Deserialize, Debug, Default)]
struct SessionStartPayload {
    pub session_id: String,
    #[serde(default)] pub cwd: Option<String>,
    #[serde(default)] pub transcript_path: Option<String>,
    #[serde(default)] pub pid: Option<u32>,
    /// "startup" | "resume" | "clear" | "compact" — ignored for v1.
    #[serde(default)] pub source: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
struct SessionEndPayload {
    pub session_id: String,
    #[serde(default)] pub reason: Option<String>,
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

    // Kick a poll so the dashboard refreshes its percentages too.
    let h = ctx.app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::scheduler::poll_once(&h, crate::scheduler::PollTrigger::Hook).await;
    });

    let name = payload.cwd.as_deref().and_then(crate::notifications::project_name_from_cwd);
    crate::notifications::fire(
        &ctx.app,
        crate::notifications::NotifKind::WorkFinished,
        crate::notifications::NotifContext { name, percent: None },
        payload.cwd.as_deref(),
    );

    // Record token stats in the background — must not block the CLI hook.
    if let (Some(session_id), Some(transcript_path)) =
        (payload.session_id.clone(), payload.transcript_path.clone())
    {
        let app = ctx.app.clone();
        let cwd = payload.cwd.clone();
        tauri::async_runtime::spawn(async move {
            let transcript = PathBuf::from(transcript_path);
            // File IO + line parse goes to a blocking thread.
            let totals = tauri::async_runtime::spawn_blocking({
                let t = transcript.clone();
                move || token_stats::parse_transcript(&t)
            })
            .await
            .unwrap_or_default();

            let Ok(history_path) = paths::token_history_file() else { return };
            let now = chrono::Utc::now()
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
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
            let updated = tauri::async_runtime::spawn_blocking(move || {
                token_stats::append_session(&history_path, record)
            })
            .await;
            if let Ok(Ok(history)) = updated {
                let _ = app.emit("token-history-updated", history);
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
    let name = payload.cwd.as_deref().and_then(crate::notifications::project_name_from_cwd);
    crate::notifications::fire(
        &ctx.app,
        crate::notifications::NotifKind::QuestionAsked,
        crate::notifications::NotifContext { name, percent: None },
        payload.cwd.as_deref(),
    );
    StatusCode::OK
}

async fn on_quit(AxState(ctx): AxState<Arc<HookCtx>>) -> impl IntoResponse {
    log::info!("hook /quit received");
    ctx.app.exit(0);
    (StatusCode::NO_CONTENT, Json(json!({})))
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

    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let state = ctx.app.state::<AppState>();
    let registry = state.instances.clone();

    // If the PID belongs to one of our spawned channels, treat as Automated + remote.
    let (kind, is_remote) = {
        let pid = payload.pid.unwrap_or(0);
        let is_ours = state.channels.list().iter().any(|c| c.pid == Some(pid));
        if is_ours {
            (crate::types::InstanceKind::Automated, true)
        } else {
            (crate::types::InstanceKind::External, false)
        }
    };

    let input = crate::instances::RegisterInput {
        session_id: payload.session_id.clone(),
        cwd: std::path::PathBuf::from(cwd),
        pid: payload.pid.unwrap_or(0),
        kind,
        is_remote,
        transcript_path: payload.transcript_path.map(std::path::PathBuf::from),
        started_at: now.clone(),
    };

    let (_project_id, created_new) =
        registry.register(input.clone(), &state.settings, &now);

    if created_new {
        // New project auto-created: persist settings to disk.
        let snapshot = state.settings.lock().unwrap().clone();
        if let Ok(path) = paths::settings_file() {
            let _ = settings::save(&path, &snapshot);
        }
        let _ = ctx.app.emit("settings-changed", &snapshot);
    }

    // Enrich with bridgeSessionId in the background.
    let h = ctx.app.clone();
    let sid = payload.session_id.clone();
    let pid_opt = payload.pid;
    tauri::async_runtime::spawn(async move {
        let Some(pid) = pid_opt else { return };
        if let Some(bridge) = crate::session_files::resolve_bridge_session_id(pid).await {
            let s = h.state::<AppState>();
            s.instances.set_bridge_session_id(&sid, bridge);
            let _ = h.emit("instances-changed", s.instances.list());
        }
    });

    let _ = ctx.app.emit("instances-changed", registry.list());

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
    let state = ctx.app.state::<AppState>();
    if state.instances.mark_ended(&payload.session_id, crate::types::EndReason::HookSessionEnd, &now) {
        let _ = ctx.app.emit("instances-changed", state.instances.list());
    }
    StatusCode::NO_CONTENT
}

/// Fixed port matching the Electron app + README + installer + user hook scripts
/// at `~/.claude/aiusage-hook.{ps1,sh}`. Changing this breaks every already-installed
/// hook client, so it stays pinned.
const HOOK_PORT: u16 = 27182;

pub async fn spawn(app: AppHandle) -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", HOOK_PORT)).await?;
    let port = listener.local_addr()?.port();
    log::info!("hook server listening on 127.0.0.1:{port}");

    // Persist port to settings for hook client discovery.
    {
        let state = app.state::<AppState>();
        let mut guard = state.settings.lock().unwrap();
        if guard.hook_port != Some(port) {
            guard.hook_port = Some(port);
            let s = guard.clone();
            drop(guard);
            let path = paths::settings_file()?;
            let _ = settings::save(&path, &s);
            let _ = app.emit("settings-changed", s);
        }
    }

    let ctx = Arc::new(HookCtx { app: app.clone() });
    let router = Router::new()
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
            log::error!("hook server exited: {e}");
        }
    });

    Ok(port)
}
