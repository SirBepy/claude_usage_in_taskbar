//! "Do-X-when-all-sessions-idle" protocol engine.
//!
//! Lives in the Tauri MAIN process (not the daemon). One armed protocol at a
//! time. When armed, a background tokio task:
//!   1. Watches every live session and auto-resolves any blocking prompt
//!      (permission -> allow as-is, question -> first/default option).
//!   2. Once all sessions are idle, injects `/close` into each and waits for
//!      each close turn to finish.
//!   3. Counts down 30s, then fires the terminal action (sleep / shutdown).
//!
//! Cancellation, per-session timeouts, and a no-progress runaway guard keep the
//! task from spinning forever. Every tick emits the current `ProtocolState` to
//! all windows on the `when-done-state` event.

use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};

/// The terminal action to perform once every session has been closed.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum TerminalAction {
    Sleep,
    Shutdown,
}

/// Where the protocol currently is in its lifecycle.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum ProtocolPhase {
    Disarmed,
    Watching,
    Closing,
    CountingDown,
    Firing,
}

/// Snapshot of the protocol, emitted to the frontend each tick.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct ProtocolState {
    pub action: Option<TerminalAction>,
    pub phase: ProtocolPhase,
    pub countdown_remaining_secs: Option<u32>,
    /// Session ids not yet idle/closed.
    pub waiting_on: Vec<String>,
}

impl ProtocolState {
    fn disarmed() -> Self {
        Self {
            action: None,
            phase: ProtocolPhase::Disarmed,
            countdown_remaining_secs: None,
            waiting_on: Vec::new(),
        }
    }
}

/// AppState-held protocol state plus a handle to the running engine task.
pub struct WhenDoneInner {
    pub state: ProtocolState,
    pub task: Option<JoinHandle<()>>,
}

impl Default for WhenDoneInner {
    fn default() -> Self {
        Self {
            state: ProtocolState::disarmed(),
            task: None,
        }
    }
}

const TICK_MS: u64 = 1000;
const COUNTDOWN_SECS: u32 = 30;
const PER_SESSION_TIMEOUT: Duration = Duration::from_secs(180);
const NO_PROGRESS_LIMIT: Duration = Duration::from_secs(180);

/// Path to the repo-root COMMENTS_FOR_BEPY.md. `CARGO_MANIFEST_DIR` is
/// `src-tauri/`, so the repo root is its parent. Compile-time embedded, which is
/// how the dev app (Joe's run mode) resolves it.
fn comments_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("COMMENTS_FOR_BEPY.md")
}

/// Append a one-line entry to COMMENTS_FOR_BEPY.md, creating it with a header if
/// it does not exist. Best-effort: logs on failure, never panics.
fn log_comment(line: &str) {
    use std::io::Write;
    let path = comments_path();
    let exists = path.exists();
    let res = (|| -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        if !exists {
            writeln!(f, "# Comments for Bepy")?;
        }
        writeln!(f, "{line}")
    })();
    if let Err(e) = res {
        log::warn!("when_done: failed to append COMMENTS_FOR_BEPY.md: {e}");
    }
}

/// True when an instance counts as idle/done: not busy. A session left
/// `awaiting == "question"` is handled separately by the prompt poll; if it has
/// no pending prompt entry we still treat `busy == false` as idle.
fn instance_is_idle(i: &crate::types::Instance) -> bool {
    !i.busy
}

/// Currently-live (not ended) session ids from the cached instance list.
fn live_session_ids(app: &AppHandle) -> Vec<String> {
    let state = app.state::<AppState>();
    let guard = state.cached_instances.lock().unwrap();
    guard
        .iter()
        .filter(|i| i.ended_at.is_none())
        .map(|i| i.session_id.clone())
        .collect()
}

/// Snapshot of (session_id, busy) for live sessions.
fn live_busy_map(app: &AppHandle) -> Vec<(String, bool)> {
    let state = app.state::<AppState>();
    let guard = state.cached_instances.lock().unwrap();
    guard
        .iter()
        .filter(|i| i.ended_at.is_none())
        .map(|i| (i.session_id.clone(), i.busy))
        .collect()
}

