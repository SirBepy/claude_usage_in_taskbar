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

/// Finds or creates a `ProjectConfig` for this cwd. Returns `(id, created_new)`.
///
/// If the project already exists, updates `last_active_at`. If created,
/// populates `id` (uuid v4), `name` (basename), `avatar` (None), and
/// timestamps (`now` comes from the caller so tests can inject).
pub fn upsert_project_for_cwd(
    settings: &mut crate::types::Settings,
    cwd: &std::path::Path,
    now: &str,
) -> (String, bool) {
    if let Some(p) = settings.projects.iter_mut().find(|p| p.path == cwd) {
        p.last_active_at = Some(now.to_string());
        return (p.id.clone(), false);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let name = cwd
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("(unknown)")
        .to_string();
    settings.projects.push(crate::types::ProjectConfig {
        id: id.clone(),
        path: cwd.to_path_buf(),
        name,
        avatar: crate::types::Avatar::None,
        automation: None,
        created_at: now.to_string(),
        last_active_at: Some(now.to_string()),
    });
    (id, true)
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

    #[test]
    fn upsert_creates_when_absent() {
        let mut s = Settings::default();
        let (id, created) = upsert_project_for_cwd(&mut s, std::path::Path::new("C:/new"), "now");
        assert!(created);
        assert_eq!(s.projects.len(), 1);
        assert_eq!(s.projects[0].id, id);
        assert_eq!(s.projects[0].path, std::path::PathBuf::from("C:/new"));
        assert_eq!(s.projects[0].name, "new");
    }

    #[test]
    fn upsert_returns_existing_when_path_matches() {
        let mut s = Settings::default();
        let (id1, _) = upsert_project_for_cwd(&mut s, std::path::Path::new("C:/same"), "now");
        let (id2, created) = upsert_project_for_cwd(&mut s, std::path::Path::new("C:/same"), "later");
        assert!(!created);
        assert_eq!(id1, id2);
        assert_eq!(s.projects.len(), 1);
        assert_eq!(s.projects[0].last_active_at.as_deref(), Some("later"));
    }
}
