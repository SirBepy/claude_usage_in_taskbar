//! Local HTTP server that accepts Claude Code CLI stop/notify/quit hook pings
//! and records token stats into `token-history.json`.

use crate::settings::paths;
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
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
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

#[derive(Deserialize, Debug, Default)]
struct StopPayload {
    #[serde(default)] pub session_id: Option<String>,
    #[serde(default)] pub transcript_path: Option<String>,
    #[serde(default)] pub cwd: Option<String>,
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

    // Backfill instance name on /refresh too — covers the case
    // where the SessionStart-time poll missed the first prompt.
    if let (Some(session_id), Some(transcript_path)) =
        (payload.session_id.clone(), payload.transcript_path.clone())
    {
        let app = ctx.app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            if let Some(inst) = state.instances.get(&session_id) {
                if inst.name.is_some() { return }
            } else {
                return;
            }
            let path = std::path::PathBuf::from(transcript_path);
            let Some(name) = tauri::async_runtime::spawn_blocking(move || {
                crate::tokens::first_user_prompt(&path, 60)
            })
            .await
            .ok()
            .flatten() else { return };
            let state = app.state::<AppState>();
            if state.instances.set_name(&session_id, name) {
                let _ = app.emit("instances-changed", state.instances.list());
            }
        });
    }

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
            (crate::sessions::kinds::InstanceKind::Automated, true)
        } else {
            (crate::sessions::kinds::InstanceKind::External, false)
        }
    };

    let transcript_path_buf = payload.transcript_path.clone().map(std::path::PathBuf::from);
    let input = crate::sessions::registry::RegisterInput {
        session_id: payload.session_id.clone(),
        cwd: std::path::PathBuf::from(cwd),
        pid: payload.pid.unwrap_or(0),
        kind,
        is_remote,
        transcript_path: transcript_path_buf.clone(),
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

    // Background enrichment: resolve pid + bridgeSessionId via
    // ~/.claude/sessions/*.json (Claude Code v2.x stopped sending pid
    // in the hook payload), and pull a friendly name from the
    // transcript's first user prompt.
    let h = ctx.app.clone();
    let sid = payload.session_id.clone();
    let payload_pid = payload.pid;
    let transcript_path_opt = transcript_path_buf;
    tauri::async_runtime::spawn(async move {
        let mut changed = false;
        let s = h.state::<AppState>();

        if payload_pid.is_none() || payload_pid == Some(0) {
            if let Some(meta) = crate::hooks::resolve_session_meta(&sid).await {
                if s.instances.set_pid(&sid, meta.pid) { changed = true; }
                if let Some(bridge) = meta.bridge_session_id {
                    s.instances.set_bridge_session_id(&sid, bridge);
                    changed = true;
                }
            }
        } else if let Some(pid) = payload_pid {
            if let Some(bridge) = crate::hooks::resolve_bridge_session_id(pid).await {
                s.instances.set_bridge_session_id(&sid, bridge);
                changed = true;
            }
        }

        if let Some(path) = transcript_path_opt {
            if let Some(name) = poll_first_user_prompt(&path).await {
                if s.instances.set_name(&sid, name) { changed = true; }
            }
        }

        if changed {
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
    // Skip Interactive sessions (Path C). Each `claude -p` turn fires
    // SessionStart on spawn and SessionEnd on exit; treating that as the
    // session lifecycle would mark our Interactive entry ended after the
    // first turn, dropping it from the live sidebar. Interactive lifecycle
    // is owned by the chat IPC layer (start_session / cancel_turn /
    // app-quit cleanup).
    let kind = state.instances.get(&payload.session_id).map(|i| i.kind);
    if kind == Some(crate::sessions::kinds::InstanceKind::Interactive) {
        log::debug!("ignoring SessionEnd for Interactive session {}", payload.session_id);
        return StatusCode::NO_CONTENT;
    }
    if state.instances.mark_ended(&payload.session_id, crate::types::EndReason::HookSessionEnd, &now) {
        let _ = ctx.app.emit("instances-changed", state.instances.list());
    }
    StatusCode::NO_CONTENT
}

async fn on_stop(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(payload): Json<StopPayload>,
) -> impl IntoResponse {
    log::info!(
        "hook /hooks/stop: session={} cwd={} transcript={}",
        payload.session_id.as_deref().unwrap_or("-"),
        payload.cwd.as_deref().unwrap_or("-"),
        payload.transcript_path.as_deref().unwrap_or("-"),
    );

    let Some(transcript_path) = payload.transcript_path.clone() else {
        return (StatusCode::OK, Json(json!({"ok": true, "reason": "no transcript"})));
    };
    let Some(session_id) = payload.session_id.clone() else {
        return (StatusCode::OK, Json(json!({"ok": true, "reason": "no session_id"})));
    };

    let app = ctx.app.clone();
    tauri::async_runtime::spawn(async move {
        let dir = match crate::settings::paths::skill_usage_dir() {
            Ok(d) => d,
            Err(e) => { log::warn!("skill_usage_dir failed: {e}"); return; }
        };
        let transcript = PathBuf::from(transcript_path);
        let events = tauri::async_runtime::spawn_blocking(move || {
            crate::skill_usage::parser::parse_transcript(&transcript)
        })
        .await
        .unwrap_or_default();

        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        if let Err(e) = crate::skill_usage::store::mark_session(&dir, &session_id, &today) {
            log::warn!("mark_session failed: {e}");
        }
        if !events.is_empty() {
            if let Err(e) = crate::skill_usage::store::append_events(&dir, &events) {
                log::warn!("append_events failed: {e}");
            }
        }
        let _ = app.emit("skill-usage-changed", json!({}));
    });

    (StatusCode::OK, Json(json!({"ok": true})))
}

/// Polls the transcript for the first real user prompt. Fresh
/// sessions start before the user types anything, so we retry up
/// to ~30s × 1s. Returns None if the transcript never gets a real
/// user message in that window (the next /refresh hook will retry).
async fn poll_first_user_prompt(path: &std::path::Path) -> Option<String> {
    let path = path.to_path_buf();
    for _ in 0..30 {
        let p = path.clone();
        let found = tauri::async_runtime::spawn_blocking(move || {
            crate::tokens::first_user_prompt(&p, 60)
        })
        .await
        .ok()
        .flatten();
        if let Some(name) = found { return Some(name); }
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    }
    None
}

// ─── Permission / question relay ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct PermRequestBody {
    id: String,
    tool_name: String,
    input: Value,
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(Deserialize)]
struct PermRespondBody {
    id: String,
    behavior: String,
    #[serde(default)]
    updated_input: Option<Value>,
}

#[derive(Deserialize)]
struct QuestRequestBody {
    id: String,
    questions: Value,
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(Deserialize)]
struct QuestRespondBody {
    id: String,
    answers: Value,
}

async fn on_permission_request(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(body): Json<PermRequestBody>,
) -> impl IntoResponse {
    let state = ctx.app.state::<AppState>();
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    {
        let mut pending = state.pending.lock().await;
        pending.insert(body.id.clone(), tx);
    }
    let _ = ctx.app.emit(
        "permission-requested",
        json!({
            "id": body.id,
            "tool_name": body.tool_name,
            "input": body.input,
            "session_id": body.session_id,
        }),
    );
    match tokio::time::timeout(Duration::from_secs(300), rx).await {
        Ok(Ok(val)) => (StatusCode::OK, Json(val)),
        _ => {
            state.pending.lock().await.remove(&body.id);
            (StatusCode::OK, Json(json!({"behavior": "deny", "message": "user did not respond in time"})))
        }
    }
}

async fn on_permission_respond(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(body): Json<PermRespondBody>,
) -> impl IntoResponse {
    let state = ctx.app.state::<AppState>();
    let tx = state.pending.lock().await.remove(&body.id);
    if let Some(tx) = tx {
        let val = json!({"behavior": body.behavior, "updatedInput": body.updated_input});
        let _ = tx.send(val);
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}

async fn on_question_request(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(body): Json<QuestRequestBody>,
) -> impl IntoResponse {
    let state = ctx.app.state::<AppState>();
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    {
        let mut pending = state.pending.lock().await;
        pending.insert(body.id.clone(), tx);
    }
    let _ = ctx.app.emit(
        "question-requested",
        json!({
            "id": body.id,
            "questions": body.questions,
            "session_id": body.session_id,
        }),
    );
    match tokio::time::timeout(Duration::from_secs(300), rx).await {
        Ok(Ok(val)) => (StatusCode::OK, Json(val)),
        _ => {
            state.pending.lock().await.remove(&body.id);
            (StatusCode::OK, Json(json!({"answers": {}})))
        }
    }
}

async fn on_question_respond(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(body): Json<QuestRespondBody>,
) -> impl IntoResponse {
    let state = ctx.app.state::<AppState>();
    let tx = state.pending.lock().await.remove(&body.id);
    if let Some(tx) = tx {
        let _ = tx.send(json!({"answers": body.answers}));
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
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

    // Write hooks_port.txt so the MCP server subprocess can discover the port.
    if let Ok(port_file) = paths::hooks_port_file() {
        let _ = std::fs::write(&port_file, port.to_string());
    }

    let ctx = Arc::new(HookCtx { app: app.clone() });
    let router = Router::new()
        .route("/refresh", post(on_refresh))
        .route("/notify", post(on_notify))
        .route("/quit", post(on_quit))
        .route("/hooks/session-start", post(on_session_start))
        .route("/hooks/session-end", post(on_session_end))
        .route("/hooks/stop", post(on_stop))
        .route("/permissions/request", post(on_permission_request))
        .route("/permissions/respond", post(on_permission_respond))
        .route("/questions/request", post(on_question_request))
        .route("/questions/respond", post(on_question_respond))
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

#[cfg(test)]
mod tests {
    //! Booting the on_session_start axum handler requires a full Tauri
    //! AppHandle (the handler reaches into AppState for `instances` and
    //! `channels` and also emits Tauri events). Standing up a mock
    //! AppHandle inside a unit test is out of scope. Instead, we mirror
    //! the handler's flow against the same `Registry` API the handler
    //! invokes, asserting the SessionStart -> register write happens.
    //! See `tests/hook_server_instances.rs` for the same approach.
    use crate::sessions::kinds::InstanceKind;
    use crate::sessions::registry::{Registry, RegisterInput};
    use crate::types::Settings;
    use std::path::PathBuf;
    use std::sync::Mutex;

    #[tokio::test]
    async fn session_start_hook_writes_to_sessions_registry() {
        let registry = Registry::new();
        let settings = Mutex::new(Settings::default());
        let now = "2026-05-08T00:00:00Z";

        // Mirror the on_session_start handler's RegisterInput
        // construction (External path; no matching channel pid).
        let input = RegisterInput {
            session_id: "sess-abc".into(),
            cwd: PathBuf::from("C:/proj"),
            pid: 4242,
            kind: InstanceKind::External,
            is_remote: false,
            transcript_path: None,
            started_at: now.into(),
        };

        let (_project_id, created_new) = registry.register(input, &settings, now);
        assert!(created_new, "session-start should create a new instance");
        let listed = registry.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].session_id, "sess-abc");
        assert_eq!(listed[0].pid, 4242);
        assert_eq!(listed[0].kind, InstanceKind::External);
    }
}