/// Auto-resolve every pending prompt: allow permissions as-is, answer questions
/// with the first/default option. Logs each auto-answer to COMMENTS_FOR_BEPY.md.
async fn auto_resolve_prompts(app: &AppHandle) {
    let state = app.state::<AppState>();
    let prompts = {
        let guard = state.daemon_client.lock().await;
        match guard.as_ref() {
            Some(c) => c.list_pending_prompts().await.ok(),
            None => None,
        }
    };
    let Some(prompts) = prompts else { return };
    let Some(arr) = prompts.as_array() else { return };

    for p in arr {
        let event = p.get("event").and_then(|v| v.as_str()).unwrap_or("");
        let payload = match p.get("payload") {
            Some(v) => v,
            None => continue,
        };
        let request_id = match payload.get("id").and_then(|v| v.as_str()) {
            Some(id) => id.to_string(),
            None => continue,
        };
        let guard = state.daemon_client.lock().await;
        let Some(client) = guard.as_ref() else { return };

        match event {
            "permission-requested" => {
                // Approve as-is: hand back the original tool input as updatedInput.
                let input = payload
                    .get("input")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                let tool = payload
                    .get("tool_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                if let Err(e) = client
                    .respond_permission(&request_id, true, Some(input), None)
                    .await
                {
                    log::warn!("when_done: auto-allow permission failed: {e}");
                } else {
                    log_comment(&format!(
                        "[when-done] auto-approved permission for tool '{tool}' (id {request_id})"
                    ));
                }
            }
            "question-requested" => {
                let questions = payload.get("questions");
                let answers = default_question_answers(questions);
                if let Err(e) = client.respond_question(&request_id, answers.clone()).await {
                    log::warn!("when_done: auto-answer question failed: {e}");
                } else {
                    log_comment(&format!(
                        "[when-done] auto-answered question with default option(s) (id {request_id})"
                    ));
                }
            }
            _ => {}
        }
    }
}

/// Build the `{ question_text: first_option_label }` answers map for a question
/// payload. Mirrors what the frontend posts to `respond_question`.
fn default_question_answers(questions: Option<&serde_json::Value>) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    if let Some(arr) = questions.and_then(|q| q.as_array()) {
        for q in arr {
            let qtext = q.get("question").and_then(|v| v.as_str()).unwrap_or("");
            if qtext.is_empty() {
                continue;
            }
            let first_label = q
                .get("options")
                .and_then(|o| o.as_array())
                .and_then(|opts| opts.first())
                .and_then(|opt| opt.get("label"))
                .and_then(|l| l.as_str())
                .unwrap_or("");
            map.insert(qtext.to_string(), serde_json::Value::String(first_label.to_string()));
        }
    }
    serde_json::Value::Object(map)
}

/// Inject `/close` into a single session via the daemon.
async fn inject_close(app: &AppHandle, session_id: &str) -> bool {
    let state = app.state::<AppState>();
    let guard = state.daemon_client.lock().await;
    let Some(client) = guard.as_ref() else {
        return false;
    };
    match client.send_message(session_id, "/close").await {
        Ok(()) => true,
        Err(e) => {
            log::warn!("when_done: send /close to {session_id} failed: {e}");
            false
        }
    }
}

/// Read the current ProtocolState under the lock, mutate it via `f`, store it,
/// and emit `when-done-state` with the new value. Returns the new state.
fn update_and_emit<F: FnOnce(&mut ProtocolState)>(
    app: &AppHandle,
    f: F,
) -> ProtocolState {
    let state = app.state::<AppState>();
    let new_state = {
        let mut inner = state.when_done.lock().unwrap();
        f(&mut inner.state);
        inner.state.clone()
    };
    let _ = app.emit("when-done-state", new_state.clone());
    new_state
}

/// Whether cancel was requested: the stored phase has been forced to Disarmed by
/// `cancel_when_done`.
fn is_cancelled(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let inner = state.when_done.lock().unwrap();
    inner.state.phase == ProtocolPhase::Disarmed
}

