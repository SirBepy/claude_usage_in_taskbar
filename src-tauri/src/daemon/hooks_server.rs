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
