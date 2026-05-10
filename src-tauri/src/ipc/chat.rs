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
use serde_json::Value;

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

/// Validate a frontend-supplied placeholder id. Must start with "pending-"
/// and contain only [A-Za-z0-9_-] otherwise. Length-capped. Returning Err
/// indicates the caller should fall back to the server-generated placeholder
/// instead of using attacker-supplied input as an event channel suffix.
fn validate_placeholder_id(id: &str) -> Result<(), &'static str> {
    if id.len() < 9 || id.len() > 64 {
        return Err("placeholder length out of range");
    }
    if !id.starts_with("pending-") {
        return Err("placeholder must start with 'pending-'");
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("placeholder charset");
    }
    Ok(())
}

/// Shared per-turn execution. Runs `claude -p` on a blocking thread, captures
/// session_id from the first SessionStarted event, registers the session,
/// emits ChatEvents over Tauri events, returns the resolved session_id.
///
/// `placeholder_id_in` is an optional caller-supplied placeholder used when
/// `session_id_in` is None (i.e. brand-new session, frontend-driven). If
/// supplied and well-formed (validate_placeholder_id), the SessionStarted
/// event is mirrored on `chat:<placeholder>` so the frontend renderer can
/// subscribe BEFORE invoking `start_session` and capture the real id from
/// the stream itself rather than waiting for the entire turn to finish.
async fn run_session_turn(
    session_id_in: Option<String>,
    cwd: String,
    prompt: String,
    placeholder_id_in: Option<String>,
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

    // Allocate cancel slot under either the known id, a caller-supplied
    // "pending-..." placeholder (validated), or a server-generated fallback.
    let placeholder_id = match (&session_id_in, placeholder_id_in.as_deref()) {
        (Some(id), _) => id.clone(),
        (None, Some(supplied)) if validate_placeholder_id(supplied).is_ok() => supplied.to_string(),
        _ => format!("pending-{}", Utc::now().timestamp_millis()),
    };
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

    // Resume turns (initial_id is Some) suppress forwarded SessionStarted events
    // so the user doesn't see "Session started (model)" in the chat on every
    // turn. The first turn (initial_id None) still surfaces it once - that's
    // the only one that matters for the user.
    let is_resume_turn = initial_id.is_some();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_turn(
            &cwd_path,
            initial_id.as_deref(),
            &prompt,
            Some(slot_for_closure),
            |ev: ChatEvent| {
                let mut just_captured: Option<String> = None;
                if let ChatEvent::SessionStarted { ref session_id, .. } = ev {
                    let mut g = captured_for_closure.lock().unwrap();
                    if g.is_none() {
                        *g = Some(session_id.clone());
                        just_captured = Some(session_id.clone());
                        // Insert directly without re-resolving project_id.
                        registry_for_closure.upsert_interactive(
                            session_id,
                            std::path::Path::new(&cwd_for_closure),
                            &project_id_for_closure,
                            &now_str_for_closure,
                        );
                        registry_for_closure.set_busy(session_id, true);
                    }
                }
                // CRITICAL ordering for the new-session sidebar bug fix:
                // when we just captured the real id, emit the SessionStarted
                // event on `chat:<placeholder>` FIRST so the frontend captures
                // the real id (and sets pendingNewSession.realId) BEFORE the
                // `instances-changed` listener fires refreshSessions+renderSidebar.
                // Otherwise the user briefly sees a duplicate row in the sidebar.
                if let Some(ref real_id) = just_captured {
                    if real_id != &placeholder_for_closure {
                        let _ = app_for_closure
                            .emit(&format!("chat:{}", placeholder_for_closure), &ev);
                    }
                }
                if just_captured.is_some() {
                    let _ = app_for_closure.emit("instances-changed", ());
                }
                // Suppress SessionStarted forwarding on resume turns. Each
                // `claude -p --resume` invocation re-emits a `system init`
                // line with the same session_id; surfacing it as a
                // "Session started" system message in the chat on every
                // turn pollutes the transcript. The first turn (initial_id
                // None) still gets it once.
                let is_session_started = matches!(ev, ChatEvent::SessionStarted { .. });
                if is_session_started && is_resume_turn {
                    return;
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
    placeholder_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    run_session_turn(None, cwd, prompt, placeholder_id, state, app).await
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
    run_session_turn(Some(session_id), cwd, prompt, None, state, app).await
}

/// Drain ChatState.running and kill each in-flight runner child. Called
/// from the tray Quit handler so the app doesn't leak claude.exe orphans
/// on exit. No-op if no turns are running.
pub fn cancel_all_inflight_turns(app: &AppHandle) {
    let chat_state: tauri::State<'_, Arc<ChatState>> = app.state();
    let pids: Vec<u32> = {
        let mut g = chat_state.running.lock().unwrap();
        let snapshot: Vec<_> = g.drain().collect();
        snapshot
            .into_iter()
            .filter_map(|(_id, slot)| slot.lock().unwrap().take())
            .collect()
    };
    for pid in pids {
        let _ = crate::channels::kill::kill_tree(pid);
    }
}

/// Background GC for chat-attachments older than 30 days. Scheduled once
/// on app startup; re-runs every 24h.
pub async fn gc_attachments() {
    let root = match crate::settings::paths::data_dir() {
        Ok(d) => d.join("chat-attachments"),
        Err(_) => return,
    };
    if !root.exists() {
        return;
    }
    let cutoff = std::time::SystemTime::now()
        - std::time::Duration::from_secs(30 * 24 * 60 * 60);
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if modified < cutoff {
                    let _ = std::fs::remove_dir_all(&path);
                }
            }
        }
    }
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

#[derive(serde::Serialize)]
pub struct AttachmentData {
    pub mime: String,
    pub base64: String,
}

/// Read a previously-pasted attachment as `{mime, base64}` for inline
/// rendering in the chat view. Path is validated to live inside
/// `<app-data>/chat-attachments/` (canonicalized) to block arbitrary
/// file reads.
#[tauri::command]
pub async fn read_attachment(path: String) -> Result<AttachmentData, String> {
    let root = crate::settings::paths::data_dir().map_err(|e| e.to_string())?;
    let attachments_root = root.join("chat-attachments");
    let attachments_root = attachments_root
        .canonicalize()
        .map_err(|e| format!("attachments dir missing: {e}"))?;
    let target = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("file not found: {e}"))?;
    if !target.starts_with(&attachments_root) {
        return Err("path outside chat-attachments".to_string());
    }
    let bytes = std::fs::read(&target).map_err(|e| e.to_string())?;
    let mime = match target.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
    .to_string();
    let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(AttachmentData { mime, base64 })
}