/// The engine task. Runs until the action fires, the protocol is cancelled, or
/// the runaway guard trips.
async fn run_engine(app: AppHandle, action: TerminalAction) {
    // --- Phase: Watching. Wait for all sessions idle, auto-resolving prompts. ---
    let mut no_progress_since = Instant::now();
    let mut last_idle_signature: Option<Vec<(String, bool)>> = None;

    loop {
        if is_cancelled(&app) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(TICK_MS)).await;
        if is_cancelled(&app) {
            return;
        }

        auto_resolve_prompts(&app).await;

        let busy_map = live_busy_map(&app);
        let waiting: Vec<String> = busy_map
            .iter()
            .filter(|(_, busy)| *busy)
            .map(|(id, _)| id.clone())
            .collect();

        update_and_emit(&app, |s| {
            s.phase = ProtocolPhase::Watching;
            s.waiting_on = waiting.clone();
        });

        // Runaway guard: if the busy signature is unchanged for too long, bail.
        let sig = Some(busy_map.clone());
        if sig != last_idle_signature {
            last_idle_signature = sig;
            no_progress_since = Instant::now();
        } else if no_progress_since.elapsed() > NO_PROGRESS_LIMIT {
            log_comment(
                "[when-done] aborted: no progress in Watching for 3 min (sessions never went idle); disarming",
            );
            update_and_emit(&app, |s| {
                *s = ProtocolState::disarmed();
            });
            return;
        }

        // All live sessions idle? (Empty list counts as idle: nothing to wait on.)
        let guard_idle = {
            let state = app.state::<AppState>();
            let guard = state.cached_instances.lock().unwrap();
            guard
                .iter()
                .filter(|i| i.ended_at.is_none())
                .all(instance_is_idle)
        };
        if guard_idle {
            break;
        }
    }

    if is_cancelled(&app) {
        return;
    }

    // --- Phase: Closing. Inject /close into each live session, wait for each. ---
    let targets = live_session_ids(&app);
    update_and_emit(&app, |s| {
        s.phase = ProtocolPhase::Closing;
        s.waiting_on = targets.clone();
    });

    for session_id in &targets {
        if is_cancelled(&app) {
            return;
        }
        let sent = inject_close(&app, session_id).await;
        if !sent {
            // Couldn't inject (gone or send failed): treat as done, drop it.
            update_and_emit(&app, |s| {
                s.waiting_on.retain(|id| id != session_id);
            });
            continue;
        }

        // Wait for this close turn to complete: busy flips true then back to
        // false, OR the session disappears from the live list. Per-session
        // timeout of 180s.
        let started = Instant::now();
        let mut saw_busy = false;
        loop {
            if is_cancelled(&app) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(TICK_MS)).await;
            // Keep auto-resolving prompts during close turns (e.g. /close that
            // triggers a tool needing permission).
            auto_resolve_prompts(&app).await;

            let busy_map = live_busy_map(&app);
            let present = busy_map.iter().find(|(id, _)| id == session_id);
            match present {
                None => break, // session closed/vanished -> done.
                Some((_, busy)) => {
                    if *busy {
                        saw_busy = true;
                    } else if saw_busy {
                        // ran a turn and is now idle again -> done.
                        break;
                    }
                }
            }

            if started.elapsed() > PER_SESSION_TIMEOUT {
                log_comment(&format!(
                    "[when-done] /close for session {session_id} timed out after 180s; proceeding"
                ));
                break;
            }
        }

        update_and_emit(&app, |s| {
            s.waiting_on.retain(|id| id != session_id);
        });
    }

    if is_cancelled(&app) {
        return;
    }

    // --- Phase: CountingDown. 30s, decrement + emit each second. ---
    update_and_emit(&app, |s| {
        s.phase = ProtocolPhase::CountingDown;
        s.countdown_remaining_secs = Some(COUNTDOWN_SECS);
        s.waiting_on.clear();
    });

    let mut remaining = COUNTDOWN_SECS;
    while remaining > 0 {
        if is_cancelled(&app) {
            return;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        if is_cancelled(&app) {
            return;
        }
        remaining -= 1;
        update_and_emit(&app, |s| {
            s.countdown_remaining_secs = Some(remaining);
        });
    }

    if is_cancelled(&app) {
        return;
    }

    // --- Phase: Firing. Emit, then perform the terminal action. ---
    update_and_emit(&app, |s| {
        s.phase = ProtocolPhase::Firing;
        s.countdown_remaining_secs = Some(0);
    });

    let result = match action {
        TerminalAction::Sleep => crate::system_control::sleep_pc(),
        TerminalAction::Shutdown => crate::system_control::shutdown_pc(),
    };
    if let Err(e) = result {
        log_comment(&format!("[when-done] terminal action failed: {e}"));
        log::error!("when_done: terminal action failed: {e}");
    }
}

