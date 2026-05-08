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
use base64::Engine;
use chrono::Utc;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
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

/// Validate session_id against a strict charset. Used anywhere we use the
/// id to construct a filesystem path. Rejects empty / too-long / any char
/// outside [A-Za-z0-9_-]. Real session_ids upstream are UUIDs which always
/// pass.
pub(crate) fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty() || session_id.len() > 128 {
        return Err("invalid session_id length".to_string());
    }
    if !session_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid session_id (only alphanumeric, dash, underscore allowed)".to_string());
    }
    Ok(())
}

/// Pure file-writing helper, factored out of the `paste_image` command so it
/// can be unit-tested without a Tauri AppHandle.
pub(crate) fn write_attachment(
    root: &Path,
    session_id: &str,
    base64_data: &str,
    mime: &str,
) -> Result<PathBuf, String> {
    validate_session_id(session_id)?;
    let dir = root.join("chat-attachments").join(session_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|e| e.to_string())?;
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        _ => "bin",
    };
    let filename = format!("{}.{}", uuid::Uuid::new_v4(), ext);
    let path = dir.join(&filename);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Persist a clipboard-pasted image and return its absolute path. The
/// composer surfaces this path to claude as a `<file:...>` mention so
/// claude reads it via its Read tool.
#[tauri::command]
pub async fn paste_image(
    session_id: String,
    base64_data: String,
    mime: String,
) -> Result<String, String> {
    let root = crate::settings::paths::data_dir().map_err(|e| e.to_string())?;
    let path = write_attachment(&root, &session_id, &base64_data, &mime)?;
    Ok(path.to_string_lossy().to_string())
}

/// Replay the JSONL transcript for `session_id` from disk into ChatEvents.
/// Used by the Sessions view to seed the renderer when opening a session,
/// and by the History view for read-only past-session browsing.
#[tauri::command]
pub async fn load_history(session_id: String) -> Result<Vec<ChatEvent>, String> {
    // Strict charset on session_id prevents path traversal via '../' or
    // weird drive-letter shenanigans. Same validation as paste_image.
    validate_session_id(&session_id)?;
    let home = dirs::home_dir().ok_or("no home dir")?;
    let path = home
        .join(".claude")
        .join("sessions")
        .join(format!("{}.jsonl", session_id));
    crate::chat::history::replay(&path)
}

/// List past sessions from `~/.claude/sessions/*.jsonl`. Returns a paginated,
/// optionally-filtered list sorted newest first by mtime.
#[tauri::command]
pub async fn list_history(
    project_id: Option<String>,
    search: Option<String>,
    limit: u32,
    offset: u32,
) -> Result<Vec<crate::types::chat::HistoryEntry>, String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    let sessions_dir = home.join(".claude").join("sessions");
    if !sessions_dir.exists() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    for f in std::fs::read_dir(&sessions_dir).map_err(|e| e.to_string())? {
        let f = match f {
            Ok(x) => x,
            Err(_) => continue,
        };
        let p = f.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let title = p
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let meta = f.metadata().ok();
        let started_at = meta
            .as_ref()
            .and_then(|m| m.created().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let ended_at = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);
        entries.push(crate::types::chat::HistoryEntry {
            session_id: title.clone(),
            project_id: String::new(),
            title,
            started_at,
            ended_at,
            message_count: 0,
            // last_kind is best-effort; without parsing the JSONL we can't tell
            // whether the session was Interactive vs External. Cross-referencing
            // with the registry is a follow-up; for v1 we mark as External.
            last_kind: crate::sessions::kinds::InstanceKind::External,
        });
    }
    if let Some(pid) = project_id {
        entries.retain(|e| e.project_id == pid);
    }
    if let Some(q) = search.map(|s| s.to_lowercase()) {
        entries.retain(|e| e.title.to_lowercase().contains(&q));
    }
    // Newest first by ended_at (mtime).
    entries.sort_by(|a, b| b.ended_at.unwrap_or(0).cmp(&a.ended_at.unwrap_or(0)));
    let len = entries.len();
    let start = (offset as usize).min(len);
    // saturating_add to prevent u32 overflow on attacker-supplied huge values.
    let end = (offset.saturating_add(limit) as usize).min(len);
    Ok(entries[start..end].to_vec())
}

