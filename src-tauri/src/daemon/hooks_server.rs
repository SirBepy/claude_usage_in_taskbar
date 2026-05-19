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
    routing::get,
    Json, Router,
};
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;

#[derive(Clone)]
pub struct HookCtx { pub state: Arc<DaemonState> }

async fn health_endpoint(AxState(_ctx): AxState<Arc<HookCtx>>) -> impl IntoResponse {
    (StatusCode::OK, Json(json!({"daemon": "ok"})))
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
