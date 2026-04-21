//! Reads `~/.claude/sessions/<pid>.json` to resolve the
//! `bridgeSessionId` that's needed for remote-control phone links.
//!
//! Claude Code writes this file async after starting. We poll up to
//! 15 × 500ms = ~7.5s before giving up.

use anyhow::Result;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub fn read_bridge_session_id(path: &Path) -> Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(raw) => {
            let v: Value = serde_json::from_str(&raw)?;
            Ok(v.get("bridgeSessionId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn session_file_for_pid(pid: u32) -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("sessions").join(format!("{pid}.json")))
}

/// Polls up to 15 × 500ms for the bridgeSessionId to appear. Returns
/// `None` if the file never materialises or never contains the field.
pub async fn resolve_bridge_session_id(pid: u32) -> Option<String> {
    let Some(path) = session_file_for_pid(pid) else { return None };
    for _ in 0..15 {
        if let Ok(Some(id)) = read_bridge_session_id(&path) {
            return Some(id);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    None
}
