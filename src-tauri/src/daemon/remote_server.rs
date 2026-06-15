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
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::sync::broadcast::error::RecvError;

use crate::daemon::session::Session;
use crate::daemon::state::DaemonState;

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
    let public = Router::new()
        .route("/", get(index_page))
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/sessions/:id/stream", get(stream_ws));

    protected.merge(public).with_state(ctx)
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

/// Minimal self-contained remote console (Phase 1 v0). Unauthenticated HTML
/// (no secrets in it); its in-page JS authenticates every API call with the
/// token the user pastes. Uses only the explicit REST/WS routes - NOT the
/// shared SPA - so it ships without a build step. The polished PWA is ai_todo 105.
async fn index_page() -> Html<&'static str> {
    Html(INDEX_HTML)
}

const INDEX_HTML: &str = r##"<!doctype html><html><head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Claude Remote</title>
<style>
:root{color-scheme:dark}
body{margin:0;font:15px/1.4 system-ui,sans-serif;background:#16181d;color:#e6e6e6}
header{padding:10px 12px;background:#1f2229;display:flex;gap:8px;align-items:center}
input,textarea,button{font:inherit}
input,textarea{background:#0f1115;color:#e6e6e6;border:1px solid #333;border-radius:8px;padding:8px;width:100%;box-sizing:border-box}
button{background:#3b6ea5;color:#fff;border:0;border-radius:8px;padding:9px 12px}
button.sec{background:#333}
.wrap{padding:12px;max-width:720px;margin:0 auto}
.row{display:flex;gap:8px;margin:8px 0}
.sess{display:block;width:100%;text-align:left;background:#1f2229;margin:6px 0;padding:10px;border-radius:10px;color:#e6e6e6}
.sess .b{color:#8fbf8f;font-size:12px}
#log{white-space:pre-wrap;word-break:break-word;background:#0f1115;border:1px solid #222;border-radius:10px;padding:10px;height:55vh;overflow:auto;font:12px/1.35 ui-monospace,monospace}
.hide{display:none}
.muted{color:#888;font-size:12px}
</style></head><body>
<header><b>Claude Remote</b><span id=status class=muted style=margin-left:auto></span></header>
<div class=wrap>
<div id=auth>
<div class=muted>Paste the token from remote-access-token.txt</div>
<div class=row><input id=token placeholder=token autocomplete=off></div>
<div class=row><button onclick=saveTok()>Save &amp; load sessions</button></div>
</div>
<div id=list class=hide>
<div class=row><button onclick=loadSessions()>Refresh sessions</button><button class=sec onclick=logout()>Token</button></div>
<div id=sessions></div>
</div>
<div id=chat class=hide>
<div class=row><button class=sec onclick=back()>&larr; Back</button><button class=sec onclick=cancelTurn()>Cancel turn</button></div>
<div id=title class=muted></div>
<div id=log></div>
<div class=row><textarea id=msg rows=2 placeholder=message></textarea></div>
<div class=row><button onclick=send()>Send</button></div>
</div>
</div>
<script>
var T=localStorage.getItem('rc_token')||'';var cur=null;var ws=null;var SESS=[];
function $(i){return document.getElementById(i)}
function show(id){['auth','list','chat'].forEach(function(s){$(s).classList.toggle('hide',s!==id)})}
function st(m){$('status').textContent=m||''}
function hdr(){return {'Authorization':'Bearer '+T}}
function esc(s){return (s||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
if(T)$('token').value=T;
function saveTok(){T=$('token').value.trim();localStorage.setItem('rc_token',T);loadSessions()}
function logout(){show('auth')}
function loadSessions(){st('loading...');
fetch('/api/sessions',{headers:hdr()}).then(function(r){if(!r.ok){st('auth failed ('+r.status+')');throw 0}return r.json()})
.then(function(s){SESS=s;st('');show('list');var h='';
s.forEach(function(x,i){h+='<button class=sess onclick="open_('+i+')">'+esc(x.name||x.session_id)+'<div class=b>'+(x.busy?'running':'idle')+' &middot; '+esc(x.model)+'</div></button>'});
$('sessions').innerHTML=h||'<div class=muted>no sessions</div>'}).catch(function(){})}
function open_(i){var x=SESS[i];cur=x.session_id;show('chat');$('title').textContent=x.name||x.session_id;$('log').textContent='';
if(ws){try{ws.close()}catch(e){}}
var proto=location.protocol==='https:'?'wss':'ws';
ws=new WebSocket(proto+'://'+location.host+'/api/sessions/'+cur+'/stream?token='+encodeURIComponent(T));
ws.onopen=function(){st('live')};ws.onclose=function(){st('closed')};ws.onmessage=function(e){append(e.data)}}
function append(d){var t=d;try{var o=JSON.parse(d);t=o.text||o.delta||('['+(o.type||'event')+'] '+(o.text||''))}catch(e){}
var l=$('log');l.textContent+=t+'\n';l.scrollTop=l.scrollHeight}
function send(){var m=$('msg').value;if(!m||!cur)return;$('msg').value='';
fetch('/api/sessions/'+cur+'/send',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},hdr()),body:JSON.stringify({text:m})}).then(function(r){if(!r.ok)st('send failed '+r.status)})}
function cancelTurn(){if(cur)fetch('/api/sessions/'+cur+'/cancel',{method:'POST',headers:hdr()})}
function back(){if(ws){try{ws.close()}catch(e){}}cur=null;loadSessions()}
if(T)loadSessions();else show('auth');
</script></body></html>"##;

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
        ] {
            assert!(SAFE_METHODS.contains(&m), "{m} should be remotely callable");
        }
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
