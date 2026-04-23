use anyhow::{Context, Result};
use chrono::{SecondsFormat, Utc};
use std::path::Path;
use super::record::TokenRecord;

pub fn load_history(path: &Path) -> Vec<TokenRecord> {
    let Ok(raw) = std::fs::read_to_string(path) else { return vec![] };
    if raw.trim().is_empty() { return vec![] }
    let Ok(parsed) = serde_json::from_str::<Vec<TokenRecord>>(&raw) else { return vec![] };
    parsed.into_iter().filter(|r| !r.session_id.is_empty()).collect()
}

pub fn save_history(path: &Path, history: &[TokenRecord]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let json = serde_json::to_string_pretty(history).context("serialising token history")?;
    std::fs::write(path, json).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

/// Append a session to disk, idempotent on `session_id`. Returns the updated
/// list so callers can emit it to the webview.
pub fn append_session(path: &Path, mut record: TokenRecord) -> Result<Vec<TokenRecord>> {
    let mut history = load_history(path);
    if history.iter().any(|r| r.session_id == record.session_id) {
        return Ok(history);
    }
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    if record.started_at.is_empty() { record.started_at = now.clone() }
    if record.last_active_at.is_empty() { record.last_active_at = now.clone() }
    if record.recorded_at.is_empty() { record.recorded_at = now }
    history.push(record);
    save_history(path, &history)?;
    Ok(history)
}
