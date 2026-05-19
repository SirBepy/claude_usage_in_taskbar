//! Phase 1 daemon-client stub. App-side; one-shot connection per call.
//! Phase 2 introduces a persistent connection with subscription support.

use crate::daemon::frame::{read_frame, write_frame};
use crate::daemon::health::PROTOCOL_VERSION;
use serde_json::{json, Value};
use std::io;
use thiserror::Error;

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
}

pub struct DaemonClient {
    pipe_name: String,
}

impl DaemonClient {
    pub fn new(pipe_name: impl Into<String>) -> Self {
        Self { pipe_name: pipe_name.into() }
    }

    pub fn for_current_user() -> Self {
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
        Self::new(format!(r"\\.\pipe\cc-companion-daemon-{user}"))
    }

    #[cfg(windows)]
    async fn connect_with_handshake(&self) -> Result<tokio::net::windows::named_pipe::NamedPipeClient, ClientError> {
        use tokio::net::windows::named_pipe::ClientOptions;
        let mut pipe = ClientOptions::new().open(&self.pipe_name)?;
        write_frame(&mut pipe, &json!({"protocol_version": PROTOCOL_VERSION})).await?;
        let resp = read_frame(&mut pipe).await?;
        if resp.get("handshake").and_then(Value::as_str) != Some("ok") {
            return Err(ClientError::Handshake(resp.to_string()));
        }
        Ok(pipe)
    }

    #[cfg(windows)]
    pub async fn health(&self) -> Result<Value, ClientError> {
        let mut pipe = self.connect_with_handshake().await?;
        write_frame(&mut pipe, &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "health",
            "params": null
        })).await?;
        let resp = read_frame(&mut pipe).await?;
        if let Some(err) = resp.get("error") {
            let code = err.get("code").and_then(Value::as_i64).unwrap_or(-1) as i32;
            let message = err.get("message").and_then(Value::as_str).unwrap_or("").to_string();
            return Err(ClientError::Rpc { code, message });
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    #[tokio::test(flavor = "current_thread")]
    async fn client_can_call_health_against_real_daemon() {
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

        // Wait for pipe to bind.
        tokio::time::sleep(Duration::from_millis(800)).await;

        let client = DaemonClient::for_current_user();
        let result = client.health().await.expect("health call");
        assert!(result["daemon_version"].is_string());
        assert_eq!(result["protocol_version"], json!(PROTOCOL_VERSION));

        let _ = child.kill();
        let _ = child.wait();
    }
}
