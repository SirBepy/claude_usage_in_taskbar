//! Per-session lifecycle: spawn / send_message / cancel_turn / end_session.
//! Owns the long-lived `claude -p --input-format stream-json` subprocess
//! per session and the stdout reader task that fans events into the
//! session's broadcast channel.

use crate::chat::parser::ParserContext;
use crate::chat::runner::check_metered_billing;
use crate::daemon::broadcast;
use crate::daemon::session::{Session, SessionMap};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const VALID_MODELS: &[&str] = &["haiku", "sonnet", "opus"];
const VALID_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct StartSessionParams {
    pub cwd: PathBuf,
    pub model: String,
    pub effort: String,
    /// If Some, resume an existing session JSONL; if None, generate a new UUID.
    pub resume_id: Option<String>,
}

#[derive(Debug, Error)]
pub enum LifecycleError {
    #[error("invalid model or effort: model={0}, effort={1}")]
    InvalidConfig(String, String),
    #[error("metered billing detected: {0}")]
    MeteredBilling(String),
    #[error("session id {0} already exists in map")]
    AlreadyExists(String),
    #[error("session id {0} not found")]
    NotFound(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("cwd does not exist: {0}")]
    CwdMissing(PathBuf),
}

pub async fn spawn_session(
    map: &SessionMap,
    params: StartSessionParams,
) -> Result<Arc<Session>, LifecycleError> {
    if !VALID_MODELS.contains(&params.model.as_str())
        || !VALID_EFFORTS.contains(&params.effort.as_str())
    {
        return Err(LifecycleError::InvalidConfig(params.model, params.effort));
    }
    if !params.cwd.exists() {
        return Err(LifecycleError::CwdMissing(params.cwd));
    }
    if let Err(e) = check_metered_billing(&|k| std::env::var(k).ok()) {
        return Err(LifecycleError::MeteredBilling(e.to_string()));
    }

    let session_id = params
        .resume_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if map.contains_key(&session_id) {
        return Err(LifecycleError::AlreadyExists(session_id));
    }

    let mut cmd = Command::new("claude");
    cmd.arg("-p")
        .arg("--input-format=stream-json")
        .arg("--output-format=stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg("--resume")
        .arg(&session_id)
        .arg("--model")
        .arg(&params.model)
        .arg("--effort")
        .arg(&params.effort)
        .current_dir(&params.cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn()?;
    let pid = child.id().expect("pid");
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let _stderr = child.stderr.take().expect("piped stderr");

    let session = Session::new(
        session_id.clone(),
        params.cwd.clone(),
        params.model.clone(),
        params.effort.clone(),
        pid,
        stdin,
    );
    map.insert(session_id.clone(), Arc::clone(&session));

    let pump_session = Arc::clone(&session);
    let map_for_pump = Arc::clone(map);
    tokio::spawn(async move {
        let mut ctx = ParserContext::new();
        let mut buf_reader = BufReader::new(stdout);
        let mut line_buf = Vec::new();
        loop {
            line_buf.clear();
            match buf_reader.read_until(b'\n', &mut line_buf).await {
                Ok(0) => break,
                Ok(_) => {
                    for ev in ctx.feed(&line_buf) {
                        broadcast::publish(&pump_session, ev);
                    }
                }
                Err(e) => {
                    log::warn!(
                        "daemon: session {} stdout read failed: {}",
                        pump_session.session_id,
                        e
                    );
                    break;
                }
            }
        }
        map_for_pump.remove(&pump_session.session_id);
        log::info!(
            "daemon: session {} pump task exited",
            pump_session.session_id
        );
        let _ = child.wait().await;
    });

    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;

    #[tokio::test]
    async fn invalid_model_rejected() {
        let map = new_session_map();
        let r = spawn_session(
            &map,
            StartSessionParams {
                cwd: std::env::temp_dir(),
                model: "bogus".into(),
                effort: "high".into(),
                resume_id: None,
            },
        )
        .await;
        assert!(matches!(r, Err(LifecycleError::InvalidConfig(_, _))));
        assert_eq!(map.len(), 0);
    }

    #[tokio::test]
    async fn invalid_effort_rejected() {
        let map = new_session_map();
        let r = spawn_session(
            &map,
            StartSessionParams {
                cwd: std::env::temp_dir(),
                model: "opus".into(),
                effort: "ultra".into(),
                resume_id: None,
            },
        )
        .await;
        assert!(matches!(r, Err(LifecycleError::InvalidConfig(_, _))));
        assert_eq!(map.len(), 0);
    }

    #[tokio::test]
    async fn missing_cwd_rejected() {
        let map = new_session_map();
        let r = spawn_session(
            &map,
            StartSessionParams {
                cwd: std::path::PathBuf::from("Z:\\does\\not\\exist"),
                model: "opus".into(),
                effort: "high".into(),
                resume_id: None,
            },
        )
        .await;
        assert!(matches!(r, Err(LifecycleError::CwdMissing(_))));
        assert_eq!(map.len(), 0);
    }
}
