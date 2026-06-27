//! Remote-access server: the daemon-side HTTP/WS API that a phone (or any
//! browser on the tailnet) uses to drive in-app chats. This is the Phase 1
//! vertical slice of the "remote phone cockpit" (see ai_todo 103 + the design
//! spec). SECURITY-CRITICAL: every authed route can send input to a `claude`
//! process that holds Bash/Edit/Read tools, so a bypass here is RCE.
//!
//! Security boundary (review this):
//!   1. Binds 127.0.0.1 ONLY (never 0.0.0.0). It is NOT internet-reachable on
//!      its own; remote access is opt-in by the user running `tailscale serve`
//!      to reverse-proxy it over the tailnet with Tailscale-managed HTTPS.
//!   2. Per-request bearer-token auth on every data route (defense in depth on
//!      top of the tailnet). The token's SHA-256 hash is stored in a
//!      daemon-owned file; the plaintext is never persisted by the server
//!      except the one-time bootstrap handoff file the user copies + deletes.
//!   3. Fail-closed: if no token hash exists, every authed route returns 401.
//!   4. WebSocket auth uses a `?token=` query param (browsers cannot set the
//!      Authorization header on a WS handshake); validated identically before
//!      the upgrade completes.
//!
//! Token bootstrap is intentionally minimal for Phase 1 (manual token). QR
//! pairing + a device registry + rotation/kill-switch UI are Phase 2 (ai_todo
//! 104); they will write the same hash file.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path as AxPath, Query, Request, State,
    },
    http::{header, header::AUTHORIZATION, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rust_embed::RustEmbed;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::sync::broadcast::error::RecvError;

use crate::daemon::device_registry::DeviceRegistry;
use crate::daemon::session::Session;
use crate::daemon::state::DaemonState;

/// The compiled frontend SPA, embedded at compile time from `../dist` (the vite
/// build output). `$CARGO_MANIFEST_DIR` resolves to `src-tauri/`, so the path
/// reaches the repo-root `dist/` directory.
///
/// The SPA HTML/JS/CSS are served UNAUTHENTICATED: they contain no secrets and
/// the SPA JS authenticates every `/api` call with the bearer token the user
/// pastes in once. `/api/*` routes stay token-gated by `auth_mw` as before.
#[derive(RustEmbed)]
#[folder = "../dist"]
struct Assets;

/// Fixed localhost port for the remote API. Stable so the user's
/// `tailscale serve` config can target it. Distinct from the hook port (27182).
pub const REMOTE_PORT: u16 = 27183;

struct RemoteCtx {
    state: Arc<DaemonState>,
    app_data: PathBuf,
    router: crate::daemon::rpc::Router,
    stt: Arc<crate::daemon::stt::SttSupervisor>,
}

/// Daemon RPC methods the remote client may invoke via `POST /api/rpc`. This is
/// the load-bearing security allowlist: anything NOT here is 403, so adding a
/// method is a deliberate, reviewable act. Deliberately EXCLUDED: `shutdown_daemon`,
/// `set_settings` (could disable security), all `*_channel` (automation/bridge
/// control), `end_session`, and the streaming methods `attach_session` /
/// `detach_session` / `subscribe_global` (connection-scoped; the WS endpoint
/// handles streaming instead). See the test below.
const SAFE_METHODS: &[&str] = &[
    "list_instances",
    "list_pending_prompts",
    "start_session",
    "send_message",
    "cancel_turn",
    "respond_permission",
    "respond_question",
    "set_session_effort",
    "set_auto_accept",
    "list_auto_accept",
    "load_history_page",
    "read_attachment",
    // Write: phone composer paperclip upload. Bytes land in the path-validated
    // chat-attachments dir (write_attachment rejects path-traversal session ids),
    // so this is not an arbitrary-write primitive.
    "paste_attachment",
    "list_characters",
    "list_project_groups",
    "character_asset_url",
    "resolve_whitelist_characters",
    "list_session_characters",
    "list_projects",
    "project_last_activity_at",
    "get_project_tech",
    "get_project_icon",
    // Read-only usage/token history for the remote homescreen + statistics.
    "get_history",
    "get_token_history",
    "get_active_sessions",
    // Visual settings (theme, colors) so the phone mirrors the desktop appearance.
    // set_settings is deliberately NOT here (phone must not mutate desktop settings).
    "get_settings",
];

/// Start the remote-access server. Best-effort: a bind failure disables remote
/// access for this run but never takes down the daemon. Call once at startup.
///
/// Returns the STT sidecar supervisor so the daemon main loop can drive its
/// idle-shutdown tick and kill it on graceful exit.
pub fn spawn(
    state: Arc<DaemonState>,
    app_data: PathBuf,
    router: crate::daemon::rpc::Router,
) -> Arc<crate::daemon::stt::SttSupervisor> {
    DeviceRegistry::ensure_desktop_device(&app_data);
    let stt = crate::daemon::stt::SttSupervisor::new(app_data.clone());
    let stt_for_task = stt.clone();
    tokio::spawn(async move {
        let listener = match TcpListener::bind(("127.0.0.1", REMOTE_PORT)).await {
            Ok(l) => l,
            Err(e) => {
                log::warn!(
                    "remote-access server: bind 127.0.0.1:{REMOTE_PORT} failed: {e}; remote access disabled this run"
                );
                return;
            }
        };
        // Strip the inherit flag so this socket never leaks into daemon-spawned
        // children (piped stdio forces handle inheritance on Windows). Without
        // this, an orphaned child holds 27183 after the daemon dies and every
        // request hangs with no response - the port-hostage incident, here for
        // the remote port. Mirrors the hook listener's protection.
        crate::util::process::mark_listener_non_inheritable(&listener);
        let ctx = Arc::new(RemoteCtx { state, app_data, router, stt: stt_for_task });
        let app = build_router(ctx);
        log::info!(
            "remote-access server listening on 127.0.0.1:{REMOTE_PORT} (expose with `tailscale serve --bg --https=443 http://127.0.0.1:{REMOTE_PORT}`)"
        );
        if let Err(e) = axum::serve(listener, app).await {
            log::error!("remote-access server exited: {e}");
        }
    });
    stt
}

fn build_router(ctx: Arc<RemoteCtx>) -> Router {
    // Data routes require a valid bearer token (checked before any extractor
    // runs, so a malformed body can't reach a handler unauthenticated).
    let protected = Router::new()
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/:id/send", post(send_message))
        .route("/api/sessions/:id/cancel", post(cancel_turn))
        .route("/api/rpc", post(rpc_dispatch))
        // Web Push enrolment (ai_todo 119). Token-gated like the rest.
        .route("/api/push/vapid-public-key", get(push_vapid_key))
        .route("/api/push/subscribe", post(push_subscribe))
        .route("/api/push/unsubscribe", post(push_unsubscribe))
        .route_layer(middleware::from_fn_with_state(ctx.clone(), auth_mw));

    // /api/health is unauthenticated (connectivity probe, reveals nothing).
    // The WS stream self-authenticates via its query token in the handler.
    // Static SPA assets are served unauthenticated (no secrets in them; the
    // SPA JS authenticates every /api call with the bearer token).
    // The fallback only fires when no named route matches, so /api/* and the
    // WS route above are never shadowed by it.
    let public = Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/pair", post(pair_device))
        .route("/api/sessions/:id/stream", get(stream_ws))
        .route("/ws/transcribe", get(transcribe_ws));

    protected
        .merge(public)
        .fallback(spa_fallback)
        .with_state(ctx)
}

// ── Auth ────────────────────────────────────────────────────────────────────

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::to_string)
}

