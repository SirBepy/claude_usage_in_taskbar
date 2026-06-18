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
    "load_history_page",
    "list_characters",
    "list_project_groups",
];

/// Start the remote-access server. Best-effort: a bind failure disables remote
/// access for this run but never takes down the daemon. Call once at startup.
pub fn spawn(state: Arc<DaemonState>, app_data: PathBuf, router: crate::daemon::rpc::Router) {
    ensure_token(&app_data);
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
        let ctx = Arc::new(RemoteCtx { state, app_data, router });
        let app = build_router(ctx);
        log::info!(
            "remote-access server listening on 127.0.0.1:{REMOTE_PORT} (expose with `tailscale serve --bg --https=443 http://127.0.0.1:{REMOTE_PORT}`)"
        );
        if let Err(e) = axum::serve(listener, app).await {
            log::error!("remote-access server exited: {e}");
        }
    });
}

fn build_router(ctx: Arc<RemoteCtx>) -> Router {
    // Data routes require a valid bearer token (checked before any extractor
    // runs, so a malformed body can't reach a handler unauthenticated).
    let protected = Router::new()
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/:id/send", post(send_message))
        .route("/api/sessions/:id/cancel", post(cancel_turn))
        .route("/api/rpc", post(rpc_dispatch))
        .route_layer(middleware::from_fn_with_state(ctx.clone(), auth_mw));

    // /api/health is unauthenticated (connectivity probe, reveals nothing).
    // The WS stream self-authenticates via its query token in the handler.
    // Static SPA assets are served unauthenticated (no secrets in them; the
    // SPA JS authenticates every /api call with the bearer token).
    // The fallback only fires when no named route matches, so /api/* and the
    // WS route above are never shadowed by it.
    let public = Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/sessions/:id/stream", get(stream_ws));

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

fn token_hash_file(app_data: &Path) -> PathBuf {
    app_data.join("remote-access.json")
}

/// The stored SHA-256 hex of the valid token, or None if remote access has not
/// been provisioned (fail-closed: callers treat None as "deny all").
fn stored_token_hash(app_data: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(token_hash_file(app_data)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("hash").and_then(|h| h.as_str()).map(str::to_string)
}

fn token_is_valid(presented: &str, app_data: &Path) -> bool {
    match stored_token_hash(app_data) {
        Some(expected) => sha256_hex(presented) == expected,
        None => false,
    }
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
    let ok = bearer_token(req.headers())
        .map(|t| token_is_valid(&t, &ctx.app_data))
        .unwrap_or(false);
    if ok {
        next.run(req).await
    } else {
        StatusCode::UNAUTHORIZED.into_response()
    }
}

/// On first run, mint a token, store only its hash, and write the plaintext to
/// a one-time handoff file for the user to copy (then delete). Idempotent: a
/// no-op once a hash exists. Phase 2 (QR pairing) replaces this handoff.
fn ensure_token(app_data: &Path) {
    if stored_token_hash(app_data).is_some() {
        return;
    }
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let hash = sha256_hex(&token);
    let body = serde_json::json!({ "hash": hash });
    if let Err(e) = std::fs::write(
        token_hash_file(app_data),
        serde_json::to_string_pretty(&body).unwrap_or_default(),
    ) {
        log::error!("remote-access: failed to write token hash file: {e}");
        return;
    }
    let handoff = app_data.join("remote-access-token.txt");
    let _ = std::fs::write(&handoff, format!("{token}\n"));
    log::info!(
        "remote-access: generated a token; plaintext written to {handoff:?} - copy it into the phone client, then DELETE that file. Only its hash is stored."
    );
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
    if !token_is_valid(&q.token, &ctx.app_data) {
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
    fn token_validation_is_fail_closed_without_a_hash_file() {
        let dir = tempdir().unwrap();
        // No remote-access.json provisioned -> every token is rejected.
        assert!(!token_is_valid("anything", dir.path()));
        assert!(stored_token_hash(dir.path()).is_none());
    }

    #[test]
    fn token_validation_matches_only_the_provisioned_token() {
        let dir = tempdir().unwrap();
        let secret = "s3cr3t-token";
        let body = serde_json::json!({ "hash": sha256_hex(secret) });
        std::fs::write(token_hash_file(dir.path()), body.to_string()).unwrap();
        assert!(token_is_valid(secret, dir.path()));
        assert!(!token_is_valid("wrong", dir.path()));
        assert!(!token_is_valid("", dir.path()));
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
            "list_characters",
            "list_project_groups",
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

    #[test]
    fn ensure_token_writes_only_the_hash_and_is_idempotent() {
        let dir = tempdir().unwrap();
        ensure_token(dir.path());
        let hash1 = stored_token_hash(dir.path()).expect("hash written");
        // The one-time handoff plaintext is a valid token for the stored hash...
        let plaintext = std::fs::read_to_string(dir.path().join("remote-access-token.txt")).unwrap();
        assert!(token_is_valid(plaintext.trim(), dir.path()));
        // ...and the stored file holds the hash, not the plaintext.
        let stored = std::fs::read_to_string(token_hash_file(dir.path())).unwrap();
        assert!(!stored.contains(plaintext.trim()));
        // Idempotent: a second call must not rotate an existing token.
        ensure_token(dir.path());
        assert_eq!(stored_token_hash(dir.path()).unwrap(), hash1);
    }
}