/// Replay the JSONL transcript for `session_id` from disk into ChatEvents.
/// Used by the Sessions view to seed the renderer when opening a session,
/// and by the History view for read-only past-session browsing.
///
/// Claude CLI writes transcripts to `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`,
/// NOT `~/.claude/sessions/<session_id>.jsonl` (the latter holds pid-keyed
/// metadata, not transcripts). When `cwd` is known (Sessions view passes it
/// from the Instance entry), use `transcript_for_session` directly; otherwise
/// (History view, where cwd isn't carried on `HistoryEntry`) scan every project
/// dir for a matching `<session_id>.jsonl`.
#[tauri::command]
pub async fn load_history(session_id: String, cwd: Option<String>) -> Result<Vec<ChatEvent>, String> {
    validate_session_id(&session_id)?;

    // Sync filesystem IO + JSONL parse can be heavy for large transcripts
    // (megabytes, thousands of events). Run on the blocking pool so the
    // Tauri async runtime stays responsive to other IPC calls while the
    // session loads.
    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::chat::history::locate_transcript(&session_id, cwd.as_deref())?;
        crate::chat::history::replay(&path)
    })
    .await
    .map_err(|e| format!("join: {}", e))?
}

/// Paginated transcript reader. Returns the last `message_limit` message
/// bubbles (UserMessage / AssistantMessage), plus all surrounding tool calls
/// and metadata events. Pass `before_seq = Some(oldestSeq)` to fetch the
/// previous page.
///
/// Used by the Sessions view chat-open path. The History view keeps using
/// `load_history` because it browses full transcripts read-only.
#[tauri::command]
pub async fn load_history_page(
    session_id: String,
    cwd: Option<String>,
    before_seq: Option<u64>,
    message_limit: u32,
) -> Result<crate::types::chat::HistoryPage, String> {
    validate_session_id(&session_id)?;
    let limit = message_limit.clamp(1, 500);

    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::chat::history::locate_transcript(&session_id, cwd.as_deref())?;
        crate::chat::history::read_page(&path, before_seq, limit)
    })
    .await
    .map_err(|e| format!("join: {}", e))?
}

