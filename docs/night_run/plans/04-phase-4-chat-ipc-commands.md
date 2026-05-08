# Phase 4 - Chat IPC commands

## Context

Implements Task 4.1 of `docs/superpowers/plans/2026-05-07-claude-chat-hub.md`. Depends on Phases 3a-3c. Read "PHASE 4 - IPC: chat commands (Path C)" in the parent plan.

Three new tauri commands wire `chat::runner::run_turn` (Phase 3b) into the frontend. The crucial detail: capturing the `session_id` from the `SessionStarted` event inside a `spawn_blocking` closure and returning it as the IPC return value. Use `std::sync::mpsc` or `Arc<Mutex<Option<String>>>` to ship the captured id back across the closure boundary.

## Goal

Create `src-tauri/src/ipc/chat.rs` with:
- `pub struct ChatState` holding running-turn child handles (`Mutex<HashMap<String, Arc<StdMutex<Option<std::process::Child>>>>>`)
- `#[tauri::command] pub async fn start_session(cwd: String, prompt: String, ...) -> Result<String, String>`
- `#[tauri::command] pub async fn send_message(session_id: String, cwd: String, blocks: Vec<ContentBlock>, ...) -> Result<(), String>`
- `#[tauri::command] pub async fn cancel_turn(session_id: String, ...) -> Result<(), String>`
- Helper `fn blocks_to_prompt_text(blocks: &[ContentBlock]) -> String` with 3 unit tests

Add `pub mod chat;` to `src-tauri/src/ipc.rs`. Register the three commands in `src-tauri/src/lib.rs` `tauri::generate_handler!`. Add `.manage(std::sync::Arc::new(crate::ipc::chat::ChatState::new()))` to the setup block. Update `src-tauri/capabilities/default.json` with the three permissions.

## Implementation

Use the parent plan's "Task 4.1: Implement chat IPC commands" Step 1 code as the starting skeleton. The `run_session_turn` helper there has a known channel-passing problem flagged in the brief - fix it before tests run by adding an `Arc<StdMutex<Option<String>>>` for the captured session_id:

```rust
async fn run_session_turn(
    session_id_in: Option<String>,
    cwd: String,
    prompt: String,
    state: &Arc<ChatState>,
    registry: &Arc<Registry>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    use std::sync::Mutex as StdMutex;
    let cwd_path = PathBuf::from(&cwd);
    let captured: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(session_id_in.clone()));
    let captured_for_closure = captured.clone();
    let registry_for_closure = registry.clone();
    let cwd_for_closure = cwd.clone();
    let app_for_closure = app.clone();
    let initial_id = session_id_in.clone();

    if let Some(ref id) = session_id_in {
        registry.set_busy(id, true);
    }

    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::chat::runner::run_turn(
            &cwd_path,
            initial_id.as_deref(),
            &prompt,
            |ev: crate::types::chat::ChatEvent| {
                if let crate::types::chat::ChatEvent::SessionStarted { ref session_id, .. } = ev {
                    let mut guard = captured_for_closure.lock().unwrap();
                    if guard.is_none() {
                        *guard = Some(session_id.clone());
                        registry_for_closure.record_interactive_session(session_id, &cwd_for_closure);
                        registry_for_closure.set_busy(session_id, true);
                    }
                }
                let target = captured_for_closure.lock().unwrap().clone().unwrap_or_else(|| "pending".into());
                let _ = app_for_closure.emit(&format!("chat:{}", target), &ev);
            },
        )
    }).await.map_err(|e| e.to_string())?;

    let final_id = captured.lock().unwrap().clone().unwrap_or_default();
    if !final_id.is_empty() {
        registry.set_busy(&final_id, false);
    }
    result.map_err(|e| e.to_string())?;
    Ok(final_id)
}
```

For `cancel_turn`: the `ChatState.running` map needs to be populated when `run_session_turn` starts. Currently the sketch above doesn't track the child for cancellation. Add: before spawn_blocking, insert a placeholder; during the runner's spawn, the runner returns `Result<(), RunError>` not the Child handle. To support cancellation, modify `chat::runner::run_turn` to take an `Arc<StdMutex<Option<Child>>>` parameter where the runner stores the `Child` after spawn but before reading stdout. `cancel_turn` then takes that Mutex and calls `child.kill()`. Adjust the runner's signature accordingly:

```rust
pub fn run_turn<F>(
    cwd: &PathBuf,
    session_id: Option<&str>,
    prompt: &str,
    child_slot: Option<Arc<StdMutex<Option<std::process::Child>>>>,
    mut on_event: F,
) -> Result<(), RunError>
```

If `child_slot` is `Some`, store the Child there after `cmd.spawn()?` and clear it after `child.wait()?`. If `None`, behave as today.

This is a Phase 4 internal change to the runner. Update Phase 3b's runner.rs accordingly during this plan. Re-run all parser+runner tests to confirm green.

## Gotchas

- `run_turn` was previously specified without a `child_slot` parameter. Update it as part of this plan; that's not scope creep, it's making cancellation actually work.
- `tauri::async_runtime::spawn_blocking` returns `JoinHandle<T>` where `T = Result<(), RunError>` here. Two layers of `Result`: outer for join failure, inner for spawn/exit failure.
- The `pending` placeholder event name (`chat:pending`) is fine as a transient - the frontend can listen on `chat:<knownId>` after `start_session` returns.
- `capabilities/default.json` syntax: read the existing file first. If it uses raw permission strings (e.g. `"chat:allow-start-session"` without identifier+allow nesting), follow that. The exact JSON shape varies by Tauri 2 version.

## Tests

- `cargo test -p claude-usage-tauri --lib ipc::chat::tests` shows 3 passed (the `blocks_to_prompt_text` tests).
- `cargo build -p claude-usage-tauri` clean.
- `cargo test -p claude-usage-tauri --lib` total 174 passed.

## Don't

- Don't commit.
- Don't change `chat::runner` API beyond adding the optional `child_slot` parameter described above.
- Don't add unrequested commands.
- Don't introduce new dependencies.

## Acceptance

- 174 lib tests pass.
- All three commands registered + allowlisted.
- `run_turn` signature accepts `Option<Arc<StdMutex<Option<Child>>>>` and stores the Child if Some.
- `cancel_turn` actually kills the in-flight runner child.
