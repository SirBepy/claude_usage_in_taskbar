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

/// True when every live (not-ended) session is idle. An empty list (after
/// filtering out ended sessions) counts as idle: nothing left to wait on.
/// Pure mirror of the inline all-idle check in the Watching loop.
fn all_sessions_idle(instances: &[crate::types::Instance]) -> bool {
    instances
        .iter()
        .filter(|i| i.ended_at.is_none())
        .all(instance_is_idle)
}

/// Session ids still busy, from a `(session_id, busy)` snapshot. Returns exactly
/// the ids whose busy flag is true, in input order; empty when all idle. Pure
/// mirror of the inline `waiting` computation in the Watching loop.
fn waiting_on_ids(busy_map: &[(String, bool)]) -> Vec<String> {
    busy_map
        .iter()
        .filter(|(_, busy)| *busy)
        .map(|(id, _)| id.clone())
        .collect()
}

/// Pure countdown step: the value to emit next, or `None` when the countdown
/// has reached zero and the terminal action should fire. Mirrors the
/// `while remaining > 0 { remaining -= 1; ... }` loop's decision: a positive
/// `remaining` yields `Some(remaining - 1)`, zero yields `None`.
fn next_countdown(remaining: u32) -> Option<u32> {
    if remaining > 0 {
        Some(remaining - 1)
    } else {
        None
    }
}

