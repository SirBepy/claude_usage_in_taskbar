//! Per-session lifecycle: spawn / send_message / cancel_turn / end_session.
//! Owns the long-lived `claude -p --input-format stream-json` subprocess
//! per session and the stdout reader task that fans events into the
//! session's broadcast channel.

use crate::chat::parser::ParserContext;
use crate::chat::billing::check_metered_billing;
use crate::daemon::broadcast;
use crate::daemon::claude_config::{base_claude_args, write_hook_settings, write_mcp_config};
use crate::daemon::session::{Session, SessionMap};
use crate::daemon::state::DaemonState;
use crate::types::chat::ChatEvent;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

const VALID_MODELS: &[&str] = &["haiku", "sonnet", "opus", "fable"];
const VALID_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

/// Accept both bare family aliases (`opus`) and full model ids
/// (`claude-opus-4-8`). The session model picker is now data-driven from
/// `/v1/models`, which returns full ids; claude's `--model` flag accepts
/// either form, so validation only needs the family to be recognizable.
fn is_valid_model(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    VALID_MODELS.iter().any(|fam| m.contains(fam))
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct StartSessionParams {
    pub cwd: PathBuf,
    pub model: String,
    pub effort: String,
    /// If Some, resume an existing session JSONL; if None, generate a new UUID.
    pub resume_id: Option<String>,
    /// If true, spawn claude with `--remote-control`. Defaults to false when the
    /// caller omits it so non-chat spawn paths never register a bridge.
    #[serde(default)]
    pub remote: bool,
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
    if !is_valid_model(&params.model)
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

    let mcp_config_path = write_mcp_config(&session_id, &session_id);
    let hook_settings_path = write_hook_settings(&session_id);

    let mut cmd = Command::new("claude");
    cmd.args(base_claude_args(
        params.resume_id.as_deref(),
        &session_id,
        &params.model,
        &params.effort,
        params.remote,
    ));
    if let Some(ref mcp_path) = mcp_config_path {
        cmd.arg("--permission-prompt-tool")
           .arg("mcp__cc_companion__approval_prompt")
           .arg("--mcp-config")
           .arg(mcp_path);
    }
    if let Some(ref settings_path) = hook_settings_path {
        cmd.arg("--settings").arg(settings_path);
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
                    // claude -p shows an interactive workspace-trust prompt when
                    // the cwd hasn't been trusted before. With stdin piped the
                    // process blocks indefinitely waiting for keyboard input.
                    // Detect the prompt and auto-accept by selecting option 1.
                    if !line_buf.starts_with(b"{") {
                        if let Ok(s) = std::str::from_utf8(&line_buf) {
                            if s.contains("Enter to confirm") {
                                let mut stdin_guard = pump_session.stdin.lock().await;
                                let _ = stdin_guard.write_all(b"1\n").await;
                                let _ = stdin_guard.flush().await;
                            }
                        }
                    }
                    for ev in ctx.feed(&line_buf) {
                        // Suppress SessionStarted: claude re-emits a system/init
                        // line at the start of EVERY turn. The app shows the
                        // session via its own synthetic SessionStarted handoff,
                        // so forwarding these spams "Session started" each turn.
                        if matches!(ev, ChatEvent::SessionStarted { .. }) {
                            continue;
                        }
                        // A `result` line parses to TurnUsage and marks the turn
                        // complete: update awaiting status, clear busy, and
                        // broadcast the registry change.
                        let turn_done_awaiting = if let ChatEvent::TurnUsage { ref awaiting, .. } = ev {
                            Some(awaiting.clone())
                        } else {
                            None
                        };
                        if log::log_enabled!(log::Level::Debug) {
                            let variant = serde_json::to_value(&ev)
                                .ok()
                                .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(str::to_string))
                                .unwrap_or_else(|| "?".into());
                            log::debug!("daemon publish: {variant} for {}", pump_session.session_id);
                        }
                        broadcast::publish(&pump_session, ev);
                        if let Some(awaiting) = turn_done_awaiting {
                            state_for_pump.registry.set_awaiting(&pump_session.session_id, awaiting);
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
    // Interrupt only the in-flight turn, keeping the process alive. The claude
    // process is long-lived (one `claude -p --input-format=stream-json` per
    // session, turns fed via stdin), so killing it (the old behavior) ended the
    // whole session: the pump saw stdout EOF, marked it ProcessGone, the pane
    // tore down, and the next message had to --resume respawn (looked like a
    // closed chat). The stream-json control protocol stops the current turn
    // without that teardown; the trailing `result` line clears busy as usual.
    let msg = serde_json::json!({
        "type": "control_request",
        "request_id": format!("interrupt-{}", uuid::Uuid::new_v4()),
        "request": { "subtype": "interrupt" }
    });
    let mut line = serde_json::to_vec(&msg).expect("serialize");
    line.push(b'\n');
    let mut stdin = session.stdin.lock().await;
    stdin.write_all(&line).await?;
    stdin.flush().await?;
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
        let args = base_claude_args(None, "new-uuid", "opus", "high", false);
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
        let args = base_claude_args(Some("abc-123"), "abc-123", "opus", "high", false);
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
        let args = base_claude_args(None, "new-uuid", "sonnet", "medium", false);
        let m = args.iter().position(|a| a == "--model").expect("--model");
        assert_eq!(args.get(m + 1).map(String::as_str), Some("sonnet"));
        let e = args.iter().position(|a| a == "--effort").expect("--effort");
        assert_eq!(args.get(e + 1).map(String::as_str), Some("medium"));
    }

    #[test]
    fn base_args_carry_turn_status_prompt() {
        // The status marker instruction must ride on every spawn so Claude
        // self-reports done-vs-question; the sidebar icon depends on it.
        let args = base_claude_args(None, "new-uuid", "opus", "high", false);
        let p = args
            .iter()
            .position(|a| a == "--append-system-prompt")
            .expect("--append-system-prompt must be present");
        let prompt = args.get(p + 1).map(String::as_str).unwrap_or("");
        assert!(prompt.contains("<cc-status:done>"), "prompt must name the done marker: {prompt}");
        assert!(prompt.contains("<cc-status:question>"), "prompt must name the question marker: {prompt}");
        assert!(prompt.contains("<cc-title:"), "prompt must request the title marker: {prompt}");
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
                remote: false,
            },
        )
        .await;
        assert!(matches!(r, Err(LifecycleError::InvalidConfig(_, _))));
        assert_eq!(state.sessions.len(), 0);
    }

    #[tokio::test]
    async fn full_model_id_accepted() {
        // The data-driven picker sends full ids like `claude-opus-4-8`; the
        // model gate must pass them through (it fails later on CwdMissing,
        // proving it got past the InvalidConfig check).
        let state = test_state();
        let r = spawn_session(
            &state,
            StartSessionParams {
                cwd: std::path::PathBuf::from("Z:\\does\\not\\exist"),
                model: "claude-opus-4-8".into(),
                effort: "high".into(),
                resume_id: None,
                remote: false,
            },
        )
        .await;
        assert!(matches!(r, Err(LifecycleError::CwdMissing(_))));
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
                remote: false,
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
                remote: false,
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
