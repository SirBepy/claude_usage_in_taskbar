//! Hook HTTP server hosted by the daemon. Receives stop/notify/permission
//! requests from external claude processes (via global ~/.claude hook scripts
//! and per-session MCP children) and from `claude -p` subprocesses spawned by
//! the daemon itself. Same endpoint shape as the previous app-hosted server
//! (`src/hooks/server.rs`); HookCtx swaps `AppHandle` for `Arc<DaemonState>`
//! and event emission for daemon notifier publishes.
//!
//! Endpoints are grouped by category into submodules; this file owns the
//! boot scaffolding (HookCtx, HOOK_PORT, health, spawn) and the route table,
//! the only place that "sees" every category at once.

mod lifecycle;
mod permission;
mod relay;
mod stop;

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
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;

#[derive(Clone)]
pub(crate) struct HookCtx {
    pub state: Arc<DaemonState>,
}

async fn health_endpoint(AxState(_ctx): AxState<Arc<HookCtx>>) -> impl IntoResponse {
    (StatusCode::OK, Json(json!({"daemon": "ok"})))
}

/// Fixed port matching the Electron app + README + installer + global hook
/// scripts at `~/.claude/aiusage-hook.{ps1,sh}`. Pinned; do not change.
pub const HOOK_PORT: u16 = 27182;

pub async fn spawn(state: Arc<DaemonState>) -> Result<u16> {
    // A test instance (CC_DAEMON_INSTANCE set) binds an ephemeral port instead
    // of the fixed HOOK_PORT, and does NOT write the shared hooks_port.txt, so
    // it never fights the production daemon for 27182 or clobbers its port file
    // (ai_todo 71).
    let test_instance = crate::daemon::instance::is_test_instance();
    let bind_port = if test_instance { 0 } else { HOOK_PORT };
    let listener = TcpListener::bind(("127.0.0.1", bind_port)).await?;
    let port = listener.local_addr()?.port();
    log::info!("daemon hook server listening on 127.0.0.1:{port}");

    if !test_instance {
        if let Ok(port_file) = paths::hooks_port_file() {
            let _ = std::fs::write(&port_file, port.to_string());
        }
    }

    let ctx = Arc::new(HookCtx { state });
    let router = Router::new()
        .route("/health", get(health_endpoint))
        .route("/refresh", post(relay::on_refresh))
        .route("/notify", post(relay::on_notify))
        .route("/quit", post(relay::on_quit))
        .route("/hooks/session-start", post(lifecycle::on_session_start))
        .route("/hooks/session-end", post(lifecycle::on_session_end))
        .route("/hooks/stop", post(stop::on_stop))
        .route("/permissions/request", post(permission::on_permission_request))
        .route("/questions/request", post(permission::on_question_request))
        .with_state(ctx);

    tokio::spawn(async move {
        if let Err(e) = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        {
            log::error!("daemon hook server exited: {e}");
        }
    });

    Ok(port)
}