/// Per-tick close-turn completion check. Given whether the target session is
/// still present in the live list (`Some(busy)`), or has vanished (`None`),
/// updates the `saw_busy` latch and returns true when the close turn is
/// complete: the session vanished, OR it went busy then back to idle. Pure
/// mirror of the inline match in the Closing wait loop (timeout handled by the
/// caller, which stays timing-bound).
fn close_turn_complete(present: Option<bool>, saw_busy: &mut bool) -> bool {
    match present {
        None => true, // session closed/vanished -> done.
        Some(busy) => {
            if busy {
                *saw_busy = true;
                false
            } else if *saw_busy {
                // ran a turn and is now idle again -> done.
                true
            } else {
                false
            }
        }
    }
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
        let waiting: Vec<String> = waiting_on_ids(&busy_map);

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
            all_sessions_idle(&guard)
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
            let present = busy_map
                .iter()
                .find(|(id, _)| id == session_id)
                .map(|(_, busy)| *busy);
            if close_turn_complete(present, &mut saw_busy) {
                break;
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
    while let Some(next) = next_countdown(remaining) {
        if is_cancelled(&app) {
            return;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        if is_cancelled(&app) {
            return;
        }
        remaining = next;
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
    use crate::types::Instance;
    use serde_json::json;

    // --- Fixtures -----------------------------------------------------------

    /// Minimal `Instance` for the pure decision tests. `Instance` has no
    /// `Default`, so build it explicitly; only `session_id`, `busy`, and
    /// `ended_at` drive the logic under test, the rest are inert fillers.
    fn instance(session_id: &str, busy: bool, ended: bool) -> Instance {
        Instance {
            session_id: session_id.into(),
            pid: 0,
            cwd: std::path::PathBuf::from("C:/x"),
            project_id: "proj".into(),
            kind: crate::sessions::kinds::InstanceKind::External,
            is_remote: false,
            started_at: "2026-06-05T00:00:00Z".into(),
            transcript_path: None,
            bridge_session_id: None,
            name: None,
            ended_at: if ended {
                Some("2026-06-05T01:00:00Z".into())
            } else {
                None
            },
            end_reason: None,
            busy,
            model: String::new(),
            effort: String::new(),
            awaiting: None,
        }
    }

    // --- all_sessions_idle --------------------------------------------------

    #[test]
    fn all_sessions_idle_true_when_every_live_instance_not_busy() {
        let live = vec![instance("a", false, false), instance("b", false, false)];
        assert!(all_sessions_idle(&live));
    }

    #[test]
    fn all_sessions_idle_false_when_any_live_instance_busy() {
        let mixed = vec![instance("a", false, false), instance("b", true, false)];
        assert!(!all_sessions_idle(&mixed));
    }

    #[test]
    fn all_sessions_idle_ignores_ended_sessions() {
        // A busy session that has already ended must not block: only live
        // (ended_at == None) sessions count toward the idle check.
        let with_ended_busy = vec![
            instance("live-idle", false, false),
            instance("ended-busy", true, true),
        ];
        assert!(all_sessions_idle(&with_ended_busy));
    }

    #[test]
    fn all_sessions_idle_true_for_empty_and_all_ended() {
        // Empty list -> nothing to wait on -> idle.
        assert!(all_sessions_idle(&[]));
        // All sessions ended (even if busy) -> no live sessions -> idle.
        let all_ended = vec![instance("x", true, true), instance("y", true, true)];
        assert!(all_sessions_idle(&all_ended));
    }

    // --- waiting_on_ids -----------------------------------------------------

    #[test]
    fn waiting_on_ids_returns_only_busy_ids_in_order() {
        let busy_map = vec![
            ("a".to_string(), true),
            ("b".to_string(), false),
            ("c".to_string(), true),
        ];
        assert_eq!(waiting_on_ids(&busy_map), vec!["a".to_string(), "c".to_string()]);
    }

    #[test]
    fn waiting_on_ids_empty_when_all_idle() {
        let busy_map = vec![("a".to_string(), false), ("b".to_string(), false)];
        assert!(waiting_on_ids(&busy_map).is_empty());
        assert!(waiting_on_ids(&[]).is_empty());
    }

    // --- next_countdown -----------------------------------------------------

    #[test]
    fn next_countdown_decrements_until_zero_then_fires() {
        assert_eq!(next_countdown(30), Some(29));
        assert_eq!(next_countdown(29), Some(28));
        assert_eq!(next_countdown(2), Some(1));
        assert_eq!(next_countdown(1), Some(0));
        // Zero -> None: the terminal action should fire.
        assert_eq!(next_countdown(0), None);
    }

    #[test]
    fn next_countdown_full_sequence_emits_29_down_to_0() {
        // Drive it the way the loop does and collect every emitted value.
        let mut remaining = COUNTDOWN_SECS;
        let mut emitted = Vec::new();
        while let Some(next) = next_countdown(remaining) {
            remaining = next;
            emitted.push(remaining);
        }
        let expected: Vec<u32> = (0..COUNTDOWN_SECS).rev().collect(); // 29,28,...,0
        assert_eq!(emitted, expected);
        assert_eq!(emitted.len(), COUNTDOWN_SECS as usize);
    }

    // --- close_turn_complete ------------------------------------------------

    #[test]
    fn close_turn_complete_busy_then_idle_yields_complete() {
        // Sequence: present+idle (no busy yet) -> not done; present+busy ->
        // latch saw_busy, not done; present+idle again -> done.
        let mut saw_busy = false;
        assert!(!close_turn_complete(Some(false), &mut saw_busy)); // idle, never busy
        assert!(!saw_busy);
        assert!(!close_turn_complete(Some(true), &mut saw_busy)); // went busy
        assert!(saw_busy);
        assert!(close_turn_complete(Some(false), &mut saw_busy)); // busy -> idle = done
    }

    #[test]
    fn close_turn_complete_vanished_session_yields_complete() {
        // Session gone from the live list -> done immediately, regardless of
        // whether it was ever seen busy.
        let mut saw_busy = false;
        assert!(close_turn_complete(None, &mut saw_busy));

        let mut saw_busy2 = true;
        assert!(close_turn_complete(None, &mut saw_busy2));
    }

    #[test]
    fn close_turn_complete_idle_without_prior_busy_keeps_waiting() {
        // A session that is present and idle but never went busy is NOT done:
        // its /close turn has not started yet, so keep waiting.
        let mut saw_busy = false;
        assert!(!close_turn_complete(Some(false), &mut saw_busy));
        assert!(!close_turn_complete(Some(false), &mut saw_busy));
        assert!(!saw_busy);
    }

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
