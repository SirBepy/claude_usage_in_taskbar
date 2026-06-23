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
use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};

/// A boxed, owned future the engine seams hand back. The phase machine awaits
/// these without caring whether the body is the real daemon client or a test
/// stub.
type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

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

/// The integration seams the phase machine drives, behind owned closures so the
/// production path can wire the real AppHandle + daemon client while a test wires
/// recording stubs. Every external effect run_engine performs (reading live
/// instances, resolving prompts, injecting /close, emitting state, checking
/// cancellation, firing the terminal action) goes through exactly one of these.
struct EngineDeps {
    /// Snapshot of the live (not-ended) `(session_id, busy)` pairs. Mirrors
    /// `live_busy_map` in production; a test can mutate its source between ticks.
    busy_map: Box<dyn Fn() -> Vec<(String, bool)> + Send>,
    /// Whether every live session is idle. Mirrors the inline
    /// `all_sessions_idle(&cached_instances)` check.
    all_idle: Box<dyn Fn() -> bool + Send>,
    /// Live (not-ended) session ids, in order. Mirrors `live_session_ids`.
    live_ids: Box<dyn Fn() -> Vec<String> + Send>,
    /// Auto-resolve every pending daemon prompt (permission/question). Async.
    auto_resolve: Box<dyn Fn() -> BoxFut<'static, ()> + Send>,
    /// Inject `/close` into one session; true on a successful send. Async.
    inject_close: Box<dyn Fn(String) -> BoxFut<'static, bool> + Send>,
    /// Mutate the stored ProtocolState and emit `when-done-state`. Mirrors
    /// `update_and_emit`; returns the new state.
    mutate_and_emit: Box<dyn Fn(&mut dyn FnMut(&mut ProtocolState)) -> ProtocolState + Send>,
    /// Whether cancel was requested (stored phase forced to Disarmed).
    is_cancelled: Box<dyn Fn() -> bool + Send>,
    /// Perform the terminal action (sleep/shutdown). Returns its Result so the
    /// caller logs a failure exactly as the production path does.
    terminal: Box<dyn Fn(TerminalAction) -> Result<(), String> + Send>,
}

impl EngineDeps {
    /// Wire the real production seams from an AppHandle. This is the only place
    /// that touches AppState / the daemon client / system_control, so the
    /// production behavior is identical to the pre-refactor inline body.
    fn production(app: AppHandle) -> Self {
        let app_busy = app.clone();
        let app_idle = app.clone();
        let app_ids = app.clone();
        let app_resolve = app.clone();
        let app_close = app.clone();
        let app_emit = app.clone();
        let app_cancel = app.clone();
        Self {
            busy_map: Box::new(move || live_busy_map(&app_busy)),
            all_idle: Box::new(move || {
                let state = app_idle.state::<AppState>();
                let guard = state.cached_instances.lock().unwrap();
                all_sessions_idle(&guard)
            }),
            live_ids: Box::new(move || live_session_ids(&app_ids)),
            auto_resolve: Box::new(move || {
                let app = app_resolve.clone();
                Box::pin(async move { auto_resolve_prompts(&app).await })
            }),
            inject_close: Box::new(move |session_id| {
                let app = app_close.clone();
                Box::pin(async move { inject_close(&app, &session_id).await })
            }),
            mutate_and_emit: Box::new(move |f| update_and_emit(&app_emit, f)),
            is_cancelled: Box::new(move || is_cancelled(&app_cancel)),
            terminal: Box::new(|action| match action {
                TerminalAction::Sleep => crate::system_control::sleep_pc(),
                TerminalAction::Shutdown => crate::system_control::shutdown_pc(),
            }),
        }
    }
}

/// The engine task. Thin production wiring: build the real seams, then run the
/// phase machine. All behavior lives in `run_engine_with_deps`.
async fn run_engine(app: AppHandle, action: TerminalAction) {
    run_engine_with_deps(EngineDeps::production(app), action).await;
}

