# Phase 8a - History JSONL replay + IPC commands

## Context

Implements Tasks 8.1 + 8.2 of `docs/superpowers/plans/2026-05-07-claude-chat-hub.md`. Read "PHASE 8 - History view" in the parent plan.

The chat history for any session lives at `~/.claude/sessions/<session_id>.jsonl` (or under that pattern). The parser from Phase 3a converts each line into a `ChatEvent`. Replay reuses the parser.

## Goal

- Replace the stub at `src-tauri/src/chat/history.rs` with `pub fn replay(path: &Path) -> Result<Vec<ChatEvent>, String>` plus an inline test.
- Add `load_history` and `list_history` IPC commands.
- Add `dirs = "5"` to `[dependencies]` if not present.

## Implementation

`src-tauri/src/chat/history.rs`:

```rust
//! JSONL replay: read a claude session transcript file, emit ChatEvents.

use crate::chat::parser::parse_line;
use crate::types::chat::ChatEvent;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

pub fn replay(path: &Path) -> Result<Vec<ChatEvent>, String> {
    let f = File::open(path).map_err(|e| format!("open {}: {}", path.display(), e))?;
    let reader = BufReader::new(f);
    let mut events = Vec::new();
    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        if let Some(ev) = parse_line(&line) {
            events.push(ev);
        }
    }
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn replays_jsonl_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        let mut f = File::create(&p).unwrap();
        writeln!(f, r#"{{"type":"user","message":{{"role":"user","content":"hi"}},"timestamp":1}}"#).unwrap();
        writeln!(f, r#"{{"type":"assistant","message":{{"role":"assistant","content":"hello"}},"timestamp":2}}"#).unwrap();
        let events = replay(&p).unwrap();
        assert_eq!(events.len(), 2);
        match &events[0] {
            ChatEvent::UserMessage { .. } => {}
            _ => panic!("expected UserMessage"),
        }
    }
}
```

If `parse_line` is private in `parser.rs`, make it `pub fn` in the parser module (it was already a free function; just add the `pub`). Phase 3a's parser code may have it private; bump to public.

`src-tauri/src/ipc/chat.rs` - add the two commands:

```rust
#[tauri::command]
pub async fn load_history(
    session_id: String,
) -> Result<Vec<crate::types::chat::ChatEvent>, String> {
    let home = dirs::home_dir().ok_or("no home")?;
    let path = home.join(".claude").join("sessions").join(format!("{}.jsonl", session_id));
    crate::chat::history::replay(&path)
}

#[tauri::command]
pub async fn list_history(
    project_id: Option<String>,
    search: Option<String>,
    limit: u32,
    offset: u32,
) -> Result<Vec<crate::types::chat::HistoryEntry>, String> {
    let home = dirs::home_dir().ok_or("no home")?;
    let sessions_dir = home.join(".claude").join("sessions");
    if !sessions_dir.exists() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    for f in std::fs::read_dir(&sessions_dir).map_err(|e| e.to_string())? {
        let f = f.map_err(|e| e.to_string())?;
        let p = f.path();
        if p.extension().map(|e| e != "jsonl").unwrap_or(true) {
            continue;
        }
        let title = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let started_at = f.metadata()
            .and_then(|m| m.created())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let ended_at = f.metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);
        entries.push(crate::types::chat::HistoryEntry {
            session_id: title.clone(),
            project_id: String::new(),
            title,
            started_at,
            ended_at,
            message_count: 0,
            last_kind: crate::sessions::kinds::InstanceKind::Manual,
        });
    }
    if let Some(pid) = project_id {
        entries.retain(|e| e.project_id == pid);
    }
    if let Some(q) = search.map(|s| s.to_lowercase()) {
        entries.retain(|e| e.title.to_lowercase().contains(&q));
    }
    entries.sort_by(|a, b| b.ended_at.unwrap_or(0).cmp(&a.ended_at.unwrap_or(0)));
    let start = (offset as usize).min(entries.len());
    let end = ((offset + limit) as usize).min(entries.len());
    Ok(entries[start..end].to_vec())
}
```

Note: `last_kind` is hardcoded to `Manual` for v1 - we can't tell from the JSONL alone whether the session was Interactive or Manual. A follow-up plan can enrich this by cross-referencing the registry.

If `InstanceKind` enum's variants are `Automated, External, Interactive` (no `Manual`), use `External` instead of `Manual` here. Verify by reading `src-tauri/src/sessions/kinds.rs` first.

Register both commands in `lib.rs` invoke handler. Add to capabilities.

## Verification

- `cargo test -p claude-usage-tauri --lib chat::history::tests` - 1 test passes.
- `cargo test -p claude-usage-tauri --lib` - 176 total (175 + 1 new).

## Don't

- Don't commit.
- Don't pre-parse JSONL eagerly for `list_history` - too slow if there are many sessions. The current shape just lists files.
- Don't add a separate cache layer for history.
- Don't break `parse_line`'s pub visibility if changing it breaks Phase 3a's tests.

## Acceptance

- 176 lib tests pass.
- `load_history` returns events for a known session_id.
- `list_history` returns all `.jsonl` files under `~/.claude/sessions/`, sorted newest first, with pagination.
- `cargo build` clean.
