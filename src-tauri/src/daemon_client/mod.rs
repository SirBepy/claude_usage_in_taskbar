//! Persistent app-side client for the daemon. Multiplexes RPC calls + per
//! -session notification subscriptions over a single named pipe connection.
//! Uses `tokio::io::split` so reads and writes run concurrently without
//! contending on a single mutex.

use crate::daemon::frame::{read_frame, write_frame, FrameError};
use crate::daemon::health::PROTOCOL_VERSION;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot, Mutex};

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("io: {0}")]
    Io(#[from] io::Error),
    #[error("frame: {0}")]
    Frame(#[from] crate::daemon::frame::FrameError),
    #[error("handshake failed: {0}")]
    Handshake(String),
    #[error("rpc error: code={code} message={message}")]
    Rpc { code: i32, message: String },
    #[error("client closed")]
    Closed,
}

#[cfg(windows)]
type WriteHalf = tokio::io::WriteHalf<tokio::net::windows::named_pipe::NamedPipeClient>;
#[cfg(unix)]
type WriteHalf = tokio::io::WriteHalf<tokio::net::UnixStream>;

#[derive(Clone)]
pub struct PersistentClient {
    writer: Arc<Mutex<WriteHalf>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    subs: Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
    next_id: Arc<Mutex<u64>>,
    /// Flips to `true` when the reader task exits (pipe died). `call()` consults
    /// it so a request issued after the connection dropped fails fast instead of
    /// parking a `pending` sender no one will ever answer. See the reader task in
    /// `connect` for why a dead reader must wake every waiter (the "wedged pipe"
    /// bug: send/open/close hung + reconnect never fired until a full restart).
    closed: tokio::sync::watch::Receiver<bool>,
}

impl PersistentClient {
    /// Connect to the daemon at `addr`: a named-pipe name on Windows, a
    /// Unix-domain-socket path on mac/Linux. The handshake + reader-task plumbing
    /// is identical across platforms; only opening the stream differs.
    pub async fn connect(addr: &str) -> Result<Self, ClientError> {
        #[cfg(windows)]
        let mut pipe = {
            use tokio::net::windows::named_pipe::ClientOptions;
            ClientOptions::new().open(addr)?
        };
        #[cfg(unix)]
        let mut pipe = tokio::net::UnixStream::connect(addr).await?;
        // Handshake first on the unsplit pipe so it's synchronous.
        write_frame(&mut pipe, &json!({"protocol_version": PROTOCOL_VERSION})).await?;
        let resp = read_frame(&mut pipe).await?;
        if resp.get("handshake").and_then(Value::as_str) != Some("ok") {
            return Err(ClientError::Handshake(resp.to_string()));
        }
        // Split into independent read/write halves.
        let (read_half, write_half) = tokio::io::split(pipe);
        let writer = Arc::new(Mutex::new(write_half));
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
        let subs: Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));

        let pending_for_reader = Arc::clone(&pending);
        let subs_for_reader = Arc::clone(&subs);
        let (closed_tx, closed_rx) = tokio::sync::watch::channel(false);
        tokio::spawn(async move {
            let mut read_half = read_half;
            loop {
                let frame = match read_frame(&mut read_half).await {
                    Ok(f) => f,
                    Err(e) => {
                        // Log why the pipe reader stopped so recurring drops can be
                        // diagnosed. For io errors surface the ErrorKind (e.g.
                        // UnexpectedEof = clean daemon shutdown vs BrokenPipe/reset).
                        match &e {
                            FrameError::Io(io_err) => log::warn!(
                                "daemon pipe reader stopped: io error kind={:?}: {io_err}",
                                io_err.kind()
                            ),
                            other => log::warn!("daemon pipe reader stopped: {other}"),
                        }
                        break;
                    }
                };
                if frame.get("method").is_some() {
                    // Server-to-client notification.
                    // Only `chat_event` is session-scoped; route it to the
                    // per-session subscriber registered by `attach_session`.
                    // All other notifications (turn_sound, instances_changed,
                    // refresh_requested, etc.) are global — even when they carry
                    // a session_id as data — and must reach the global slot ("").
                    let method = frame.get("method").and_then(Value::as_str).unwrap_or("");
                    let session_id = if method == "chat_event" {
                        frame.pointer("/params/session_id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string()
                    } else {
                        String::new()
                    };
                    let subs = subs_for_reader.lock().await;
                    if let Some(tx) = subs.get(&session_id) {
                        let _ = tx.send(frame).await;
                    }
                } else if let Some(id) = frame.get("id").and_then(Value::as_u64) {
                    let mut pending = pending_for_reader.lock().await;
                    if let Some(tx) = pending.remove(&id) {
                        let _ = tx.send(frame);
                    }
                }
            }
            // The pipe died. Wake every waiter so the connection can't wedge:
            //  - drop all `pending` oneshot senders -> in-flight `call()`s resolve
            //    to `Err(Closed)` instead of hanging forever;
            //  - drop all `subs` mpsc senders -> the global subscription's
            //    `rx.recv()` returns `None`, which is the signal `daemon_link`'s
            //    reconnect loop waits for to rebuild the connection;
            //  - flip `closed` so any `call()` racing in after this point fails
            //    fast rather than parking a sender no reader will ever answer.
            pending_for_reader.lock().await.clear();
            subs_for_reader.lock().await.clear();
            let _ = closed_tx.send(true);
        });

        Ok(Self {
            writer,
            pending,
            subs,
            next_id: Arc::new(Mutex::new(0)),
            closed: closed_rx,
        })
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, ClientError> {
        // Clone the close-watch BEFORE the borrow so a reader that dies between
        // the borrow and the `select!` below still wakes us via `changed()`
        // (the clone's "seen" version is fixed here; any later flip is a change).
        let mut closed = self.closed.clone();
        if *closed.borrow() {
            return Err(ClientError::Closed);
        }
        let id = {
            let mut n = self.next_id.lock().await;
            *n += 1;
            *n
        };
        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.insert(id, tx);
        }
        {
            let mut w = self.writer.lock().await;
            if let Err(e) = write_frame(&mut *w, &req).await {
                self.pending.lock().await.remove(&id);
                return Err(e.into());
            }
        }
        // Wait for the reply, but bail the instant the connection closes so a
        // request issued just before the reader died can't hang forever.
        let resp = tokio::select! {
            r = rx => r.map_err(|_| ClientError::Closed)?,
            _ = closed.changed() => {
                self.pending.lock().await.remove(&id);
                return Err(ClientError::Closed);
            }
        };
        if let Some(err) = resp.get("error") {
            let code = err.get("code").and_then(Value::as_i64).unwrap_or(-1) as i32;
            let message = err.get("message").and_then(Value::as_str).unwrap_or("").to_string();
            return Err(ClientError::Rpc { code, message });
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    pub async fn subscribe_global(&self) -> Result<mpsc::Receiver<Value>, ClientError> {
        let (tx, rx) = mpsc::channel(256);
        {
            let mut subs = self.subs.lock().await;
            // Empty-string key is the "no session_id" / global slot.
            subs.insert(String::new(), tx);
        }
        self.call("subscribe_global", json!({})).await?;
        Ok(rx)
    }

    pub async fn attach_session(&self, session_id: &str) -> Result<mpsc::Receiver<Value>, ClientError> {
        let (tx, rx) = mpsc::channel(256);
        {
            let mut subs = self.subs.lock().await;
            subs.insert(session_id.to_string(), tx);
        }
        self.call("attach_session", json!({"session_id": session_id})).await?;
        Ok(rx)
    }

    /// Stop receiving a session's events. Drops the local per-session sender so
    /// the app-side bridge pump's receiver closes and its task exits (instead of
    /// blocking forever on a receiver that never closes - ai_todo 66 #2), then
    /// tells the daemon to abort its relay task for this session. Idempotent.
    pub async fn detach_session(&self, session_id: &str) -> Result<(), ClientError> {
        {
            let mut subs = self.subs.lock().await;
            subs.remove(session_id);
        }
        self.call("detach_session", json!({"session_id": session_id})).await?;
        Ok(())
    }

    pub async fn health(&self) -> Result<Value, ClientError> {
        self.call("health", Value::Null).await
    }

    /// Tell the daemon to stop (kill channels + exit the process).
    pub async fn shutdown_daemon(&self) -> Result<(), ClientError> {
        self.call("shutdown_daemon", Value::Null).await.map(|_| ())
    }

    pub async fn push_settings(&self, settings: &crate::types::Settings) -> Result<(), ClientError> {
        let v = serde_json::to_value(settings)
            .map_err(|e| ClientError::Rpc { code: -32000, message: format!("serialize settings: {e}") })?;
        self.call("set_settings", v).await?;
        Ok(())
    }

    pub async fn respond_permission(
        &self,
        request_id: &str,
        allow: bool,
        updated_input: Option<serde_json::Value>,
        message: Option<String>,
    ) -> Result<(), ClientError> {
        let params = serde_json::json!({
            "request_id": request_id,
            "allow": allow,
            "updated_input": updated_input,
            "message": message,
        });
        self.call("respond_permission", params).await?;
        Ok(())
    }

    pub async fn respond_question(
        &self,
        request_id: &str,
        answers: serde_json::Value,
    ) -> Result<(), ClientError> {
        let params = serde_json::json!({
            "request_id": request_id,
            "answers": answers,
        });
        self.call("respond_question", params).await?;
        Ok(())
    }

    /// Open prompts the app must surface (question cards), fetched over the
    /// reliable RPC channel rather than the lossy notifier broadcast. Polled by
    /// the app so a dropped broadcast frame can't hang an AskUserQuestion turn.
    pub async fn list_pending_prompts(&self) -> Result<serde_json::Value, ClientError> {
        self.call("list_pending_prompts", json!({})).await
    }

    pub async fn start_channel(&self, project_id: &str) -> Result<(), ClientError> {
        self.call("start_channel", json!({"project_id": project_id})).await?;
        Ok(())
    }

    pub async fn stop_channel(&self, project_id: &str) -> Result<(), ClientError> {
        self.call("stop_channel", json!({"project_id": project_id})).await?;
        Ok(())
    }

    pub async fn restart_channel(&self, project_id: &str) -> Result<(), ClientError> {
        self.call("restart_channel", json!({"project_id": project_id})).await?;
        Ok(())
    }

    pub async fn show_channel(&self, project_id: &str) -> Result<(), ClientError> {
        self.call("show_channel", json!({"project_id": project_id})).await?;
        Ok(())
    }

    pub async fn hide_channel(&self, project_id: &str) -> Result<(), ClientError> {
        self.call("hide_channel", json!({"project_id": project_id})).await?;
        Ok(())
    }

    pub async fn list_channels(&self) -> Result<serde_json::Value, ClientError> {
        self.call("list_channels", json!({})).await
    }

    /// Snapshot of the daemon's instance registry (array of Instance JSON).
    /// Seeded into the app cache on connect so live sessions render immediately.
    pub async fn list_instances(&self) -> Result<serde_json::Value, ClientError> {
        self.call("list_instances", json!({})).await
    }

    /// Start (or resume) a daemon-owned session. Returns the real session_id.
    pub async fn start_session(
        &self,
        cwd: &str,
        model: &str,
        effort: &str,
        resume_id: Option<&str>,
        remote: bool,
    ) -> Result<String, ClientError> {
        let res = self
            .call("start_session", json!({
                "cwd": cwd,
                "model": model,
                "effort": effort,
                "resume_id": resume_id,
                "remote": remote,
            }))
            .await?;
        res.get("session_id")
            .and_then(Value::as_str)
            .map(|s| s.to_string())
            .ok_or_else(|| ClientError::Rpc { code: -32000, message: "start_session: no session_id in result".into() })
    }

    pub async fn send_message(&self, session_id: &str, text: &str) -> Result<(), ClientError> {
        self.call("send_message", json!({"session_id": session_id, "text": text})).await?;
        Ok(())
    }

    pub async fn cancel_turn(&self, session_id: &str) -> Result<(), ClientError> {
        self.call("cancel_turn", json!({"session_id": session_id})).await?;
        Ok(())
    }

    pub async fn end_session(&self, session_id: &str) -> Result<(), ClientError> {
        self.call("end_session", json!({"session_id": session_id})).await?;
        Ok(())
    }

    pub async fn mark_session_ended(&self, session_id: &str) -> Result<(), ClientError> {
        self.call("mark_session_ended", json!({"session_id": session_id})).await?;
        Ok(())
    }

    pub async fn externalize_session(&self, session_id: &str) -> Result<(), ClientError> {
        self.call("externalize_session", json!({"session_id": session_id})).await?;
        Ok(())
    }

    pub async fn set_session_effort(&self, session_id: &str, effort: &str) -> Result<(), ClientError> {
        self.call("set_session_effort", json!({"session_id": session_id, "effort": effort})).await?;
        Ok(())
    }

    pub async fn set_auto_accept(&self, session_id: &str, value: bool) -> Result<(), ClientError> {
        self.call("set_auto_accept", json!({"session_id": session_id, "value": value})).await?;
        Ok(())
    }

    pub async fn register_historical(&self, session_id: &str, cwd: &str) -> Result<(), ClientError> {
        self.call("register_historical", json!({"session_id": session_id, "cwd": cwd})).await?;
        Ok(())
    }

    pub async fn takeover_manual(&self, manual_pid: u32, model: &str, effort: &str) -> Result<String, ClientError> {
        let res = self.call("takeover_manual", json!({"manual_pid": manual_pid, "model": model, "effort": effort})).await?;
        res.get("session_id")
            .and_then(serde_json::Value::as_str)
            .map(|s| s.to_string())
            .ok_or_else(|| ClientError::Rpc { code: -32000, message: "takeover_manual: no session_id".into() })
    }
}

/// Address the app uses to reach the daemon: a named-pipe name on Windows, a
/// Unix-domain-socket path on mac/Linux. Must match the daemon's bind address.
pub fn daemon_addr_for_current_user() -> String {
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
        let inst = crate::daemon::instance::instance_suffix();
        format!(r"\\.\pipe\cc-conductor-daemon-{user}{inst}")
    }
    #[cfg(unix)]
    {
        crate::daemon::transport_unix::socket_path_for_user()
            .to_string_lossy()
            .into_owned()
    }
}

/// Try to connect to the daemon; if none is listening, spawn one detached
/// (`<exe> --daemon`) and poll the transport until it binds (~10s budget), then
/// connect. The daemon's lockfile prevents a duplicate if two apps race here.
///
/// Pre-spawn poll (2s): handles the simultaneous-launch race where the OS
/// auto-updater restarts the app and daemon at the exact same second. Without
/// this window, the app immediately spawns a redundant daemon that exits on the
/// lockfile, and the 10s post-spawn poll competes with the original daemon's
/// startup. The pre-spawn poll skips the redundant spawn if the original daemon
/// becomes ready within 2s.
pub async fn ensure_daemon() -> Result<PersistentClient, ClientError> {
    let addr = daemon_addr_for_current_user();
    if let Ok(c) = PersistentClient::connect(&addr).await {
        return Ok(c);
    }
    // Pre-spawn: wait up to 2s in case the daemon is already starting.
    for _ in 0..10 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if let Ok(c) = PersistentClient::connect(&addr).await {
            return Ok(c);
        }
    }
    // Still nothing: spawn the daemon ourselves.
    match crate::daemon::spawn_self::spawn_detached_daemon() {
        Ok(pid) => log::info!("spawned daemon (pid {pid})"),
        Err(e) => log::error!("failed to spawn daemon: {e}"),
    }
    // Post-spawn poll: ~10s budget (heavier init paths can take a few seconds).
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if let Ok(c) = PersistentClient::connect(&addr).await {
            return Ok(c);
        }
    }
    PersistentClient::connect(&addr).await
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    #[tokio::test(flavor = "current_thread")]
    async fn persistent_client_health_against_real_daemon() {
        // Isolated test instance: distinct pipe/lockfile/hook-port so this never
        // touches a real daemon the user has running (ai_todo 71). NOTE: no
        // `Stop-Process cc-conductor-daemon` here on purpose - that used to kill
        // the user's real daemon.
        const INSTANCE: &str = "test-pclient";
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
        let pipe_name = format!(r"\\.\pipe\cc-conductor-daemon-{user}-{INSTANCE}");

        // Clear only THIS instance's stale lockfile.
        if let Some(app_data) = dirs::data_dir() {
            let lock = app_data.join("claude-conductor").join(format!("daemon-{INSTANCE}.lock"));
            let _ = std::fs::remove_file(&lock);
        }

        let build = Command::new("cargo")
            .args(["build", "--bin", "cc-conductor-daemon"])
            .current_dir(std::env::current_dir().unwrap())
            .status()
            .expect("cargo build");
        assert!(build.success());

        let mut exe = std::env::current_dir().unwrap();
        exe.push("target");
        exe.push("debug");
        exe.push("cc-conductor-daemon.exe");
        let mut child = Command::new(&exe)
            .env("CC_DAEMON_INSTANCE", INSTANCE)
            // Don't launch real automation channels from a test daemon.
            .env("CC_DAEMON_NO_AUTOSTART", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn daemon");

        // Wait for the pipe to bind.
        tokio::time::sleep(Duration::from_millis(800)).await;

        let client = PersistentClient::connect(&pipe_name)
            .await.expect("connect");
        let result = client.health().await.expect("health call");
        assert!(result["daemon_version"].is_string());
        assert_eq!(result["protocol_version"], json!(PROTOCOL_VERSION));

        let _ = child.kill();
        let _ = child.wait();
    }
}
