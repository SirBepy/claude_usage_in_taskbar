//! Chat IPC commands (Path C).
//!
//! - `start_session`: first turn, no `--resume`. Captures the session_id from
//!   the first `SessionStarted` event and registers an Interactive entry.
//! - `send_message`: subsequent turns, with `--resume <session_id>`.
//! - `cancel_turn`: OS-kills the in-flight runner child via `kill_tree(pid)`.
//!
//! The runner emits to `chat:<id>` once we know the id; before that, the
//! webview is responsible for using the placeholder id returned synchronously
//! to the caller.
//!
//! Mutations to the Registry also emit `instances-changed` (per existing
//! convention, the IPC layer fires it after the registry call).

use crate::chat::runner::run_turn;
use crate::state::AppState;
use crate::types::chat::{ChatEvent, ContentBlock};
use chrono::Utc;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// Per-app shared state owned by Tauri. Tracks which sessions have a turn
/// currently running so we can cancel them. Map value is a Mutex carrying
/// the runner's child pid; runner publishes on spawn, clears on exit.
#[derive(Default)]
pub struct ChatState {
    pub running: StdMutex<HashMap<String, Arc<StdMutex<Option<u32>>>>>,
}

impl ChatState {
    pub fn new() -> Self {
        Self { running: StdMutex::new(HashMap::new()) }
    }

    fn allocate(&self, key: &str) -> Arc<StdMutex<Option<u32>>> {
        let mut g = self.running.lock().unwrap();
        let slot = Arc::new(StdMutex::new(None));
        g.insert(key.to_string(), Arc::clone(&slot));
        slot
    }

    fn remove(&self, key: &str) {
        let mut g = self.running.lock().unwrap();
        g.remove(key);
    }

    fn slot(&self, key: &str) -> Option<Arc<StdMutex<Option<u32>>>> {
        self.running.lock().unwrap().get(key).cloned()
    }
}

/// Shared per-turn execution. Runs `claude -p` on a blocking thread, captures
/// session_id from the first SessionStarted event, registers the session,
/// emits ChatEvents over Tauri events, returns the resolved session_id.
async fn run_session_turn(
    session_id_in: Option<String>,
    cwd: String,
    prompt: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let cwd_path = PathBuf::from(&cwd);
    let captured: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(session_id_in.clone()));
    let captured_for_closure = Arc::clone(&captured);
    let registry_for_closure = Arc::clone(&state.instances);
    let app_for_closure = app.clone();
    let initial_id = session_id_in.clone();

    if let Some(ref id) = session_id_in {
        state.instances.set_busy(id, true);
        let _ = app.emit("instances-changed", ());
    }

    // Allocate cancel slot under either the known id or a "pending-..." key.
    let placeholder_id = session_id_in
        .clone()
        .unwrap_or_else(|| format!("pending-{}", Utc::now().timestamp_millis()));
    let chat_state: State<'_, Arc<ChatState>> = app.state();
    let slot = chat_state.allocate(&placeholder_id);
    let placeholder_for_closure = placeholder_id.clone();
    let slot_for_closure = Arc::clone(&slot);

    // Resolve project_id BEFORE spawn_blocking - settings::Mutex isn't shareable
    // through the closure (lifetimes), and we want the upsert to happen anyway
    // regardless of whether SessionStarted ever fires.
    let now_str = Utc::now().to_rfc3339();
    let project_id = {
        let mut s = state.settings.lock().unwrap();
        let (pid, _) = crate::settings::upsert_project_for_cwd(&mut s, &cwd_path, &now_str);
        pid
    };

    let project_id_for_closure = project_id.clone();
    let cwd_for_closure = cwd.clone();
    let now_str_for_closure = now_str.clone();

    // Cleanup guard: ensures chat_state.running entries get removed even if
    // the spawn_blocking closure panics or the runner errors out. Created
    // before spawn_blocking; dropped at the end of the function or via
    // early `?` return. The guard captures placeholder_id by value and
    // looks up the chat_state via the AppHandle when it runs.
    struct Cleanup {
        app: AppHandle,
        placeholder: String,
    }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let chat_state: tauri::State<'_, Arc<ChatState>> = self.app.state();
            chat_state.remove(&self.placeholder);
        }
    }
    let _cleanup = Cleanup {
        app: app.clone(),
        placeholder: placeholder_id.clone(),
    };

    let result = tauri::async_runtime::spawn_blocking(move || {
        run_turn(
            &cwd_path,
            initial_id.as_deref(),
            &prompt,
            Some(slot_for_closure),
            |ev: ChatEvent| {
                if let ChatEvent::SessionStarted { ref session_id, .. } = ev {
                    let mut g = captured_for_closure.lock().unwrap();
                    if g.is_none() {
                        *g = Some(session_id.clone());
                        // Insert directly without re-resolving project_id.
                        registry_for_closure.upsert_interactive(
                            session_id,
                            std::path::Path::new(&cwd_for_closure),
                            &project_id_for_closure,
                            &now_str_for_closure,
                        );
                        registry_for_closure.set_busy(session_id, true);
                        let _ = app_for_closure.emit("instances-changed", ());
                    }
                }
                let target = captured_for_closure
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| placeholder_for_closure.clone());
                let _ = app_for_closure.emit(&format!("chat:{}", target), &ev);
            },
        )
    })
    .await
    .map_err(|e| format!("join: {}", e))?;

    let final_id = captured.lock().unwrap().clone().unwrap_or_default();
    if !final_id.is_empty() {
        state.instances.set_busy(&final_id, false);
    }
    if !final_id.is_empty() && final_id != placeholder_id {
        chat_state.remove(&final_id);
    }
    let _ = app.emit("instances-changed", ());
    // _cleanup drops here, removing placeholder_id from chat_state.running.

    result.map_err(|e| format!("run_turn: {}", e))?;
    Ok(final_id)
}

