# Extract shared transcript-path resolver for load_history / load_history_page

## Goal

Replace the duplicated path-resolution block in `load_history` and `load_history_page` with a single helper.

## Context

`src-tauri/src/ipc/chat.rs` has two IPC commands that resolve a session's JSONL transcript path:

- `load_history` (around line 405-436)
- `load_history_page` (around line 444-481)

Both run the same fallback chain: try `transcript_for_session(cwd, session_id)` first, then scan every directory under `claude_projects_dir()` for `<session_id>.jsonl`. About 20 lines of identical logic.

## Approach

Add a private helper to `src-tauri/src/chat/history.rs` (alongside `replay` and `read_page`):

```rust
pub fn locate_transcript(session_id: &str, cwd: Option<&str>) -> Result<std::path::PathBuf, String> {
    if let Some(cwd_str) = cwd.filter(|s| !s.is_empty()) {
        if let Some(p) = crate::tokens::transcript_for_session(std::path::Path::new(cwd_str), session_id) {
            return Ok(p);
        }
    }
    let projects = crate::tokens::claude_projects_dir().ok_or("no home dir")?;
    let entries = std::fs::read_dir(&projects)
        .map_err(|_| format!("no transcript found for session {session_id}"))?;
    for entry in entries.flatten() {
        let candidate = entry.path().join(format!("{session_id}.jsonl"));
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!("no transcript found for session {session_id}"))
}
```

Update both commands in `ipc/chat.rs` to call `crate::chat::history::locate_transcript(...)` and replay/read_page on the result.

## Acceptance

- `load_history` and `load_history_page` each lose ~15 lines.
- All existing chat tests pass (`cargo test --lib chat::history` plus integration tests).
- New unit test: `locate_transcript` finds via cwd path AND via fallback scan, errors on nonexistent.
