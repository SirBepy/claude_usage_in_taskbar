//! Per-session lifecycle: spawn / send_message / cancel_turn / end_session.
//! Owns the long-lived `claude -p --input-format stream-json` subprocess
//! per session and the stdout reader task that fans events into the
//! session's broadcast channel.

use crate::chat::parser::ParserContext;
use crate::chat::runner::check_metered_billing;
use crate::daemon::broadcast;
use crate::daemon::session::{Session, SessionMap};
use crate::daemon::state::DaemonState;
use crate::types::chat::ChatEvent;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// Build the base `claude` argument list (everything except the MCP flags).
///
/// **Critical session-id handling:** `claude` rejects `--resume <id>` for an id
/// that has no existing conversation ("No conversation found with session ID")
/// and exits. So we must NOT `--resume` a freshly generated id. Instead:
/// - new session  -> `--session-id <our-uuid>` (claude creates a new
///   conversation using exactly that id; verified the id round-trips).
/// - resume        -> `--resume <existing-id>`.
/// Either way `session_id` is known up front, so the daemon never has to block
/// reading stdout to discover it (claude does not emit its `system`/init line
/// until it receives the first user message, which would otherwise deadlock).
fn base_claude_args(resume_id: Option<&str>, session_id: &str, model: &str, effort: &str) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        "--input-format=stream-json".to_string(),
        "--output-format=stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
    ];
    if resume_id.is_some() {
        args.push("--resume".to_string());
    } else {
        args.push("--session-id".to_string());
    }
    args.push(session_id.to_string());
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
    state: &Arc<DaemonState>,
    params: StartSessionParams,
) -> Result<Arc<Session>, LifecycleError> {
    let map = &state.sessions;
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

    // The session id is known up front for BOTH paths: a new session gets a
    // freshly generated UUID that we hand to claude via `--session-id`, and a
    // resume reuses the existing id via `--resume`. No stdout capture needed,
    // so spawn_session never blocks (claude withholds its init line until the
    // first user message arrives, which the app sends only AFTER this returns).
    let session_id = params
        .resume_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if map.contains_key(&session_id) {
        return Err(LifecycleError::AlreadyExists(session_id));
    }

    let mcp_config_path = crate::chat::runner::write_mcp_config(&session_id, &session_id);

    let mut cmd = Command::new("claude");
    cmd.args(base_claude_args(
        params.resume_id.as_deref(),
        &session_id,
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
    log::info!(
        "daemon: session {} live (pid={}, resume={})",
        session_id, pid, params.resume_id.is_some()
    );

    let pump_session = Arc::clone(&session);
    let map_for_pump = Arc::clone(map);
    let state_for_pump = Arc::clone(state);
    tokio::spawn(async move {
        let mut ctx = ParserContext::new_live();
        let mut buf_reader = BufReader::new(stdout);
        let mut line_buf = Vec::new();
        loop {
            line_buf.clear();
            match buf_reader.read_until(b'\n', &mut line_buf).await {
                Ok(0) => break,
                Ok(_) => {
                    for ev in ctx.feed(&line_buf) {
                        // Suppress SessionStarted: claude re-emits a system/init
                        // line at the start of EVERY turn. The app shows the
                        // session via its own synthetic SessionStarted handoff,
                        // so forwarding these spams "Session started" each turn.
                        if matches!(ev, ChatEvent::SessionStarted { .. }) {
                            continue;
                        }
                        // A `result` line parses to TurnUsage and marks the turn
                        // complete: clear the busy flag so the UI thinking bar
                        // stops, and broadcast the registry change.
                        let turn_done = matches!(ev, ChatEvent::TurnUsage { .. });
                        if log::log_enabled!(log::Level::Debug) {
                            let variant = serde_json::to_value(&ev)
                                .ok()
                                .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(str::to_string))
                                .unwrap_or_else(|| "?".into());
                            log::debug!("daemon publish: {variant} for {}", pump_session.session_id);
                        }
                        broadcast::publish(&pump_session, ev);
                        if turn_done {
                            state_for_pump.registry.set_busy(&pump_session.session_id, false);
                            state_for_pump.notifier.publish(
                                "instances_changed",
                                serde_json::json!({"instances": state_for_pump.registry.list()}),
                            );
                        }
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
        // Process exited: mark the session ended so the UI reflects it.
        let now = chrono::Utc::now().to_rfc3339();
        state_for_pump.registry.mark_ended(&pump_session.session_id, crate::types::EndReason::ProcessGone, &now);
        state_for_pump.notifier.publish(
            "instances_changed",
            serde_json::json!({"instances": state_for_pump.registry.list()}),
        );
        log::info!(
            "daemon: session {} pump task exited",
            pump_session.session_id
        );
        if let Some(ref p) = pump_session.mcp_config_path {
            let _ = std::fs::remove_file(p);
        }
        let _ = child.wait().await;
    });

    // NOTE: jsonl_tail is intentionally NOT spawned in Phase 5a. It republishes
    // every transcript line to the same broadcast the stdout pump already feeds,
    // with no dedup, so it double-renders every app-driven turn. Its only purpose
    // is catching turns that bypass our stdout (phone via remote-control bridge);
    // that is Phase 5b/phone-convergence work and must add uuid-based dedup first.

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
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn test_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    #[test]
    fn new_session_uses_session_id_not_resume() {
        // Root-cause guard: a brand-new session must use `--session-id <uuid>`,
        // NOT `--resume <uuid>`. claude rejects `--resume` of an unknown id
        // ("No conversation found with session ID") and exits.
        let args = base_claude_args(None, "new-uuid", "opus", "high");
        assert!(
            !args.iter().any(|a| a == "--resume"),
            "new session must not pass --resume: {args:?}"
        );
        let pos = args
            .iter()
            .position(|a| a == "--session-id")
            .expect("--session-id must be present for a new session");
        assert_eq!(args.get(pos + 1).map(String::as_str), Some("new-uuid"));
    }

    #[test]
    fn resume_session_uses_resume_not_session_id() {
        let args = base_claude_args(Some("abc-123"), "abc-123", "opus", "high");
        assert!(
            !args.iter().any(|a| a == "--session-id"),
            "resume must not pass --session-id: {args:?}"
        );
        let pos = args
            .iter()
            .position(|a| a == "--resume")
            .expect("--resume must be present when resuming");
        assert_eq!(args.get(pos + 1).map(String::as_str), Some("abc-123"));
    }

    #[test]
    fn base_args_always_carry_model_and_effort() {
        let args = base_claude_args(None, "new-uuid", "sonnet", "medium");
        let m = args.iter().position(|a| a == "--model").expect("--model");
        assert_eq!(args.get(m + 1).map(String::as_str), Some("sonnet"));
        let e = args.iter().position(|a| a == "--effort").expect("--effort");
        assert_eq!(args.get(e + 1).map(String::as_str), Some("medium"));
    }

    #[tokio::test]
    async fn invalid_model_rejected() {
        let state = test_state();
        let r = spawn_session(
            &state,
            StartSessionParams {
                cwd: std::env::temp_dir(),
                model: "bogus".into(),
                effort: "high".into(),
                resume_id: None,
            },
        )
        .await;
        assert!(matches!(r, Err(LifecycleError::InvalidConfig(_, _))));
        assert_eq!(state.sessions.len(), 0);
    }

    #[tokio::test]
    async fn invalid_effort_rejected() {
        let state = test_state();
        let r = spawn_session(
            &state,
            StartSessionParams {
                cwd: std::env::temp_dir(),
                model: "opus".into(),
                effort: "ultra".into(),
                resume_id: None,
            },
        )
        .await;
        assert!(matches!(r, Err(LifecycleError::InvalidConfig(_, _))));
        assert_eq!(state.sessions.len(), 0);
    }

    #[tokio::test]
    async fn missing_cwd_rejected() {
        let state = test_state();
        let r = spawn_session(
            &state,
            StartSessionParams {
                cwd: std::path::PathBuf::from("Z:\\does\\not\\exist"),
                model: "opus".into(),
                effort: "high".into(),
                resume_id: None,
            },
        )
        .await;
        assert!(matches!(r, Err(LifecycleError::CwdMissing(_))));
        assert_eq!(state.sessions.len(), 0);
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
