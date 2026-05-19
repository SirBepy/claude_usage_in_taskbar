//! Persistent app-side client for the daemon. Multiplexes RPC calls + per
//! -session notification subscriptions over a single named pipe connection.
//! Uses `tokio::io::split` so reads and writes run concurrently without
//! contending on a single mutex.

use crate::daemon::frame::{read_frame, write_frame};
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

pub struct PersistentClient {
    #[cfg(windows)]
    writer: Arc<Mutex<WriteHalf>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    subs: Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
    next_id: Arc<Mutex<u64>>,
}

#[cfg(windows)]
impl PersistentClient {
    pub async fn connect(pipe_name: &str) -> Result<Self, ClientError> {
        use tokio::net::windows::named_pipe::ClientOptions;
        let mut pipe = ClientOptions::new().open(pipe_name)?;
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
        tokio::spawn(async move {
            let mut read_half = read_half;
            loop {
                let frame = match read_frame(&mut read_half).await {
                    Ok(f) => f,
                    Err(_) => break,
                };
                if frame.get("method").is_some() {
                    // Server-to-client notification.
                    let session_id = frame.pointer("/params/session_id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
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
        });

        Ok(Self {
            writer,
            pending,
            subs,
            next_id: Arc::new(Mutex::new(0)),
        })
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, ClientError> {
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
            write_frame(&mut *w, &req).await?;
        }
        let resp = rx.await.map_err(|_| ClientError::Closed)?;
        if let Some(err) = resp.get("error") {
            let code = err.get("code").and_then(Value::as_i64).unwrap_or(-1) as i32;
            let message = err.get("message").and_then(Value::as_str).unwrap_or("").to_string();
            return Err(ClientError::Rpc { code, message });
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
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

    pub async fn health(&self) -> Result<Value, ClientError> {
        self.call("health", Value::Null).await
    }
}

pub fn pipe_name_for_current_user() -> String {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
    format!(r"\\.\pipe\cc-companion-daemon-{user}")
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    #[tokio::test(flavor = "current_thread")]
    async fn persistent_client_health_against_real_daemon() {
        // Clear any stale state from prior runs.
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command",
                "Get-Process cc-companion-daemon -ErrorAction SilentlyContinue | Stop-Process -Force"])
            .status();
        if let Some(app_data) = dirs::data_dir() {
            let lock = app_data.join("claude-usage-tauri").join("daemon.lock");
            let _ = std::fs::remove_file(&lock);
        }

        let build = Command::new("cargo")
            .args(["build", "--bin", "cc-companion-daemon"])
            .current_dir(std::env::current_dir().unwrap())
            .status()
            .expect("cargo build");
        assert!(build.success());

        let mut exe = std::env::current_dir().unwrap();
        exe.push("target");
        exe.push("debug");
        exe.push("cc-companion-daemon.exe");
        let mut child = Command::new(&exe)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn daemon");

        // Wait for the pipe to bind.
        tokio::time::sleep(Duration::from_millis(800)).await;

        let client = PersistentClient::connect(&pipe_name_for_current_user())
            .await.expect("connect");
        let result = client.health().await.expect("health call");
        assert!(result["daemon_version"].is_string());
        assert_eq!(result["protocol_version"], json!(PROTOCOL_VERSION));

        let _ = child.kill();
        let _ = child.wait();
    }
}
