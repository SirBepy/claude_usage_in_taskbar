# Phase 10 - Polish: app-quit cleanup + GC + docs update

## Context

Implements Tasks 10.1 + 10.2 + 10.3 of `docs/superpowers/plans/2026-05-07-claude-chat-hub.md`. Task 10.4 (final manual verification) is SKIPPED per night-run pre-decision. Read "PHASE 10 - Polish, cleanup, docs" in the parent plan.

## Goal

Three small chores:
1. **App-quit cleanup of in-flight turns.** Drain `ChatState.running` and kill each child on tray Quit.
2. **Image attachment GC.** Background task that deletes `<app-data>/chat-attachments/<*>` directories whose `mtime` is older than 30 days. Schedule on app start, run once daily.
3. **CLAUDE.md + README.md identity update.** Reflect the new "Claude companion" identity (usage tracker + sessions + chat).

## Implementation

### 10.1: App-quit cleanup

Locate the tray Quit handler (grep `"quit"` or `tray_quit` in `src-tauri/src/`). Add before existing quit logic:

```rust
fn cancel_all_inflight_turns(app: &tauri::AppHandle) {
    use std::sync::Arc;
    let state: tauri::State<Arc<crate::ipc::chat::ChatState>> = app.state();
    let running: Vec<_> = futures::executor::block_on(async {
        state.running.lock().await.drain().collect()
    });
    for (_sid, child_arc) in running {
        let mut guard = child_arc.lock().unwrap();
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
        }
    }
}
```

Call `cancel_all_inflight_turns(&app_handle)` at the start of the existing quit handler. If the existing handler is async, wrap appropriately.

### 10.3: Image attachment GC

Add to `src-tauri/src/chat.rs` (or a new submodule `src-tauri/src/chat/gc.rs`):

```rust
//! Background GC for chat-attachments older than 30 days.

pub async fn gc_attachments(app: tauri::AppHandle) {
    use tauri::Manager;
    let app_data = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => return,
    };
    let root = app_data.join("chat-attachments");
    if !root.exists() { return; }
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(30 * 24 * 60 * 60);
    if let Ok(entries) = std::fs::read_dir(&root) {
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
}
```

Schedule on app start in `src-tauri/src/lib.rs` `setup`:

```rust
let app_handle = app.handle().clone();
tauri::async_runtime::spawn(async move {
    loop {
        crate::chat::gc_attachments(app_handle.clone()).await;
        tokio::time::sleep(std::time::Duration::from_secs(24 * 3600)).await;
    }
});
```

If `gc_attachments` lives in `chat::gc`, use `crate::chat::gc::gc_attachments`. If it's a free function in `chat.rs`, then `crate::chat::gc_attachments`. Pick whichever is cleaner; either is fine.

### 10.2: Documentation updates

Edit `CLAUDE.md` opening paragraph to reflect the new identity. The current opening is:

```
Cross-platform system tray app (Tauri 2) that monitors Claude AI usage by
scraping the Claude settings/usage page via a CDP-driven hidden Chrome
tab, once per hour. Windows, macOS, and Linux (x86_64 DEB + AppImage) supported.
```

Replace with:

```
Cross-platform Claude companion (Tauri 2) for Claude Code users. Combines:
- Usage monitoring (5h / 7d windows) via CDP-driven hidden Chrome scraping
- Live Sessions view that owns interactive Claude chat sessions across all
  the user's projects via per-turn `claude -p --resume <id>` invocations
- Custom HTML chat renderer with image paste, markdown, syntax highlighting
- Hooks system surfacing live instance state across all session kinds
  (Manual / Automated / Remote / Interactive)

Windows, macOS, and Linux (x86_64 DEB + AppImage) supported. Linux gets the
chat hub but not the future character-overlay work (Wayland click-through
gap).
```

Add a new section to CLAUDE.md right after "Architecture" that describes the chat hub modules:

```markdown
## Chat hub (Path C architecture)

The Sessions view spawns one `claude -p --resume <session_id>` process per
user turn. The runner reads stdout line by line, parses the line-delimited
stream-json, and emits `ChatEvent`s to the webview via Tauri events. No
persistent claude child between turns. No PTY, no ANSI parsing. Cost is
per-turn; ~$0.04-0.17 observed during the Phase 0 spike.

Key modules:
- `src-tauri/src/chat/runner.rs` - per-turn process spawn, stdout pump
- `src-tauri/src/chat/parser.rs` - line-delimited stream-json -> ChatEvent
- `src-tauri/src/chat/takeover.rs` - kill external manual claude, register
  Interactive entry with same session_id (next turn picks it up)
- `src-tauri/src/chat/history.rs` - JSONL replay (reuses parser)
- `src-tauri/src/ipc/chat.rs` - start_session / send_message / cancel_turn
  / paste_image / takeover_manual / load_history / list_history /
  detach_window / reattach_window
- `src/modules/chat-renderer.js` - virtualized scroll, ChatEvent -> DOM
- `src/modules/composer.js` - textarea + image paste
- `src/modules/sessions-view.js` - sidebar + main pane orchestration
- `src/modules/history-view.js` - read-only past sessions

Image paste flow: composer captures clipboard -> POSTs base64 + mime to
`paste_image` IPC -> Rust writes to `<app-data>/chat-attachments/<sid>/
<uuid>.<ext>` -> returns path -> composer pushes `<file:<path>>` mention
text into the next turn's prompt. claude reads the file via its Read tool.
```

Update `README.md` similarly. Keep the README user-facing tone.

## Don't

- Don't commit (night-run handles).
- Don't add unrelated docs sections.
- Don't break existing CLAUDE.md sections - only modify the opening + add the new "Chat hub" section.
- Don't change the file-table in CLAUDE.md unless you also re-verify every file path is correct.

## Acceptance

- App-quit cleanup function exists and is wired into the tray Quit handler.
- `gc_attachments` runs once on app start and re-runs every 24h.
- `CLAUDE.md` and `README.md` reflect the new identity.
- 176 lib tests still pass.
- `cargo build` clean.
- Phase 10.4 manual verification skipped per night-run pre-decision.