#[tauri::command]
pub async fn start_session(
    cwd: String,
    prompt: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    run_session_turn(None, cwd, prompt, state, app).await
}

#[tauri::command]
pub async fn send_message(
    session_id: String,
    cwd: String,
    blocks: Vec<ContentBlock>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let prompt = blocks_to_prompt_text(&blocks);
    run_session_turn(Some(session_id), cwd, prompt, state, app).await
}

#[tauri::command]
pub async fn cancel_turn(
    session_id: String,
    chat_state: State<'_, Arc<ChatState>>,
) -> Result<(), String> {
    let slot = chat_state.slot(&session_id);
    if let Some(slot) = slot {
        let pid = slot.lock().unwrap().take();
        if let Some(pid) = pid {
            let _ = crate::channels::kill::kill_tree(pid);
        }
    }
    Ok(())
}

/// Convert ContentBlocks to the single string `claude -p` accepts as its
/// positional prompt arg. Path C does NOT use stream-json input format
/// (interactive doesn't support it), so we flatten to plain text.
/// Image attachments are surfaced as `<file:path>` mentions in Phase 6;
/// this helper just renders Image blocks as a placeholder if they ever
/// arrive without going through the disk-path conversion in the composer.
pub(crate) fn blocks_to_prompt_text(blocks: &[ContentBlock]) -> String {
    let mut out = String::new();
    for b in blocks {
        match b {
            ContentBlock::Text { text } => out.push_str(text),
            ContentBlock::Code { language, text } => {
                let lang = language.clone().unwrap_or_default();
                out.push_str(&format!("```{}\n{}\n```", lang, text));
            }
            ContentBlock::Image { .. } => {
                out.push_str("<image not yet persisted to disk>");
            }
        }
        out.push('\n');
    }
    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_to_prompt_text_text_only() {
        let blocks = vec![ContentBlock::Text { text: "hi".into() }];
        assert_eq!(blocks_to_prompt_text(&blocks), "hi");
    }

    #[test]
    fn blocks_to_prompt_text_code_block_renders_fences() {
        let blocks = vec![ContentBlock::Code {
            language: Some("rust".into()),
            text: "let x = 1;".into(),
        }];
        assert_eq!(blocks_to_prompt_text(&blocks), "```rust\nlet x = 1;\n```");
    }

    #[test]
    fn blocks_to_prompt_text_text_then_code() {
        let blocks = vec![
            ContentBlock::Text { text: "explain this:".into() },
            ContentBlock::Code { language: None, text: "fn main(){}".into() },
        ];
        assert_eq!(blocks_to_prompt_text(&blocks), "explain this:\n```\nfn main(){}\n```");
    }
}
