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
    /// Registry account id to spawn under. `Some(id)` is a caller-picked
    /// account - the new-chat account picker (milestone 04) supplies this
    /// explicitly. `None` resolves to the daemon's cached
    /// `Settings.default_account_id`, which every other spawn path (and the
    /// picker itself when "default" is selected) relies on.
    #[serde(default)]
    pub account_id: Option<String>,
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
    #[error("no accounts registered - add an account before starting a chat")]
    NoAccounts,
    #[error("account {0} not found in the registry")]
    AccountNotFound(String),
    #[error("account drift: {0}")]
    AccountDrift(String),
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

    // Resolve the account this chat spawns under: explicit `account_id` if the
    // caller gave one, else the daemon's cached `default_account_id`. No spawn
    // path may fall back to `~/.claude` (00-overview.md locked decision).
    let default_account_id = state.settings.snapshot().default_account_id;
    let account = crate::accounts::resolve_account(
        params.account_id.as_deref(),
        default_account_id.as_deref(),
    )
    .map_err(|e| match e {
        crate::accounts::AccountResolveError::NoAccounts => LifecycleError::NoAccounts,
        crate::accounts::AccountResolveError::NotFound(id) => LifecycleError::AccountNotFound(id),
    })?;
    // Pre-spawn drift guard (step 3b): refuse if the profile dir's CLI
    // identity no longer matches what the registry recorded at add-account
    // time (someone ran `/login` inside it since onboarding).
    crate::accounts::drift::check(&account)
        .map_err(|e| LifecycleError::AccountDrift(e.to_string()))?;

    let spawn_env = crate::accounts::env::SpawnEnv::for_account(&account.config_dir);
    // Billing gate evaluates the CHILD's effective env (parent env + this
    // spawn's overrides/removals), not the daemon's ambient env alone.
    // `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`
    // are already guaranteed gone via `SCRUBBED_ENV_VARS` above, so what this
    // gate can still catch is a forbidden var that SURVIVES the unsets -
    // `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX`.
    let effective_env = spawn_env.effective_env(std::env::vars());
    if let Err(e) = check_metered_billing(&|k| effective_env.get(k).cloned()) {
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
           .arg("mcp__cc_conductor__approval_prompt")
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
    spawn_env.apply_tokio(&mut cmd);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // Belt-and-suspenders orphan guard: `child` lives inside the pump task
    // spawned below for the session's whole natural lifetime (it is only
    // dropped after an explicit `child.wait().await` once stdout hits EOF,
    // i.e. after the process has already exited on its own - so this never
    // fires early on the normal per-turn respawn cycle). If the pump task's
    // future is instead dropped without reaching that point (daemon exiting
    // while a turn is in flight, or the pump task panicking), `kill_on_drop`
    // makes sure the child doesn't outlive it. Doesn't replace the explicit
    // `kill_tree` shutdown sweeps (those also reap grandchildren); this only
    // covers the direct child.
    cmd.kill_on_drop(true);

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
        hook_settings_path,
        account.id.clone(),
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
        // True once the current turn has streamed at least one content delta,
        // meaning it is a live turn (not a replayed history result line from
        // `--resume`). Reset to false after each TurnUsage so each turn is
        // evaluated independently. Without this guard, resumed sessions fire one
        // sound per prior completed turn on top of the real one.
        let mut saw_stream_turn = false;
        // Generation counter captured at the start of each live turn (when the
        // first streaming AssistantMessage arrives). At turn-end we only call
        // set_busy(false) if the registry's turn_gen still matches, preventing
        // a stale result line from an interrupted turn from clearing the
        // busy=true that a new send_message set in the meantime.
        let mut pump_turn_gen: u64 = 0;
        // Coalescing (ai_todo streaming-render O(n^2) fix): parser.rs re-clones
        // the FULL accumulated text into every content_block_delta snapshot, so
        // a long reply otherwise broadcasts - and re-serializes across
        // daemon->app IPC, app->webview emit, AND the remote websocket - once
        // per token. At most one streaming snapshot is held here; a newer one
        // for the same block simply replaces it (both are idempotent full-text
        // snapshots, so dropping a superseded one loses nothing). It flushes on
        // whichever comes first: the ~100ms timer below, the next non-snapshot
        // event (flushed BEFORE that event so relative order is exact), or the
        // stream ending. The event shape on the wire is unchanged - only the
        // count of broadcasts drops, from O(n) per response to a handful.
        let mut pending_snapshot: Option<ChatEvent> = None;
        let mut flush_deadline: Option<tokio::time::Instant> = None;
        const SNAPSHOT_FLUSH_WINDOW: std::time::Duration = std::time::Duration::from_millis(100);
        loop {
            tokio::select! {
                result = buf_reader.read_until(b'\n', &mut line_buf) => {
                    match result {
                        Ok(0) => {
                            if let Some(pending) = pending_snapshot.take() {
                                broadcast::publish(&pump_session, pending);
                            }
                            break;
                        }
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
                                // A streaming AssistantMessage marks the current turn as
                                // live (not a replayed history line from --resume).
                                // On the FIRST such event per turn, snapshot the registry's
                                // turn_gen so the turn-end guard can detect if a newer
                                // send_message arrived before the result line was processed.
                                if matches!(ev, ChatEvent::AssistantMessage { streaming: true, .. }) {
                                    if !saw_stream_turn {
                                        pump_turn_gen = state_for_pump
                                            .registry
                                            .current_turn_gen(&pump_session.session_id);
                                    }
                                    saw_stream_turn = true;
                                    // Hold instead of broadcasting immediately - see the
                                    // coalescing comment above `pending_snapshot`.
                                    pending_snapshot = Some(ev);
                                    if flush_deadline.is_none() {
                                        flush_deadline = Some(tokio::time::Instant::now() + SNAPSHOT_FLUSH_WINDOW);
                                    }
                                    continue;
                                }
                                // Any other event type (tool_use, tool_result, finalized
                                // AssistantMessage, TurnUsage, Notification, ...): flush a
                                // held snapshot FIRST so subscribers see it before this
                                // one, preserving the parser's original event order exactly.
                                if let Some(pending) = pending_snapshot.take() {
                                    flush_deadline = None;
                                    broadcast::publish(&pump_session, pending);
                                }
                                // A `result` line parses to TurnUsage and marks the turn
                                // complete: update awaiting status, clear busy, and
                                // broadcast the registry change.
                                let (turn_done_awaiting, turn_autopilot_changed) =
                                    if let ChatEvent::TurnUsage { ref awaiting, ref autopilot_changed, .. } = ev {
                                        (Some(awaiting.clone()), *autopilot_changed)
                                    } else {
                                        (None, None)
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
                                    // Character "work finished" / "asking" sound. The in-app chat's
                                    // turn completion is NOT covered by the global Stop/Notification
                                    // hooks (those only drive skill-usage + external sessions), so
                                    // fire the sound here off the same `result` line that sets
                                    // awaiting. The app maps this to `notifications::fire`, which
                                    // resolves the session character + slot + mute/meeting gating.
                                    // Guard on saw_stream_turn so replayed history result lines
                                    // (emitted by claude on --resume before the live turn starts)
                                    // don't each trigger their own sound.
                                    if saw_stream_turn && matches!(awaiting.as_deref(), Some("done") | Some("question")) {
                                        state_for_pump.notifier.publish(
                                            "turn_sound",
                                            serde_json::json!({
                                                "session_id": pump_session.session_id,
                                                "cwd": pump_session.cwd.to_string_lossy(),
                                                "awaiting": awaiting.as_deref(),
                                            }),
                                        );
                                    }
                                    saw_stream_turn = false;
                                    state_for_pump.registry.set_awaiting(&pump_session.session_id, awaiting);
                                    state_for_pump.registry.set_busy_false_if_gen(&pump_session.session_id, pump_turn_gen);
                                    if let Some(active) = turn_autopilot_changed {
                                        state_for_pump.registry.set_autopilot(&pump_session.session_id, active);
                                    }
                                    state_for_pump.notifier.publish(
                                        "instances_changed",
                                        serde_json::json!({"instances": state_for_pump.registry.list()}),
                                    );
                                }
                            }
                            line_buf.clear();
                        }
                        Err(e) => {
                            if let Some(pending) = pending_snapshot.take() {
                                broadcast::publish(&pump_session, pending);
                            }
                            log::warn!(
                                "daemon: session {} stdout read failed: {}",
                                pump_session.session_id,
                                e
                            );
                            break;
                        }
                    }
                }
                // NOTE: in `tokio::select!` a disabled branch (guard = false) still
                // has its future EXPRESSION evaluated (only the polling is skipped),
                // so `flush_deadline.unwrap()` here would panic on every iteration
                // where `flush_deadline` is None (the common case) and, with
                // `panic = "abort"`, take the whole daemon down. Fall back to a
                // throwaway `now` when None; the guard still prevents this branch
                // from ever firing unless a real deadline is set.
                _ = tokio::time::sleep_until(flush_deadline.unwrap_or_else(tokio::time::Instant::now)), if flush_deadline.is_some() => {
                    if let Some(pending) = pending_snapshot.take() {
                        broadcast::publish(&pump_session, pending);
                    }
                    flush_deadline = None;
                }
            }
        }
        map_for_pump.remove(&pump_session.session_id);
        // Interactive sessions: `claude -p --input-format=stream-json` exits after
        // completing each turn. Keep the registry entry live so the sidebar keeps
        // showing the session. The next send_message will find the session missing
        // from the SessionMap, get -32004 NotFound, and auto-respawn with --resume.
        // For non-Interactive kinds (External / Automated) a process exit really
        // does mean the session is gone, so mark it ended as before.
        let is_interactive = state_for_pump.registry
            .get(&pump_session.session_id)
            .map(|i| matches!(i.kind, crate::sessions::kinds::InstanceKind::Interactive))
            .unwrap_or(false);
        if is_interactive {
            // Clear busy in case the process exited mid-turn without a result line.
            state_for_pump.registry.set_busy_false_if_gen(&pump_session.session_id, pump_turn_gen);
        } else {
            let now = chrono::Utc::now().to_rfc3339();
            state_for_pump.registry.mark_ended(&pump_session.session_id, crate::types::EndReason::ProcessGone, &now);
        }
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
        if let Some(ref p) = pump_session.hook_settings_path {
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
    // Broadcast a marked user-message echo so the frontend can render the
    // user bubble regardless of which device sent it. The `remote_echo: true`
    // flag lets the frontend distinguish this synthesised event from the
    // `claude --resume` history-replay user lines (which carry remote_echo:
    // false and are dropped to avoid duplicating transcript history).
    // The existing `sigOf` / `isLiveDuplicate` dedup gate in the event-store
    // handles the case where the desktop's own optimistic pushSynthetic already
    // recorded the same content sig, so both paths render exactly one bubble.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    broadcast::publish(
        session,
        ChatEvent::UserMessage {
            content: vec![crate::types::chat::ContentBlock::Text { text: text.to_string() }],
            timestamp: now_ms,
            remote_echo: true,
            is_meta: false,
        },
    );
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
    if let Some(ref p) = session.hook_settings_path {
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
        assert!(prompt.contains("<cc-status:done|question|waiting>"), "prompt must describe the status marker: {prompt}");
        assert!(prompt.contains("<cc-title:"), "prompt must request the title marker: {prompt}");
        assert!(prompt.contains("<cc-progress:"), "prompt must request the progress marker: {prompt}");
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
                account_id: None,
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
                account_id: None,
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
                account_id: None,
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
                account_id: None,
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
