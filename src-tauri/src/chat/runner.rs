//! Per-turn process runner. One `claude -p --resume <session_id>` invocation per
//! user message. stdout is piped, line-buffered through ParserContext, events emitted
//! via callback. The child exits naturally when claude finishes the turn.

use crate::chat::parser::ParserContext;
use crate::types::chat::ChatEvent;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[derive(thiserror::Error, Debug)]
pub enum RunError {
    #[error("failed to spawn claude: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("claude exited with code {code}, stderr: {stderr}")]
    NonZeroExit { code: i32, stderr: String },
}

/// Run one user turn and return all events emitted before claude exited.
/// `session_id` is `None` for the very first turn (no `--resume`); otherwise
/// `Some(<id>)` resumes the prior session.
pub fn run_turn<F>(
    cwd: &PathBuf,
    session_id: Option<&str>,
    prompt: &str,
    mut on_event: F,
) -> Result<(), RunError>
where
    F: FnMut(ChatEvent),
{
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

    let mut child = cmd.spawn()?;
    let mut stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");

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

    /// Confirm run_turn emits a SessionStarted event for the very first turn.
    /// Requires `claude` on PATH; #[ignore]'d by default.
    #[test]
    #[ignore]
    fn first_turn_emits_session_started() {
        let cwd = std::env::temp_dir();
        let mut got_session_started = false;
        let mut got_session_id = None;
        run_turn(&cwd, None, "reply with the literal word OK", |ev| match ev {
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
