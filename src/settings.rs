//! Load and save user settings to disk.

use crate::types::Settings;
use anyhow::{Context, Result};
use std::path::Path;

/// Loads settings from disk. If the file is missing or corrupt, returns defaults
/// (and does NOT rewrite the file automatically — the caller decides when to save).
pub fn load(path: &Path) -> Settings {
    let mut s: Settings = match std::fs::read_to_string(path) {
        Err(_) => Settings::default(),
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
    };
    // Migrate stale default from earlier tauri-rewrite builds that shipped
    // with a 1-hour poll before the 10-minute default landed. No UI ever
    // exposed this value, so any persisted 3600 is the old default, not
    // a user choice.
    if s.poll_interval_secs == 3600 {
        s.poll_interval_secs = 600;
    }
    s
}

/// Saves settings to disk, creating parent dirs if needed.
pub fn save(path: &Path, settings: &Settings) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating parent dir {parent:?}"))?;
    }
    let raw = serde_json::to_string_pretty(settings)
        .context("serializing settings")?;
    std::fs::write(path, raw)
        .with_context(|| format!("writing settings to {path:?}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{DisplayMode, Settings};
    use tempfile::tempdir;

    #[test]
    fn load_missing_file_returns_defaults() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nope.json");
        let s = load(&path);
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn load_corrupt_file_returns_defaults() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{ not valid json").unwrap();
        let s = load(&path);
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("sub").join("settings.json");
        let mut s = Settings::default();
        s.threshold_warn = 42.0;
        s.display_mode = DisplayMode::Bars;
        save(&path, &s).unwrap();
        let back = load(&path);
        assert_eq!(s, back);
    }
}
