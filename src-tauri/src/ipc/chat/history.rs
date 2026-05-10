//! Read-only transcript replays for the chat hub.
//!
//! Distinct from `crate::chat::history` (the pure JSONL reader): this module
//! is the IPC surface that wraps it for the Sessions and History views.

use super::attachments::validate_session_id;
use crate::types::chat::ChatEvent;

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