/// Auth middleware for the protected routes. Runs before request extractors.
async fn auth_mw(State(ctx): State<Arc<RemoteCtx>>, req: Request, next: Next) -> Response {
    if !DeviceRegistry::is_enabled(&ctx.app_data) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let ok = bearer_token(req.headers())
        .map(|t| DeviceRegistry::validate_token(&t, &ctx.app_data))
        .unwrap_or(false);
    if ok {
        next.run(req).await
    } else {
        StatusCode::UNAUTHORIZED.into_response()
    }
}

fn pairing_file(app_data: &Path) -> PathBuf {
    app_data.join("remote-pairing.json")
}

/// Validate a one-time pairing code against remote-pairing.json.
/// On success, deletes the file (single-use). Returns Err with reason on failure.
fn validate_pairing_code(code: &str, app_data: &Path) -> Result<(), &'static str> {
    let raw = std::fs::read_to_string(pairing_file(app_data))
        .map_err(|_| "no active pairing code")?;
    let v: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| "malformed pairing file")?;

    let expected_hash = v.get("code_hash").and_then(|h| h.as_str()).unwrap_or("");
    let expires_at = v.get("expires_at").and_then(|e| e.as_u64()).unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    if now > expires_at {
        let _ = std::fs::remove_file(pairing_file(app_data));
        return Err("pairing code expired");
    }
    if sha256_hex(code) != expected_hash {
        return Err("invalid pairing code");
    }
    let _ = std::fs::remove_file(pairing_file(app_data));
    Ok(())
}

