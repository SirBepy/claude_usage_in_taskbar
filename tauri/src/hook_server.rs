//! Local HTTP server that accepts Claude Code CLI stop/notify/quit hook pings
//! and records token stats into `token-history.json`.

use crate::paths;
use crate::settings;
use crate::state::AppState;
use crate::token_stats;
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
    #[serde(default)] origin: Option<serde_json::Value>,
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

async fn on_notify(AxState(_ctx): AxState<Arc<HookCtx>>) -> impl IntoResponse {
    // Native notifications not yet ported; the endpoint exists so hook
    // clients do not get 404s.
    (StatusCode::NO_CONTENT, Json(json!({})))
}

async fn on_quit(AxState(ctx): AxState<Arc<HookCtx>>) -> impl IntoResponse {
    log::info!("hook /quit received");
    ctx.app.exit(0);
    (StatusCode::NO_CONTENT, Json(json!({})))
}

pub async fn spawn(app: AppHandle) -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
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
