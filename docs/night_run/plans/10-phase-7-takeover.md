# Phase 7 - Manual session takeover

## Context

Implements Tasks 7.1 + 7.2 of `docs/superpowers/plans/2026-05-07-claude-chat-hub.md`. Path C version: kill external manual claude, register an Interactive entry with the same session_id, no PTY/process retained. Read "PHASE 7 - Takeover flow (Path C)" in the parent plan.

Manual repro Step 7.3 is SKIPPED per night-run pre-decision.

## Goal

- Replace the stub at `src-tauri/src/chat/takeover.rs` with the implementation that resolves session_id from `~/.claude/sessions/<pid>.json`, kills the manual process tree, registers an Interactive entry.
- Add `takeover_manual` Tauri command to `ipc/chat.rs`. Register in `lib.rs` + capabilities.

## Implementation

`src-tauri/src/chat/takeover.rs`:

```rust
//! Manual -> Interactive takeover. Kills the external manual claude (so it
//! stops mutating the JSONL), resolves the session_id, registers an
//! Interactive entry with the same id. Future user `send_message` calls
//! pick it up via `--resume <session_id>`. No process is spawned here.

use crate::hooks::session_files;
use crate::sessions::registry::Registry;
use std::path::PathBuf;

#[derive(thiserror::Error, Debug)]
pub enum TakeoverError {
    #[error("manual session not found in registry")]
    NotFound,
    #[error("could not resolve session_id from pid {0}")]
    NoSessionFile(u32),
}

/// Returns the captured session_id on success.
pub fn takeover(manual_pid: u32, registry: &Registry) -> Result<String, TakeoverError> {
    let entry = registry.find_by_pid(manual_pid).ok_or(TakeoverError::NotFound)?;
    let cwd: PathBuf = PathBuf::from(&entry.cwd);

    let session_info = session_files::transcript_for_session(manual_pid)
        .map_err(|_| TakeoverError::NoSessionFile(manual_pid))?;
    let session_id = session_info.session_id.clone();

    // Kill external claude tree. Best-effort - if already dead, proceed.
    let _ = crate::channels::kill::kill_tree(manual_pid);

    registry.record_interactive_session(&session_id, &cwd.to_string_lossy());
    Ok(session_id)
}

#[cfg(test)]
mod tests {
    // Integration-only; can't easily mock a real claude process.
}
```

`src-tauri/src/ipc/chat.rs` - add:

```rust
#[tauri::command]
pub async fn takeover_manual(
    manual_pid: u32,
    registry: State<'_, Arc<Registry>>,
) -> Result<String, String> {
    crate::chat::takeover::takeover(manual_pid, &registry).map_err(|e| e.to_string())
}
```

Register in `lib.rs` invoke handler. Add to `capabilities/default.json`.

## Gotchas

- `Registry::find_by_pid` may not exist yet. If it doesn't, add it to `Registry` impl as a sibling to the helpers from Phase 3c:
  ```rust
  pub fn find_by_pid(&self, pid: u32) -> Option<InstanceEntry> {
      self.entries.lock().unwrap().values().find(|e| e.pid == Some(pid)).cloned()
  }
  ```
  (Adapt to actual `entries` field name and synchronization primitive.)
- `hooks::session_files::transcript_for_session` is the canonical resolver per the existing code. If the function name differs, grep `transcript_for` in `src-tauri/src/hooks/` to find the actual name.
- `channels::kill::kill_tree(pid: u32) -> Result<(), Error>` is already cross-platform per CLAUDE.md.
- `record_interactive_session` from Phase 3c overwrites existing entries with the same session_id, which is exactly what we want here (Manual -> Interactive promotion preserving session_id).
- Frontend integration: `sessions-view.js` already calls `invoke('takeover_manual', { manualPid: sess.pid })` from Phase 5c. After this phase lands, that call works.

## Don't

- Don't commit.
- Don't spawn a claude process here. Path C doesn't need a persistent process between turns.
- Don't add a confirmation modal in Rust - the frontend handles user confirmation before invoking.
- Don't wait for SessionEnd hook after kill. The kill itself is the correctness guarantee.

## Acceptance

- `takeover_manual` IPC command exists and is registered.
- `chat::takeover::takeover` is the pure backend logic, callable from anywhere.
- Tests: 175 still pass (no new tests; integration-only).
- `cargo build` clean.
