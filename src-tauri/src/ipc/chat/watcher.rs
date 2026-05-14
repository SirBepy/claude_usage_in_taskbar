//! Real-time file watcher for external (read-only) session transcripts.
//!
//! When the Sessions view opens an External session, `watch_session_transcript`
//! tails its JSONL file from EOF and emits `chat:<id>` Tauri events for every
//! new complete line. The frontend event store already listens on `chat:<id>`,
//! so the renderer receives and renders new messages without any extra wiring.
//!
//! `unwatch_session_transcript` drops the watcher and aborts the tail task.

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

struct WatchHandle {
    _watcher: RecommendedWatcher,
    task: tokio::task::JoinHandle<()>,
}

fn watchers() -> &'static Mutex<HashMap<String, WatchHandle>> {
    static W: OnceLock<Mutex<HashMap<String, WatchHandle>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Start tailing `session_id`'s JSONL transcript from the current EOF,
/// emitting a `chat:<session_id>` Tauri event for each new complete line.
/// Idempotent: calling again replaces any existing watcher for the session.
#[tauri::command]
pub async fn watch_session_transcript(
    app: AppHandle,
    session_id: String,
    cwd: Option<String>,
) -> Result<(), String> {
    super::attachments::validate_session_id(&session_id)?;

    // Replace any existing watcher for this session.
    stop_watcher(&session_id);

    let path = tauri::async_runtime::spawn_blocking({
        let sid = session_id.clone();
        let c = cwd.clone();
        move || crate::chat::history::locate_transcript(&sid, c.as_deref())
    })
    .await
    .map_err(|e| e.to_string())??;

    // Tail from current EOF so we only emit new events, not history.
    let initial_offset = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

    let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(16);

    let watched_path = path.clone();
    let mut watcher =
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                let is_write = matches!(
                    event.kind,
                    EventKind::Modify(_) | EventKind::Create(_)
                );
                if is_write && event.paths.iter().any(|p| p == &watched_path) {
                    let _ = tx.blocking_send(());
                }
            }
        })
        .map_err(|e| format!("notify watcher: {e}"))?;

    // Watch the parent directory (more reliable than watching the file itself).
    let parent = path
        .parent()
        .ok_or("transcript has no parent directory")?;
    watcher
        .watch(parent, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch: {e}"))?;

    let sid = session_id.clone();
    let task_path = path.clone();
    let task = tokio::spawn(async move {
        let mut offset = initial_offset;

        while rx.recv().await.is_some() {
            // Drain burst: multiple FS events may fire for one logical write.
            while rx.try_recv().is_ok() {}

            let (new_events, new_offset) = tauri::async_runtime::spawn_blocking({
                let p = task_path.clone();
                let cur = offset;
                move || -> (Vec<crate::types::chat::ChatEvent>, u64) {
                    let mut f = match File::open(&p) {
                        Ok(f) => f,
                        Err(_) => return (vec![], cur),
                    };
                    if f.seek(SeekFrom::Start(cur)).is_err() {
                        return (vec![], cur);
                    }
                    let mut reader = BufReader::new(f);
                    let mut evs = Vec::new();
                    let mut new_off = cur;
                    loop {
                        let mut line = String::new();
                        match reader.read_line(&mut line) {
                            Ok(0) => break,
                            Ok(n) => {
                                if line.ends_with('\n') {
                                    new_off += n as u64;
                                    let trimmed =
                                        line.trim_end_matches(|c| c == '\r' || c == '\n');
                                    if !trimmed.trim().is_empty() {
                                        evs.extend(crate::chat::parser::parse_line(trimmed));
                                    }
                                } else {
                                    // Partial line — wait for the next notification.
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    (evs, new_off)
                }
            })
            .await
            .unwrap_or((vec![], offset));

            offset = new_offset;
            for ev in new_events {
                let _ = app.emit(&format!("chat:{sid}"), ev);
            }
        }
    });

    watchers()
        .lock()
        .unwrap()
        .insert(session_id, WatchHandle { _watcher: watcher, task });

    Ok(())
}

/// Stop the file watcher for `session_id`. No-op if not currently watching.
#[tauri::command]
pub fn unwatch_session_transcript(session_id: String) {
    stop_watcher(&session_id);
}

fn stop_watcher(session_id: &str) {
    if let Some(handle) = watchers().lock().unwrap().remove(session_id) {
        handle.task.abort();
        // _watcher is dropped here, stopping the FS subscription.
    }
}