/// The phase machine: Watching -> Closing -> CountingDown -> Firing. Drives only
/// through `deps`, so it is identical for production and tests. Runs until the
/// action fires, the protocol is cancelled, or the runaway guard trips.
async fn run_engine_with_deps(deps: EngineDeps, action: TerminalAction) {
    // --- Phase: Watching. Wait for all sessions idle, auto-resolving prompts. ---
    let mut no_progress_since = Instant::now();
    let mut last_idle_signature: Option<Vec<(String, bool)>> = None;

    loop {
        if (deps.is_cancelled)() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(TICK_MS)).await;
        if (deps.is_cancelled)() {
            return;
        }

        (deps.auto_resolve)().await;

        let busy_map = (deps.busy_map)();
        let waiting: Vec<String> = waiting_on_ids(&busy_map);

        (deps.mutate_and_emit)(&mut |s| {
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
            (deps.mutate_and_emit)(&mut |s| {
                *s = ProtocolState::disarmed();
            });
            return;
        }

        // All live sessions idle? (Empty list counts as idle: nothing to wait on.)
        if (deps.all_idle)() {
            break;
        }
    }

    if (deps.is_cancelled)() {
        return;
    }

    // --- Phase: Closing. Inject /close into each live session, wait for each. ---
    let targets = (deps.live_ids)();
    (deps.mutate_and_emit)(&mut |s| {
        s.phase = ProtocolPhase::Closing;
        s.waiting_on = targets.clone();
    });

    for session_id in &targets {
        if (deps.is_cancelled)() {
            return;
        }
        let sent = (deps.inject_close)(session_id.clone()).await;
        if !sent {
            // Couldn't inject (gone or send failed): treat as done, drop it.
            (deps.mutate_and_emit)(&mut |s| {
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
            if (deps.is_cancelled)() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(TICK_MS)).await;
            // Keep auto-resolving prompts during close turns (e.g. /close that
            // triggers a tool needing permission).
            (deps.auto_resolve)().await;

            let busy_map = (deps.busy_map)();
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

        (deps.mutate_and_emit)(&mut |s| {
            s.waiting_on.retain(|id| id != session_id);
        });
    }

    if (deps.is_cancelled)() {
        return;
    }

    // --- Phase: CountingDown. 30s, decrement + emit each second. ---
    (deps.mutate_and_emit)(&mut |s| {
        s.phase = ProtocolPhase::CountingDown;
        s.countdown_remaining_secs = Some(COUNTDOWN_SECS);
        s.waiting_on.clear();
    });

    let mut remaining = COUNTDOWN_SECS;
    while let Some(next) = next_countdown(remaining) {
        if (deps.is_cancelled)() {
            return;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        if (deps.is_cancelled)() {
            return;
        }
        remaining = next;
        (deps.mutate_and_emit)(&mut |s| {
            s.countdown_remaining_secs = Some(remaining);
        });
    }

    if (deps.is_cancelled)() {
        return;
    }

    // --- Phase: Firing. Emit, then perform the terminal action. ---
    (deps.mutate_and_emit)(&mut |s| {
        s.phase = ProtocolPhase::Firing;
        s.countdown_remaining_secs = Some(0);
    });

    let result = (deps.terminal)(action);
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
            autopilot: false,
            turn_gen: 0,
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

    // --- run_engine_with_deps integration ----------------------------------
    //
    // Drives the whole phase machine through recording stubs instead of the real
    // AppHandle / daemon / system_control. tokio's paused clock makes the 1s
    // ticks + 30s countdown resolve instantly (the std::time::Instant runaway and
    // per-session timeout guards use wall-clock, so they stay un-tripped). The
    // stubs RECORD calls; the terminal stub never actually sleeps/shuts down.

    use std::sync::{Arc, Mutex};

    /// Mutable world the test drives between engine ticks: the live
    /// `(session_id, busy)` snapshot the seams read, plus the recorded effects.
    struct World {
        /// Current live sessions. The test mutates this to simulate sessions
        /// going idle and /close turns running.
        busy_map: Vec<(String, bool)>,
        /// Phases observed via mutate_and_emit, in order. Drives the
        /// progression assertion.
        phases: Vec<ProtocolPhase>,
        /// How many times the terminal action fired, and with what action.
        terminal_calls: Vec<TerminalAction>,
        /// How many /close injections happened, by session id.
        closed: Vec<String>,
        /// Set true to make is_cancelled report cancellation from the next check.
        cancelled: bool,
        /// When true, mutate_and_emit arms `cancelled` once the countdown has
        /// ticked at least once. Lets a test cancel mid-countdown.
        cancel_on_countdown: bool,
        /// The engine's stored ProtocolState, mutated by mutate_and_emit exactly
        /// as the real AppState-held copy would be.
        state: ProtocolState,
    }

    impl Default for World {
        fn default() -> Self {
            Self {
                busy_map: Vec::new(),
                phases: Vec::new(),
                terminal_calls: Vec::new(),
                closed: Vec::new(),
                cancelled: false,
                cancel_on_countdown: false,
                state: ProtocolState::disarmed(),
            }
        }
    }

    impl World {
        fn live_idle(&self) -> bool {
            self.busy_map.iter().all(|(_, busy)| !*busy)
        }
    }

    /// Build EngineDeps backed by a shared `World`. A `tick` hook lets the test
    /// mutate the world each time the engine reads the busy map, so the
    /// simulation advances in lock-step with the phase machine.
    fn deps_for(
        world: Arc<Mutex<World>>,
        // Called every time the engine reads busy_map; returns the next snapshot
        // to install. Lets the test stage "now everything is idle", then "the
        // close turn went busy", then "idle again".
        tick: Arc<Mutex<dyn FnMut(&mut World) + Send>>,
    ) -> EngineDeps {
        let w_busy = world.clone();
        let tick_busy = tick.clone();
        let w_idle = world.clone();
        let w_ids = world.clone();
        let w_resolve = world.clone();
        let w_close = world.clone();
        let w_emit = world.clone();
        let w_cancel = world.clone();
        let w_term = world.clone();

        EngineDeps {
            busy_map: Box::new(move || {
                let mut g = w_busy.lock().unwrap();
                (tick_busy.lock().unwrap())(&mut g);
                g.busy_map.clone()
            }),
            all_idle: Box::new(move || w_idle.lock().unwrap().live_idle()),
            live_ids: Box::new(move || {
                w_ids
                    .lock()
                    .unwrap()
                    .busy_map
                    .iter()
                    .map(|(id, _)| id.clone())
                    .collect()
            }),
            auto_resolve: Box::new(move || {
                let _w = w_resolve.clone();
                Box::pin(async move {
                    // No-op for the test; the real seam talks to the daemon.
                })
            }),
            inject_close: Box::new(move |session_id| {
                let w = w_close.clone();
                Box::pin(async move {
                    w.lock().unwrap().closed.push(session_id);
                    true
                })
            }),
            mutate_and_emit: Box::new(move |f| {
                let mut g = w_emit.lock().unwrap();
                f(&mut g.state);
                let phase = g.state.phase;
                if g.phases.last() != Some(&phase) {
                    g.phases.push(phase);
                }
                // Self-cancel hook: once the countdown is under way and at least
                // one second has ticked off, arm cancellation. Lets a test prove
                // the CountingDown loop short-circuits BEFORE Firing without
                // needing the busy_map tick (which the countdown loop never
                // reads).
                if g.cancel_on_countdown
                    && phase == ProtocolPhase::CountingDown
                    && g.state.countdown_remaining_secs.unwrap_or(COUNTDOWN_SECS) < COUNTDOWN_SECS
                {
                    g.cancelled = true;
                }
                g.state.clone()
            }),
            is_cancelled: Box::new(move || w_cancel.lock().unwrap().cancelled),
            terminal: Box::new(move |action| {
                w_term.lock().unwrap().terminal_calls.push(action);
                Ok(())
            }),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn full_run_progresses_through_phases_and_fires_terminal_once() {
        // Start with one busy session. The tick hook walks the world through:
        //   1. busy   -> Watching keeps waiting,
        //   2. idle   -> Watching breaks, Closing injects /close,
        //   3. busy   -> close turn started (saw_busy latches),
        //   4. idle   -> close turn complete, then CountingDown -> Firing.
        let world = Arc::new(Mutex::new(World {
            busy_map: vec![("s1".to_string(), true)],
            ..Default::default()
        }));

        // Sequence of busy-flags to install on successive busy_map reads. Once
        // exhausted, the session stays idle.
        let steps = Arc::new(Mutex::new(vec![true, false, true, false]));
        let steps_for_tick = steps.clone();
        let tick: Arc<Mutex<dyn FnMut(&mut World) + Send>> =
            Arc::new(Mutex::new(move |w: &mut World| {
                if let Some(next) = {
                    let mut s = steps_for_tick.lock().unwrap();
                    if s.is_empty() {
                        None
                    } else {
                        Some(s.remove(0))
                    }
                } {
                    w.busy_map = vec![("s1".to_string(), next)];
                }
            }));

        let deps = deps_for(world.clone(), tick);
        run_engine_with_deps(deps, TerminalAction::Sleep).await;

        let g = world.lock().unwrap();
        // Phase progression: Watching -> Closing -> CountingDown -> Firing.
        assert_eq!(
            g.phases,
            vec![
                ProtocolPhase::Watching,
                ProtocolPhase::Closing,
                ProtocolPhase::CountingDown,
                ProtocolPhase::Firing,
            ],
            "phase progression"
        );
        // /close was injected exactly once, into the live session.
        assert_eq!(g.closed, vec!["s1".to_string()], "close injection");
        // Terminal action fired EXACTLY ONCE, with the armed action.
        assert_eq!(
            g.terminal_calls,
            vec![TerminalAction::Sleep],
            "terminal fires exactly once"
        );
        // Countdown ran to completion.
        assert_eq!(g.state.countdown_remaining_secs, Some(0));
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_mid_countdown_short_circuits_and_terminal_never_fires() {
        // No busy sessions: Watching breaks on the first idle check, Closing has
        // nothing to inject, so we reach CountingDown immediately. `cancel_on_
        // countdown` flips `cancelled` true once the countdown has ticked at
        // least once, so the engine returns mid-countdown, before Firing.
        let world = Arc::new(Mutex::new(World {
            busy_map: vec![], // empty -> all idle -> straight to closing/countdown
            cancel_on_countdown: true,
            ..Default::default()
        }));

        // No-op tick: the world's busy/idle shape never changes.
        let tick: Arc<Mutex<dyn FnMut(&mut World) + Send>> =
            Arc::new(Mutex::new(|_w: &mut World| {}));

        let deps = deps_for(world.clone(), tick);
        run_engine_with_deps(deps, TerminalAction::Shutdown).await;

        let g = world.lock().unwrap();
        // The countdown was entered (proving this is a mid-countdown cancel, not
        // an early abort).
        assert!(
            g.phases.contains(&ProtocolPhase::CountingDown),
            "should have reached CountingDown before cancel, phases: {:?}",
            g.phases
        );
        // Terminal action MUST NOT have fired.
        assert!(
            g.terminal_calls.is_empty(),
            "cancel must short-circuit before Firing, got {:?}",
            g.terminal_calls
        );
        // Firing must never have been entered.
        assert!(
            !g.phases.contains(&ProtocolPhase::Firing),
            "Firing phase must not be reached after cancel, phases: {:?}",
            g.phases
        );
    }
}