// ── Push notifications (ai_todo 119) ─────────────────────────────────────────

/// The VAPID public key the phone needs as its `applicationServerKey`.
async fn push_vapid_key(State(ctx): State<Arc<RemoteCtx>>) -> Response {
    match ctx.state.push.get() {
        Some(pm) => Json(serde_json::json!({ "key": pm.vapid_public() })).into_response(),
        None => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

/// Register a phone's Web Push subscription (body = `subscription.toJSON()`).
async fn push_subscribe(
    State(ctx): State<Arc<RemoteCtx>>,
    Json(sub): Json<crate::daemon::push::PushSubscription>,
) -> StatusCode {
    match ctx.state.push.get() {
        Some(pm) => {
            pm.subscribe(sub);
            StatusCode::NO_CONTENT
        }
        None => StatusCode::SERVICE_UNAVAILABLE,
    }
}

#[derive(Deserialize)]
struct UnsubscribeBody {
    endpoint: String,
}

/// Drop a phone's subscription (on disable / re-pair).
async fn push_unsubscribe(
    State(ctx): State<Arc<RemoteCtx>>,
    Json(body): Json<UnsubscribeBody>,
) -> StatusCode {
    match ctx.state.push.get() {
        Some(pm) => {
            pm.unsubscribe(&body.endpoint);
            StatusCode::NO_CONTENT
        }
        None => StatusCode::SERVICE_UNAVAILABLE,
    }
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async fn list_sessions(State(ctx): State<Arc<RemoteCtx>>) -> Response {
    Json(ctx.state.registry.list()).into_response()
}

/// SPA fallback: serves the embedded frontend bundle for any path that does not
/// match a named API route. Handles two cases:
///   1. A real asset path (JS, CSS, fonts, icons) - serve it with the correct
///      Content-Type derived from the file extension.
///   2. A client-side route (anything that doesn't map to a file) - serve
///      `index.html` so the SPA router takes over (SPA fallback pattern).
///
/// Path sanitization prevents directory traversal: requests with `..` or a
/// backslash are rejected with 404 before any embed lookup.
async fn spa_fallback(req: axum::extract::Request) -> Response {
    let raw = req.uri().path();
    // Strip leading slash to match rust-embed keys (e.g. "/assets/main.js" -> "assets/main.js").
    let path = raw.trim_start_matches('/');

    // Defense-in-depth: reject traversal attempts.
    if path.contains("..") || path.contains('\\') {
        return StatusCode::NOT_FOUND.into_response();
    }

    // Serve the real asset if it exists, otherwise fall back to index.html for
    // SPA client-side routing.
    let (asset_path, is_fallback) = if path.is_empty() {
        ("index.html", true)
    } else {
        match Assets::get(path) {
            Some(_) => (path, false),
            None => ("index.html", true),
        }
    };
    let _ = is_fallback; // used implicitly via asset_path selection

    match Assets::get(asset_path) {
        Some(content) => {
            let mime = mime_guess::from_path(asset_path)
                .first_or_octet_stream()
                .to_string();
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, mime)],
                content.data,
            )
                .into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Deserialize)]
struct SendBody {
    text: String,
}

async fn send_message(
    State(ctx): State<Arc<RemoteCtx>>,
    AxPath(id): AxPath<String>,
    Json(body): Json<SendBody>,
) -> Response {
    let Some(session) = ctx.state.sessions.get(&id).map(|s| s.clone()) else {
        return (StatusCode::NOT_FOUND, "no such session").into_response();
    };
    match crate::daemon::lifecycle::send_message(&session, &body.text).await {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn cancel_turn(
    State(ctx): State<Arc<RemoteCtx>>,
    AxPath(id): AxPath<String>,
) -> Response {
    match crate::daemon::lifecycle::cancel_turn(&ctx.state.sessions, &id).await {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct RpcBody {
    method: String,
    #[serde(default)]
    params: Option<serde_json::Value>,
}

/// Generic command dispatch: forwards an allowlisted daemon RPC method to the
/// shared router. This is how the phone runs the real SPA (its transport calls
/// commands by name). A throwaway ConnectionContext is fine because every
/// allowlisted method is request/response - streaming methods are excluded and
/// served by the WS endpoint instead.
async fn rpc_dispatch(State(ctx): State<Arc<RemoteCtx>>, Json(body): Json<RpcBody>) -> Response {
    if !SAFE_METHODS.contains(&body.method.as_str()) {
        return (
            StatusCode::FORBIDDEN,
            format!("method not allowed remotely: {}", body.method),
        )
            .into_response();
    }
    let (tx, _rx) = tokio::sync::mpsc::channel(16);
    let conn = crate::daemon::rpc::ConnectionContext::new(tx);
    let req = crate::daemon::rpc::Request {
        jsonrpc: "2.0".into(),
        id: serde_json::json!(0),
        method: body.method,
        params: body.params,
    };
    let resp = ctx.router.dispatch(req, conn).await;
    match resp.error {
        Some(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(err)).into_response(),
        None => Json(resp.result.unwrap_or(serde_json::Value::Null)).into_response(),
    }
}

#[derive(Deserialize)]
struct StreamQuery {
    token: String,
}

async fn stream_ws(
    State(ctx): State<Arc<RemoteCtx>>,
    AxPath(id): AxPath<String>,
    Query(q): Query<StreamQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if !DeviceRegistry::validate_token(&q.token, &ctx.app_data) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(session) = ctx.state.sessions.get(&id).map(|s| s.clone()) else {
        return (StatusCode::NOT_FOUND, "no such session").into_response();
    };
    ws.on_upgrade(move |socket| pump_events(socket, session))
}

/// Forward a session's live ChatEvent broadcast to the WebSocket client until
/// either side closes. Mirrors what the desktop Tauri event stream delivers, so
/// a phone client sees the same turns stream in real time.
async fn pump_events(mut socket: WebSocket, session: Arc<Session>) {
    let mut rx = crate::daemon::broadcast::subscribe(&session);
    loop {
        tokio::select! {
            recv = rx.recv() => match recv {
                Ok(ev) => {
                    let txt = match serde_json::to_string(&ev) {
                        Ok(t) => t,
                        Err(_) => continue,
                    };
                    if socket.send(Message::Text(txt)).await.is_err() {
                        break; // client gone
                    }
                }
                Err(RecvError::Lagged(_)) => continue, // dropped frames under load; keep going
                Err(RecvError::Closed) => break,       // session ended
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(_)) => {}      // ignore client->server frames for now
                _ => break,            // client closed or errored
            },
        }
    }
}

/// Authed entry to the voice transcription pipe. Self-authenticates via the
/// `?token=` query (browsers cannot set the Authorization header on a WS
/// handshake) exactly like `stream_ws`, ensures the Python STT sidecar is
/// running, then upgrades and dumb-relays frames browser<->sidecar.
async fn transcribe_ws(
    State(ctx): State<Arc<RemoteCtx>>,
    Query(q): Query<StreamQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if !DeviceRegistry::validate_token(&q.token, &ctx.app_data) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if let Err(e) = ctx.stt.ensure_running().await {
        log::error!("stt ensure_running: {e}");
        return (StatusCode::SERVICE_UNAVAILABLE, "voice engine unavailable").into_response();
    }
    let stt = ctx.stt.clone();
    ws.on_upgrade(move |socket| relay_transcribe(socket, stt))
}

/// Dumb bidirectional relay between the browser axum WebSocket and a
/// tokio-tungstenite client WS to the localhost STT sidecar. Binary PCM goes
/// up; JSON transcript frames come down. Closes when either side closes.
async fn relay_transcribe(
    browser: WebSocket,
    stt: Arc<crate::daemon::stt::SttSupervisor>,
) {
    use axum::extract::ws::Message as AxMsg;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as TgMsg;

    stt.on_connect();
    // Brief retry so the freshly-spawned sidecar has time to bind its socket.
    let url = format!("ws://127.0.0.1:{}", crate::daemon::stt::SIDECAR_PORT);
    let mut sidecar = None;
    for _ in 0..50 {
        if let Ok((s, _)) = tokio_tungstenite::connect_async(&url).await {
            sidecar = Some(s);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    let Some(sidecar) = sidecar else {
        let _ = browser;
        stt.on_disconnect().await;
        return;
    };

    let (mut b_tx, mut b_rx) = browser.split();
    let (mut s_tx, mut s_rx) = sidecar.split();

    // browser -> sidecar (binary PCM + text control)
    let up = async {
        while let Some(Ok(msg)) = b_rx.next().await {
            let out = match msg {
                AxMsg::Binary(b) => TgMsg::Binary(b),
                AxMsg::Text(t) => TgMsg::Text(t),
                AxMsg::Close(_) => break,
                _ => continue,
            };
            if s_tx.send(out).await.is_err() {
                break;
            }
        }
    };
    // sidecar -> browser (JSON results)
    let down = async {
        while let Some(Ok(msg)) = s_rx.next().await {
            let out = match msg {
                TgMsg::Text(t) => AxMsg::Text(t),
                TgMsg::Binary(b) => AxMsg::Binary(b),
                TgMsg::Close(_) => break,
                _ => continue,
            };
            if b_tx.send(out).await.is_err() {
                break;
            }
        }
    };
    tokio::select! { _ = up => {}, _ = down => {} }
    stt.on_disconnect().await;
}

#[derive(Deserialize)]
struct PairBody {
    pairing_code: String,
    device_name: Option<String>,
}

async fn pair_device(
    State(ctx): State<Arc<RemoteCtx>>,
    Json(body): Json<PairBody>,
) -> Response {
    if !DeviceRegistry::is_enabled(&ctx.app_data) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if let Err(reason) = validate_pairing_code(&body.pairing_code, &ctx.app_data) {
        return (StatusCode::BAD_REQUEST, reason).into_response();
    }
    let name = body.device_name.unwrap_or_else(|| "Phone".to_string());
    match DeviceRegistry::add_device(&name, &ctx.app_data) {
        Ok(token) => Json(serde_json::json!({ "device_token": token })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn sha256_hex_matches_known_vector() {
        assert_eq!(
            sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn pair_device_validates_code_hash_and_ttl() {
        let dir = tempdir().unwrap();
        let code = "abc123testcode";
        let hash = sha256_hex(code);
        let expires_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() + 120;
        let body = serde_json::json!({ "code_hash": hash, "expires_at": expires_at });
        std::fs::write(dir.path().join("remote-pairing.json"), body.to_string()).unwrap();

        let result = validate_pairing_code(code, dir.path());
        assert!(result.is_ok());
        assert!(!dir.path().join("remote-pairing.json").exists());

        let result2 = validate_pairing_code(code, dir.path());
        assert!(result2.is_err());
    }

    #[test]
    fn pair_device_rejects_expired_code() {
        let dir = tempdir().unwrap();
        let code = "expiredcode";
        let body = serde_json::json!({
            "code_hash": sha256_hex(code),
            "expires_at": 1u64
        });
        std::fs::write(dir.path().join("remote-pairing.json"), body.to_string()).unwrap();
        assert!(validate_pairing_code(code, dir.path()).is_err());
    }

    #[test]
    fn pair_device_rejects_wrong_code() {
        let dir = tempdir().unwrap();
        let real_code = "realcode";
        let expires_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() + 120;
        let body = serde_json::json!({ "code_hash": sha256_hex(real_code), "expires_at": expires_at });
        std::fs::write(dir.path().join("remote-pairing.json"), body.to_string()).unwrap();
        assert!(validate_pairing_code("wrongcode", dir.path()).is_err());
        assert!(dir.path().join("remote-pairing.json").exists());
    }

    #[test]
    fn allowlist_excludes_dangerous_methods() {
        for m in [
            "shutdown_daemon",
            "set_settings",
            "start_channel",
            "stop_channel",
            "restart_channel",
            "show_channel",
            "hide_channel",
            "end_session",
            "attach_session",
            "detach_session",
            "subscribe_global",
            "externalize_session",
            "takeover_manual",
        ] {
            assert!(
                !SAFE_METHODS.contains(&m),
                "{m} must NOT be remotely callable"
            );
        }
    }

    #[test]
    fn allowlist_includes_core_chat_methods() {
        for m in [
            "list_instances",
            "send_message",
            "cancel_turn",
            "respond_question",
            "respond_permission",
            "load_history_page",
            "read_attachment",
            "paste_attachment",
            "list_characters",
            "list_project_groups",
            "character_asset_url",
            "resolve_whitelist_characters",
            "list_projects",
            "project_last_activity_at",
            "get_project_tech",
            "get_project_icon",
            "get_history",
            "get_token_history",
            "get_active_sessions",
        ] {
            assert!(SAFE_METHODS.contains(&m), "{m} should be remotely callable");
        }
    }

    #[test]
    fn spa_assets_embed_index_html() {
        // Verifies that the rust-embed compile-time embedding captured the real
        // frontend build. If dist/ was absent at compile time this will be None.
        assert!(
            Assets::get("index.html").is_some(),
            "index.html not found in embedded assets - run `pnpm build` before `cargo build`"
        );
    }

}
