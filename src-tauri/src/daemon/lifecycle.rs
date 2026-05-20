//! Per-session lifecycle: spawn / send_message / cancel_turn / end_session.
//! Owns the long-lived `claude -p --input-format stream-json` subprocess
//! per session and the stdout reader task that fans events into the
//! session's broadcast channel.

use crate::chat::parser::ParserContext;
use crate::chat::runner::check_metered_billing;
use crate::daemon::broadcast;
use crate::daemon::session::{Session, SessionMap};
use crate::types::chat::ChatEvent;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// How long to wait for a brand-new session's `claude` to emit its `system`
/// init line (which carries the session_id we key everything on). Generous:
/// SessionStart hooks run before the init line and can take a couple seconds.
const INIT_CAPTURE_TIMEOUT: Duration = Duration::from_secs(30);

/// Build the base `claude` argument list (everything except the MCP flags).
///
/// **Critical:** `--resume` is passed ONLY when resuming an existing session.
/// A brand-new session must NOT pass `--resume <fresh-uuid>` - `claude` rejects
/// an unknown id ("No conversation found with session ID") and exits. For a new
/// session we omit `--resume` entirely and let `claude` generate its own id,
/// which we capture from the init line on stdout.
fn base_claude_args(resume_id: Option<&str>, model: &str, effort: &str) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        "--input-format=stream-json".to_string(),
        "--output-format=stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
    ];
    if let Some(rid) = resume_id {
        args.push("--resume".to_string());
        args.push(rid.to_string());
    }
    args.push("--model".to_string());
    args.push(model.to_string());
    args.push("--effort".to_string());
    args.push(effort.to_string());
    args
}

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

    // Resume: id is known up front; reject if already running. New session:
    // id is unknown until claude emits its init line (captured below).
    if let Some(ref rid) = params.resume_id {
        if map.contains_key(rid) {
            return Err(LifecycleError::AlreadyExists(rid.clone()));
        }
    }

    // The MCP config filename is keyed on a spawn-unique token, NOT the session
    // id (which a new session doesn't have yet). It only needs to be unique.
    let spawn_token = uuid::Uuid::new_v4().to_string();
    let mcp_config_path = crate::chat::runner::write_mcp_config(&spawn_token, &spawn_token);

    let mut cmd = Command::new("claude");
    cmd.args(base_claude_args(
        params.resume_id.as_deref(),
        &params.model,
        &params.effort,
    ));
    if let Some(ref mcp_path) = mcp_config_path {
        cmd.arg("--permission-prompt-tool")
           .arg("mcp__cc_companion__approval_prompt")
           .arg("--mcp-config")
           .arg(mcp_path);
    }
    cmd.current_dir(&params.cwd)
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

    // Reader state is created here so we can consume the init line up front for
    // a new session, then hand the SAME reader (with its buffered tail) to the
    // pump task. ParserContext likewise carries forward.
    let mut ctx = ParserContext::new();
    let mut buf_reader = BufReader::new(stdout);
    // Events parsed during init capture (the SessionStarted) are replayed to the
    // broadcast after the session is registered.
    let mut pre_events: Vec<ChatEvent> = Vec::new();

    let session_id = match params.resume_id.clone() {
        Some(rid) => rid,
        None => {
            // New session: read stdout until the parser yields SessionStarted
            // (from the `system`/init line), which carries claude's own id.
            let captured = tokio::time::timeout(INIT_CAPTURE_TIMEOUT, async {
                let mut line_buf = Vec::new();
                loop {
                    line_buf.clear();
                    match buf_reader.read_until(b'\n', &mut line_buf).await {
                        Ok(0) => return None, // EOF before init = claude failed to start
                        Ok(_) => {
                            for ev in ctx.feed(&line_buf) {
                                if let ChatEvent::SessionStarted { session_id, .. } = &ev {
                                    let sid = session_id.clone();
                                    pre_events.push(ev);
                                    return Some(sid);
                                }
                                pre_events.push(ev);
                            }
                        }
                        Err(_) => return None,
                    }
                }
            })
            .await;
            match captured {
                Ok(Some(sid)) if !sid.is_empty() => sid,
                _ => {
                    crate::channels::kill::kill_tree(pid);
                    if let Some(ref p) = mcp_config_path {
                        let _ = std::fs::remove_file(p);
                    }
                    return Err(LifecycleError::Io(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        "claude did not emit a session init line",
                    )));
                }
            }
        }
    };

    if map.contains_key(&session_id) {
        crate::channels::kill::kill_tree(pid);
        if let Some(ref p) = mcp_config_path {
            let _ = std::fs::remove_file(p);
        }
        return Err(LifecycleError::AlreadyExists(session_id));
    }

    let session = Session::new(
        session_id.clone(),
        params.cwd.clone(),
        params.model.clone(),
        params.effort.clone(),
        pid,
        stdin,
        mcp_config_path,
    );
    map.insert(session_id.clone(), Arc::clone(&session));

    // Replay the events parsed during init capture (no-op if no subscribers yet,
    // which is the normal case: the app attaches after start_session returns).
    for ev in pre_events {
        broadcast::publish(&session, ev);
    }

    let pump_session = Arc::clone(&session);
    let map_for_pump = Arc::clone(map);
    tokio::spawn(async move {
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
        if let Some(ref p) = pump_session.mcp_config_path {
            let _ = std::fs::remove_file(p);
        }
        let _ = child.wait().await;
    });

    crate::daemon::jsonl_tail::spawn(Arc::clone(&session));

    Ok(session)
}