// ---------------------------------------------------------------------------
// IPC commands
// ---------------------------------------------------------------------------

/// Arm the protocol: set the action, spawn the engine task (aborting any
/// existing one first), and return the new state.
#[tauri::command]
pub async fn arm_when_done(
    action: TerminalAction,
    state: tauri::State<'_, AppState>,
    app: AppHandle,
) -> Result<ProtocolState, String> {
    // Abort any existing engine task and reset to a fresh Watching state.
    let new_state = {
        let mut inner = state.when_done.lock().unwrap();
        if let Some(handle) = inner.task.take() {
            handle.abort();
        }
        inner.state = ProtocolState {
            action: Some(action),
            phase: ProtocolPhase::Watching,
            countdown_remaining_secs: None,
            waiting_on: Vec::new(),
        };
        inner.state.clone()
    };

    let app_for_task = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        run_engine(app_for_task, action).await;
    });
    {
        let mut inner = state.when_done.lock().unwrap();
        inner.task = Some(handle);
    }

    let _ = app.emit("when-done-state", new_state.clone());
    Ok(new_state)
}

/// Cancel the protocol: abort the engine task, reset to Disarmed, emit, return.
#[tauri::command]
pub async fn cancel_when_done(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
) -> Result<ProtocolState, String> {
    let new_state = {
        let mut inner = state.when_done.lock().unwrap();
        if let Some(handle) = inner.task.take() {
            handle.abort();
        }
        inner.state = ProtocolState::disarmed();
        inner.state.clone()
    };
    let _ = app.emit("when-done-state", new_state.clone());
    Ok(new_state)
}

/// Read the current protocol state.
#[tauri::command]
pub async fn get_when_done_state(
    state: tauri::State<'_, AppState>,
) -> Result<ProtocolState, String> {
    let inner = state.when_done.lock().unwrap();
    Ok(inner.state.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // default_question_answers builds the `{ question_text: first_option_label }`
    // map the auto-resolver hands to respond_question. It is fully pure over a
    // serde_json::Value, so it can be unit-tested without the engine task,
    // AppState, or the daemon. The rest of the engine is integration-only
    // (async tokio task driven by AppState + the daemon client).

    #[test]
    fn picks_the_first_option_label_per_question() {
        let questions = json!([
            {
                "question": "Proceed with the risky thing?",
                "options": [
                    { "label": "Yes, proceed" },
                    { "label": "No, abort" }
                ]
            }
        ]);
        let answers = default_question_answers(Some(&questions));
        assert_eq!(
            answers,
            json!({ "Proceed with the risky thing?": "Yes, proceed" })
        );
    }

    #[test]
    fn maps_every_question_independently() {
        let questions = json!([
            { "question": "Q1", "options": [{ "label": "A1" }, { "label": "B1" }] },
            { "question": "Q2", "options": [{ "label": "A2" }] }
        ]);
        let answers = default_question_answers(Some(&questions));
        assert_eq!(answers, json!({ "Q1": "A1", "Q2": "A2" }));
    }

    #[test]
    fn handles_missing_options_and_blank_questions() {
        // No options -> empty-string answer; blank question text -> skipped;
        // None payload -> empty object. Never panics on malformed input.
        let questions = json!([
            { "question": "No options here" },
            { "question": "", "options": [{ "label": "ignored" }] }
        ]);
        let answers = default_question_answers(Some(&questions));
        assert_eq!(answers, json!({ "No options here": "" }));

        assert_eq!(default_question_answers(None), json!({}));
        assert_eq!(default_question_answers(Some(&json!("not-an-array"))), json!({}));
    }
}