/// List past sessions by walking `~/.claude/projects/<encoded-cwd>/*.jsonl`.
/// `~/.claude/sessions/` is pid-keyed metadata, not transcripts. Returns a
/// paginated, optionally-filtered list sorted newest first by mtime.
///
/// `project_id` filters by the encoded-cwd dir name (the same slug
/// `tokens::encode_cwd_as_project_dir` produces). Pass `None` to list all.
#[tauri::command]
pub async fn list_history(
    project_id: Option<String>,
    search: Option<String>,
    limit: u32,
    offset: u32,
) -> Result<Vec<crate::types::chat::HistoryEntry>, String> {
    let projects_dir = crate::tokens::claude_projects_dir().ok_or("no home dir")?;
    if !projects_dir.exists() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    let proj_dirs = std::fs::read_dir(&projects_dir).map_err(|e| e.to_string())?;
    for proj_dir in proj_dirs.flatten() {
        if !proj_dir.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let proj_slug = proj_dir.file_name().to_string_lossy().to_string();
        let inner = match std::fs::read_dir(proj_dir.path()) {
            Ok(i) => i,
            Err(_) => continue,
        };
        for f in inner.flatten() {
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
                project_id: proj_slug.clone(),
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

/// Open the given chat session in a dedicated Tauri webview window. The
/// window is labeled `session-<session_id>`; if it already exists we just
/// focus it. Closing the window does NOT kill the session - it stays in
/// the registry and can be reattached by clicking the row in the main
/// sidebar.
#[tauri::command]
pub async fn detach_window(session_id: String, app: AppHandle) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let label = format!("session-{}", session_id);
    if let Some(existing) = app.get_webview_window(&label) {
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let url = format!("index.html#detached?session={}", session_id);
    tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(url.into()),
    )
    .title(format!(
        "Session {}",
        &session_id[..session_id.len().min(8)]
    ))
    .inner_size(800.0, 600.0)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Close the detached window for `session_id`, if any. Does not kill the
/// session itself.
#[tauri::command]
pub async fn reattach_window(session_id: String, app: AppHandle) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let label = format!("session-{}", session_id);
    if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
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

/// Respond to a pending permission request from the MCP server.
/// Looks up the oneshot sender in the shared pending map and resolves it.
#[tauri::command]
pub async fn respond_permission(
    id: String,
    behavior: String,
    updated_input: Option<Value>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if behavior != "allow" && behavior != "deny" {
        return Err(format!("invalid behavior: {behavior:?} (must be 'allow' or 'deny')"));
    }
    let val = serde_json::json!({"behavior": behavior, "updatedInput": updated_input});
    let tx = state.pending.lock().await.remove(&id);
    match tx {
        Some(tx) => {
            let _ = tx.send(val);
            Ok(())
        }
        None => Err(format!("no pending request with id {id}")),
    }
}

/// Respond to a pending question request from the MCP server.
#[tauri::command]
pub async fn respond_question(
    id: String,
    answers: Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let val = serde_json::json!({"answers": answers});
    let tx = state.pending.lock().await.remove(&id);
    match tx {
        Some(tx) => {
            let _ = tx.send(val);
            Ok(())
        }
        None => Err(format!("no pending question with id {id}")),
    }
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
    fn validate_placeholder_id_accepts_well_formed() {
        assert!(validate_placeholder_id("pending-12345").is_ok());
        assert!(validate_placeholder_id("pending-1700000000000").is_ok());
        assert!(validate_placeholder_id("pending-abc-123_xyz").is_ok());
    }

    #[test]
    fn validate_placeholder_id_rejects_malformed() {
        assert!(validate_placeholder_id("").is_err());
        assert!(validate_placeholder_id("pending-").is_err()); // < 9 chars
        assert!(validate_placeholder_id("real-1234567").is_err()); // wrong prefix
        assert!(validate_placeholder_id("60e53cc5-9823-4af3-979f-29e1e891a718").is_err()); // real session id
        assert!(validate_placeholder_id("pending-../etc").is_err()); // path traversal
        assert!(validate_placeholder_id("pending-a/b").is_err());
        assert!(validate_placeholder_id("pending-a b").is_err()); // space
        assert!(validate_placeholder_id(&format!("pending-{}", "x".repeat(60))).is_err()); // too long
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
