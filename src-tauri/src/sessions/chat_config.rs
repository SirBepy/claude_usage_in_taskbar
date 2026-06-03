//! Durable per-chat model/effort record.
//!
//! The interactive-session snapshot (`persistence.rs`) drops a chat the moment
//! it ends, so a CLOSED chat loses the effort it ran with (effort is only a
//! `--effort` launch flag, never echoed into the transcript). This store keeps
//! a small, never-pruned map keyed by `session_id` so the chat-detail view can
//! still show the effort (and model) of a finished chat.
//!
//! File: `<app-data>/chat-config.json` -> `{ "<session_id>": { model, effort } }`.
//! Sole writer is the daemon (start_session / takeover / set_session_effort);
//! the main app only reads. Writes are atomic (tmp + rename) so a concurrent
//! reader never sees a torn file.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ChatConfig {
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
}

/// Serialize read-modify-write within a process. Cross-process integrity comes
/// from the atomic rename, not this lock.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn config_path() -> Option<PathBuf> {
    crate::settings::paths::data_dir().ok().map(|d| d.join("chat-config.json"))
}

fn load_map(path: &Path) -> HashMap<String, ChatConfig> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_atomic(path: &Path, map: &HashMap<String, ChatConfig>) {
    let json = match serde_json::to_string_pretty(map) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("chat-config: serialize failed: {e}");
            return;
        }
    };
    if let Err(e) = crate::util::write_json_atomic(path, &json) {
        log::warn!("chat-config: write failed: {e}");
    }
}

/// Record (or update) a chat's model/effort. Empty `model`/`effort` are left
/// untouched so an effort-only update keeps the existing model. Best-effort,
/// never panics.
pub fn record(session_id: &str, model: &str, effort: &str) {
    let Some(path) = config_path() else { return };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    record_at(&path, session_id, model, effort);
}

/// Look up a chat's recorded model/effort, or None if it was never recorded
/// (e.g. a chat that closed before this store existed).
pub fn get(session_id: &str) -> Option<ChatConfig> {
    let path = config_path()?;
    get_at(&path, session_id)
}

fn record_at(path: &Path, session_id: &str, model: &str, effort: &str) {
    if session_id.is_empty() {
        return;
    }
    let mut map = load_map(path);
    let entry = map.entry(session_id.to_string()).or_default();
    if !model.is_empty() {
        entry.model = model.to_string();
    }
    if !effort.is_empty() {
        entry.effort = effort.to_string();
    }
    write_atomic(path, &map);
}

fn get_at(path: &Path, session_id: &str) -> Option<ChatConfig> {
    load_map(path).remove(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_model_and_effort() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        record_at(&path, "sess-1", "opus", "high");
        let got = get_at(&path, "sess-1").expect("recorded");
        assert_eq!(got.model, "opus");
        assert_eq!(got.effort, "high");
        assert!(get_at(&path, "missing").is_none());
    }

    #[test]
    fn effort_only_update_keeps_existing_model() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        record_at(&path, "sess-1", "opus", "high");
        // set_session_effort path: model is empty, must not clobber "opus".
        record_at(&path, "sess-1", "", "max");
        let got = get_at(&path, "sess-1").unwrap();
        assert_eq!(got.model, "opus", "model preserved on effort-only update");
        assert_eq!(got.effort, "max");
    }

    #[test]
    fn empty_session_id_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        record_at(&path, "", "opus", "high");
        assert!(!path.exists(), "no file written for empty session id");
    }
}