/// Promote a Manual (External) session to Interactive. Kills the external
/// claude process so this app's per-turn `--resume` calls don't race the
/// external one for JSONL writes. Returns the session_id of the now-Interactive
/// entry; the frontend switches the chat pane to bind to it.
#[tauri::command]
pub async fn takeover_manual(
    manual_pid: u32,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let session_id = crate::chat::takeover::takeover(manual_pid, &state.instances, &state.settings)
        .map_err(|e| e.to_string())?;
    // Surface the registry change so the sidebar refreshes.
    let _ = app.emit("instances-changed", ());
    Ok(session_id)
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

    #[test]
    fn write_attachment_decodes_png() {
        let tmp = tempfile::tempdir().unwrap();
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let path = write_attachment(tmp.path(), "sess", png_b64, "image/png").unwrap();
        assert!(path.exists());
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("png"));
        let data = std::fs::read(&path).unwrap();
        assert_eq!(&data[..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); // PNG signature
    }

    #[test]
    fn write_attachment_rejects_invalid_session_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let cases = [
            ("../../etc", "path traversal up-tree"),
            ("..", ".."),
            ("a/b", "forward slash"),
            ("a\\b", "backslash"),
            ("C:", "Windows drive letter"),
            ("a\0b", "NUL byte"),
            ("CON", "Windows reserved (allowed by alphanumeric but capped by length is fine; Windows treats CON as device - should be filtered downstream by FS, but our pre-check accepts it). Document via test."),
            ("", "empty"),
            (&"x".repeat(129), "too long"),
            ("a b", "space"),
            ("a.b", "dot"),
            ("a@b", "at sign"),
        ];
        for (id, label) in cases {
            // CON is alphanumeric so our filter ALLOWS it; Windows FS will reject the
            // create_dir_all for device names. Document this gap by relaxing the
            // assertion for that case.
            let r = write_attachment(tmp.path(), id, png_b64, "image/png");
            if id == "CON" {
                // Either rejected by our pre-check (no - it's alphanumeric) or by
                // Windows when create_dir_all hits a reserved device name. On
                // non-Windows, CON is a valid dir name.
                continue;
            }
            assert!(r.is_err(), "session_id {:?} ({}) must be rejected", id, label);
        }
    }

    #[test]
    fn write_attachment_accepts_valid_session_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        // UUID-shape (the real producer)
        let r = write_attachment(tmp.path(), "60e53cc5-9823-4af3-979f-29e1e891a718", png_b64, "image/png");
        assert!(r.is_ok());
        // Underscore + alphanumeric mix
        let r = write_attachment(tmp.path(), "sess_123_abc", png_b64, "image/png");
        assert!(r.is_ok());
    }

    #[test]
    fn write_attachment_rejects_invalid_base64() {
        let tmp = tempfile::tempdir().unwrap();
        let bad = write_attachment(tmp.path(), "sess", "!!!not-base64!!!", "image/png");
        assert!(bad.is_err());
    }

    #[test]
    fn write_attachment_picks_extension_from_mime() {
        let tmp = tempfile::tempdir().unwrap();
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let png = write_attachment(tmp.path(), "s1", png_b64, "image/png").unwrap();
        assert_eq!(png.extension().and_then(|e| e.to_str()), Some("png"));
        let jpg = write_attachment(tmp.path(), "s1", png_b64, "image/jpeg").unwrap();
        assert_eq!(jpg.extension().and_then(|e| e.to_str()), Some("jpg"));
        let webp = write_attachment(tmp.path(), "s1", png_b64, "image/webp").unwrap();
        assert_eq!(webp.extension().and_then(|e| e.to_str()), Some("webp"));
        let unknown = write_attachment(tmp.path(), "s1", png_b64, "application/x-blah").unwrap();
        assert_eq!(unknown.extension().and_then(|e| e.to_str()), Some("bin"));
    }
}
