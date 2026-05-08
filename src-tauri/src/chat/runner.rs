//! Per-turn process runner. One `claude -p --resume <session_id>` invocation per
//! user message. stdout is piped, line-buffered through ParserContext, events emitted
//! via callback. The child exits naturally when claude finishes the turn.

use crate::chat::parser::ParserContext;
use crate::types::chat::ChatEvent;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

#[derive(thiserror::Error, Debug)]
pub enum RunError {
    #[error("failed to spawn claude: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("claude exited with code {code}, stderr: {stderr}")]
    NonZeroExit { code: i32, stderr: String },
    #[error("metered billing detected: {0} is set. `claude -p` would bill the metered Anthropic API instead of the Pro/Max subscription. Refusing to spawn. Unset {0} to use the subscription path, or run a non-`-p` interactive `claude` session in a terminal.")]
    MeteredBilling(String),
}

/// Env vars whose presence routes `claude -p` to metered billing instead of the
/// Pro/Max subscription. Per https://code.claude.com/docs/en/authentication
/// the auth precedence is: ANTHROPIC_API_KEY > apiKeyHelper > CLAUDE_CODE_OAUTH_TOKEN
/// > Bedrock/Vertex envs > /login OAuth. Of those, only ANTHROPIC_API_KEY,
/// Bedrock, and Vertex are guaranteed metered. ANTHROPIC_AUTH_TOKEN is for
/// custom-auth proxies and may route either way; we err on the side of refusing.
/// CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) is subscription-billed
/// and explicitly NOT in this list.
const METERED_ENV_VARS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
];

/// Refuse to spawn if any env var that would route billing to the metered API
/// is set. The chat hub is designed to consume the user's existing Pro/Max
/// subscription quota (same pool as interactive `claude` sessions); we do not
/// support metered-billing operation. `env_get` is parameterised for testability.
pub fn check_metered_billing(env_get: &dyn Fn(&str) -> Option<String>) -> Result<(), RunError> {
    for key in METERED_ENV_VARS {
        if env_get(key).map(|v| !v.is_empty()).unwrap_or(false) {
            return Err(RunError::MeteredBilling((*key).to_string()));
        }
    }
    Ok(())
}

/// Run one user turn and return all events emitted before claude exited.
/// `session_id` is `None` for the very first turn (no `--resume`); otherwise
/// `Some(<id>)` resumes the prior session.
///
/// `pid_slot`, if provided, receives the spawned child's pid for the duration
/// of the turn so an outside thread (the IPC layer's `cancel_turn` command)
/// can OS-kill the process tree via `channels::kill::kill_tree(pid)`. The
/// slot is cleared again before this function returns. The runner retains
/// ownership of the `Child` so it can call `wait()` for clean reaping; the
/// slot only carries the pid, not the Child handle.
pub fn run_turn<F>(
    cwd: &PathBuf,
    session_id: Option<&str>,
    prompt: &str,
    pid_slot: Option<Arc<Mutex<Option<u32>>>>,
    mut on_event: F,
) -> Result<(), RunError>
where
    F: FnMut(ChatEvent),
{
    check_metered_billing(&|k| std::env::var(k).ok())?;

    let mut cmd = Command::new("claude");
    cmd.arg("-p")
       .arg("--output-format=stream-json")
       .arg("--verbose")
       .arg("--include-partial-messages");
    if let Some(id) = session_id {
        cmd.arg("--resume").arg(id);
    }
    cmd.arg(prompt);
    cmd.current_dir(cwd);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());

    // Windows-only: suppress the black console window that flashes when
    // spawning `claude.exe` (a console subsystem binary) from a GUI Tauri
    // app. CREATE_NO_WINDOW (0x08000000) is the documented flag for "spawn
    // a console process without giving it a visible console". stdout is
    // already piped so we still capture all output.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn()?;
    let pid = child.id();
    let mut stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");

    // Publish pid to the cancel slot so cancel_turn can kill_tree(pid). We
    // never park the Child itself - the runner needs it for wait().
    if let Some(slot) = pid_slot.as_ref() {
        let mut guard = slot.lock().unwrap();
        *guard = Some(pid);
    }

    // Drain stderr on a background thread so a chatty claude can't deadlock
    // by filling its stderr pipe while we're blocked on stdout.
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf);
        buf
    });

    let mut ctx = ParserContext::new();
    let mut buf = [0u8; 4096];
    let mut read_failed = false;
    loop {
        match stdout.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                for ev in ctx.feed(&buf[..n]) {
                    on_event(ev);
                }
            }
            Err(_) => {
                read_failed = true;
                break;
            }
        }
    }

    // If stdout read failed mid-stream the child may still be running; kill it
    // so wait() doesn't hang indefinitely.
    if read_failed {
        let _ = child.kill();
    }

    // Clear pid slot BEFORE wait() so cancel_turn can't snapshot a pid and
    // then have wait() free it back to the OS for recycling, leading to a
    // kill_tree on a recycled-pid process. After this clear, any concurrent
    // cancel_turn observes None and is a no-op; child.wait() then safely
    // reaps the process.
    if let Some(slot) = pid_slot.as_ref() {
        let mut guard = slot.lock().unwrap();
        *guard = None;
    }

    let status = child.wait()?;
    let err_buf = stderr_thread.join().unwrap_or_default();

    if !status.success() {
        return Err(RunError::NonZeroExit {
            code: status.code().unwrap_or(-1),
            stderr: err_buf,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metered_billing_detected_when_anthropic_api_key_set() {
        let env = |k: &str| if k == "ANTHROPIC_API_KEY" { Some("sk-test-123".into()) } else { None };
        let r = check_metered_billing(&env);
        assert!(matches!(r, Err(RunError::MeteredBilling(ref k)) if k == "ANTHROPIC_API_KEY"));
    }

    #[test]
    fn metered_billing_detected_for_bedrock_and_vertex() {
        for key in ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_AUTH_TOKEN"] {
            let env = |k: &str| if k == key { Some("1".into()) } else { None };
            let r = check_metered_billing(&env);
            assert!(matches!(r, Err(RunError::MeteredBilling(ref k)) if k == key), "key {key} not detected");
        }
    }

    #[test]
    fn metered_billing_not_detected_when_no_keys_set() {
        let env = |_: &str| None;
        assert!(check_metered_billing(&env).is_ok());
    }

    #[test]
    fn metered_billing_ignores_empty_string() {
        let env = |k: &str| if k == "ANTHROPIC_API_KEY" { Some(String::new()) } else { None };
        assert!(check_metered_billing(&env).is_ok());
    }

    #[test]
    fn metered_billing_does_not_flag_oauth_token() {
        // CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) is subscription-billed
        // per the auth docs; must not trigger the guard.
        let env = |k: &str| if k == "CLAUDE_CODE_OAUTH_TOKEN" { Some("oat-test".into()) } else { None };
        assert!(check_metered_billing(&env).is_ok());
    }

    /// Confirm run_turn emits a SessionStarted event for the very first turn.
    /// Requires `claude` on PATH; #[ignore]'d by default.
    #[test]
    #[ignore]
    fn first_turn_emits_session_started() {
        let cwd = std::env::temp_dir();
        let mut got_session_started = false;
        let mut got_session_id = None;
        run_turn(&cwd, None, "reply with the literal word OK", None, |ev| match ev {
            ChatEvent::SessionStarted { session_id, .. } => {
                got_session_started = true;
                got_session_id = Some(session_id);
            }
            _ => {}
        }).expect("run_turn");
        assert!(got_session_started);
        assert!(got_session_id.is_some());
    }
}