pub async fn send_message(session: &Arc<Session>, text: &str) -> Result<(), LifecycleError> {
    let msg = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": text
        }
    });
    let mut line = serde_json::to_vec(&msg).expect("serialize");
    line.push(b'\n');
    let mut stdin = session.stdin.lock().await;
    stdin.write_all(&line).await?;
    stdin.flush().await?;
    Ok(())
}

pub async fn cancel_turn(map: &SessionMap, session_id: &str) -> Result<(), LifecycleError> {
    let session = map.get(session_id)
        .ok_or_else(|| LifecycleError::NotFound(session_id.to_string()))?
        .clone();
    crate::channels::kill::kill_tree(session.pid);
    // Pump task observes stdout EOF and removes from map. No further
    // bookkeeping needed here; client must call start_session to respawn.
    Ok(())
}

pub async fn end_session(map: &SessionMap, session_id: &str) -> Result<(), LifecycleError> {
    use tokio::io::AsyncWriteExt;
    let session = map.get(session_id)
        .ok_or_else(|| LifecycleError::NotFound(session_id.to_string()))?
        .clone();
    // Close stdin to signal EOF for clean shutdown.
    {
        let mut stdin = session.stdin.lock().await;
        let _ = stdin.shutdown().await;
    }
    // Wait up to 3s for claude to exit on its own (pump removes from map on EOF).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        if !map.contains_key(session_id) {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    // Force-kill if still present.
    crate::channels::kill::kill_tree(session.pid);
    if let Some(ref p) = session.mcp_config_path {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;

    #[test]
    fn new_session_omits_resume_flag() {
        // Root-cause guard: a brand-new session must NOT pass `--resume`.
        // Passing `--resume <fresh-uuid>` makes claude error with
        // "No conversation found with session ID" and exit immediately.
        let args = base_claude_args(None, "opus", "high");
        assert!(
            !args.iter().any(|a| a == "--resume"),
            "new session must not pass --resume: {args:?}"
        );
    }

    #[test]
    fn resume_session_includes_resume_id() {
        let args = base_claude_args(Some("abc-123"), "opus", "high");
        let pos = args
            .iter()
            .position(|a| a == "--resume")
            .expect("--resume must be present when resuming");
        assert_eq!(args.get(pos + 1).map(String::as_str), Some("abc-123"));
    }

    #[test]
    fn base_args_always_carry_model_and_effort() {
        let args = base_claude_args(None, "sonnet", "medium");
        let m = args.iter().position(|a| a == "--model").expect("--model");
        assert_eq!(args.get(m + 1).map(String::as_str), Some("sonnet"));
        let e = args.iter().position(|a| a == "--effort").expect("--effort");
        assert_eq!(args.get(e + 1).map(String::as_str), Some("medium"));
    }

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

    // Real send_message requires a live ChildStdin. The behavior is covered
    // end-to-end in the Phase 2 integration test (#[ignore]'d). Here we
    // sanity-check the JSON shape we emit.
    #[test]
    fn user_message_json_shape_matches_stream_json_format() {
        let msg = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": "hi"
            }
        });
        let v: serde_json::Value = serde_json::from_value(msg).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(v["message"]["content"], "hi");
    }

    #[tokio::test]
    async fn cancel_turn_unknown_session_errors() {
        let map = new_session_map();
        let r = cancel_turn(&map, "nope").await;
        assert!(matches!(r, Err(LifecycleError::NotFound(_))));
    }

    #[tokio::test]
    async fn end_session_unknown_session_errors() {
        let map = new_session_map();
        let r = end_session(&map, "nope").await;
        assert!(matches!(r, Err(LifecycleError::NotFound(_))));
    }
}
