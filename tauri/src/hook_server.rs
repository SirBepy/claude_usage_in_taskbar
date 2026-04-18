//! Local HTTP server that accepts Claude Code CLI stop/notify hook pings.

use crate::paths;
use crate::settings;
use crate::state::AppState;
use crate::types::Settings;
use anyhow::Result;
use axum::{extract::State as AxState, routing::post, Json, Router};
use serde::Deserialize;
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;

#[derive(Clone)]
struct HookCtx { app: AppHandle }

#[derive(Deserialize, Debug)]
struct HookPayload {
    #[serde(default)]
    event: String,
    #[serde(default)]
    project: String,
}

async fn on_hook(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(payload): Json<HookPayload>,
) -> Json<serde_json::Value> {
    log::info!("hook received: event={} project={}", payload.event, payload.project);
    let _ = ctx.app.emit(
        "hook-ping",
        json!({ "event": payload.event, "project": payload.project }),
    );
    Json(json!({"ok": true}))
}

pub async fn spawn(app: AppHandle) -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    log::info!("hook server listening on 127.0.0.1:{port}");

    // Persist port to settings for hook client discovery.
    {
        let state = app.state::<AppState>();
        let mut s: Settings = state.settings.lock().unwrap().clone();
        s.hook_port = Some(port);
        *state.settings.lock().unwrap() = s.clone();
        let path = paths::settings_file()?;
        let _ = settings::save(&path, &s);
        let _ = app.emit("settings-changed", s);
    }

    let ctx = Arc::new(HookCtx { app: app.clone() });
    let router = Router::new()
        .route("/hook", post(on_hook))
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
