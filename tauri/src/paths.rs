//! Resolves on-disk paths for app data (settings, history, session).

use anyhow::{anyhow, Result};
use std::path::PathBuf;

/// Returns the directory where we store everything: settings, history, session.
/// On Windows this is `%APPDATA%\claude-usage-tauri`.
pub fn data_dir() -> Result<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| anyhow!("could not resolve user config dir"))?;
    Ok(base.join("claude-usage-tauri"))
}

pub fn settings_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("settings.json"))
}

pub fn history_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("history.jsonl"))
}

pub fn session_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("session.txt"))
}

/// Ensures the data directory exists. Idempotent.
pub fn ensure_data_dir() -> Result<PathBuf> {
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
