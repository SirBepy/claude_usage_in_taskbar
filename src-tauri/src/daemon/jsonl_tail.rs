//! Per-session JSONL tail. Watches the session's transcript file and
//! republishes any new lines as ChatEvents on the session's broadcast
//! channel. Source-of-truth fallback for bridge-triggered turns (phone
//! via claude --remote-control) that don't reach the daemon's stdout pump.
//!
//! Phase 2: emits duplicates if both stdout pump and JSONL tail observe
//! the same turn. Phase 3 adds uuid-based dedup.

use crate::chat::parser::parse_line;
use crate::daemon::broadcast;
use crate::daemon::session::Session;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::fs::File;
use tokio::io::{AsyncBufReadExt, AsyncSeekExt, BufReader, SeekFrom};

pub fn jsonl_path_for(session_id: &str) -> Option<PathBuf> {
    // Claude stores transcripts at ~/.claude/projects/<encoded-cwd>/<session_id>.jsonl
    // Phase 2 scans by basename across all project dirs rather than
    // recomputing the encoded-cwd projection.
    let mut p = dirs::home_dir()?;
    p.push(".claude");
    p.push("projects");
    if let Ok(entries) = std::fs::read_dir(&p) {
        for entry in entries.flatten() {
            let mut candidate = entry.path();
            candidate.push(format!("{session_id}.jsonl"));
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn spawn(session: Arc<Session>) {
    tokio::spawn(async move {
        // Poll for the file to appear (claude creates it after first turn).
        let mut path = None;
        for _ in 0..30 {
            if let Some(p) = jsonl_path_for(&session.session_id) {
                path = Some(p);
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let path = match path {
            Some(p) => p,
            None => {
                log::warn!("daemon: jsonl_tail gave up waiting for {}.jsonl", session.session_id);
                return;
            }
        };

        let mut file = match File::open(&path).await {
            Ok(f) => f,
            Err(e) => {
                log::warn!("daemon: jsonl_tail open failed: {e}");
                return;
            }
        };
        // Seek to end so we only pick up NEW lines (the stdout pump saw the
        // historic ones already).
        let _ = file.seek(SeekFrom::End(0)).await;
        let mut reader = BufReader::new(file);

        loop {
            let mut line = String::new();
            match reader.read_line(&mut line).await {
                Ok(0) => {
                    // EOF; sleep then retry (poll-based tailing).
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                Ok(_) => {
                    for ev in parse_line(line.trim_end()) {
                        broadcast::publish(&session, ev);
                    }
                }
                Err(e) => {
                    log::warn!("daemon: jsonl_tail read failed: {e}");
                    break;
                }
            }
        }
    });
}
