//! Claude invocation config builders: MCP config, hook settings, and base CLI
//! args. These are independent of session process lifecycle and consumed by
//! `spawn_session` in `lifecycle.rs`.

use std::path::PathBuf;

/// Appended to the system prompt of every session we spawn so Claude
/// self-reports, at the end of each turn: (1) a short conversation title and
/// (2) whether it is done, waiting on the user, or parked on an external
/// process. The frontend strips both markers before display (see
/// `chat-transforms.ts`). The status marker drives the sidebar state icon
/// (done = calm check, question = amber flag, waiting = indigo hourglass). The title
/// marker is read off the transcript by `tokens::title::ai_milestone_title`,
/// which only honors the title from the response to user-turn 1, 5, or 15 - so
/// the title refines as the chat grows without churning every turn. The marker
/// rides every response (cheap); the read side gates which ones count.
pub(crate) const TURN_STATUS_PROMPT: &str = "End EVERY response with exactly two bare lines - no surrounding text or markdown: <cc-title:3-6 word topic summary> then <cc-status:done|question|waiting>. done=fully finished, nothing still running and not blocked on anything; question=awaiting the user's input or decision; waiting=you kicked off or are blocked on an external process (CI/pipeline, a long or background command, a scheduled wake) that will let you continue on its own - use waiting NOT done whenever work will resume without the user. Also: when a response involves 3 or more distinct tool-use steps, emit <cc-progress:N/M> on its own bare line in your text at the start of each step, where N is the current step (1-based) and M is your estimated total. Example: step 2 of 5 -> bare line containing only <cc-progress:2/5>. Skip this for short responses.";

/// Write a temporary .mcp.json file for the given turn and return its path.
/// Returns None if the app-data dir is unavailable (non-fatal; permission
/// relay simply won't be wired up for this turn).
pub(crate) fn write_mcp_config(turn_id: &str, tracking_id: &str) -> Option<PathBuf> {
    let mcp_dir = crate::settings::paths::mcp_temp_dir().ok()?;
    let exe = std::env::current_exe().ok()?;
    let config = serde_json::json!({
        "mcpServers": {
            "cc_companion": {
                "command": exe.to_string_lossy(),
                "args": ["--mcp-permission"],
                "env": {"CC_SESSION_ID": tracking_id}
            }
        }
    });
    let path = mcp_dir.join(format!("{turn_id}.json"));
    std::fs::write(&path, serde_json::to_string(&config).ok()?).ok()?;
    Some(path)
}

/// Write a per-session settings.json that registers a `PreToolUse` hook for the
/// builtin `AskUserQuestion` tool. The hook `curl`s the payload to the daemon's
/// `/hooks/ask-question` endpoint. Returns None if the app-data dir is
/// unavailable (non-fatal; AskUserQuestion just won't be answerable this session).
///
/// Why a hook and not the permission relay: current `claude` no longer routes
/// the builtin `AskUserQuestion` through `--permission-prompt-tool`, so the
/// approval-prompt relay never fires and the turn hangs. A `PreToolUse` hook
/// still fires for it; the daemon endpoint surfaces the question through the
/// existing question relay and returns the answer as a `deny` reason claude
/// reads as feedback. We use `curl` (not the app exe) because the GUI-subsystem
/// exe cannot reliably do short-lived hook stdin/stdout - this mirrors the
/// existing Stop hook. Scoped via `--settings` so it never touches the project's
/// own `.claude/settings.json`; `--permission-prompt-tool` stays for real
/// permission gates (Bash/Edit/etc.).
pub(crate) fn write_hook_settings(turn_id: &str) -> Option<PathBuf> {
    let dir = crate::settings::paths::mcp_temp_dir().ok()?;
    // --max-time MUST out-wait the daemon's prompt window (PROMPT_TIMEOUT_SECS =
    // 3600s, see hooks_server::permission). The server holds the AskUserQuestion
    // prompt open for up to an hour so an AFK dev can answer from their phone;
    // curl aborting first (the old 320s = 5.3min) dropped the answer with the
    // turn left hanging. 3600 + 60s slack so the server's response always lands
    // first; --connect-timeout fails fast if the daemon isn't up.
    let command = format!(
        "curl -s --connect-timeout 10 --max-time 3660 --retry 2 --retry-delay 1 -X POST -H \"Content-Type: application/json\" --data-binary @- http://127.0.0.1:{}/hooks/ask-question",
        daemon_hook_port()
    );
    let config = serde_json::json!({
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "AskUserQuestion",
                    "hooks": [ { "type": "command", "command": command } ]
                }
            ]
        }
    });
    let path = dir.join(format!("{turn_id}.settings.json"));
    std::fs::write(&path, serde_json::to_string(&config).ok()?).ok()?;
    Some(path)
}

/// The hook server's actual bound port. The production daemon pins HOOK_PORT
/// (27182); a test instance (CC_DAEMON_INSTANCE set) binds an ephemeral port and
/// records it in a suffixed `hooks_port-<suffix>.txt`. Read that file so the
/// AskUserQuestion hook curls the RIGHT daemon under the e2e harness too. Falls
/// back to HOOK_PORT.
pub(crate) fn daemon_hook_port() -> u16 {
    let suffix = crate::daemon::instance::instance_suffix();
    crate::settings::paths::read_hook_port(&suffix)
        .unwrap_or(crate::daemon::hooks_server::HOOK_PORT)
}

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
pub(crate) fn base_claude_args(resume_id: Option<&str>, session_id: &str, model: &str, effort: &str, remote: bool) -> Vec<String> {
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
    args.push("--append-system-prompt".to_string());
    args.push(TURN_STATUS_PROMPT.to_string());
    if remote {
        // Spawn the chat under claude's remote-control bridge. NOTE: pairing
        // `--remote-control` with `--input-format=stream-json` is an untested
        // Phase-5b combination; behavior of the bridge under stdin-driven turns
        // has not been verified.
        args.push("--remote-control".to_string());
    }
    args
}
