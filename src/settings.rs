//! Load and save user settings to disk.

use crate::types::Settings;
use anyhow::{Context, Result};
use std::path::Path;

/// Loads settings from disk. If the file is missing or corrupt, returns defaults
/// (and does NOT rewrite the file automatically, the caller decides when to save).
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
    dedupe_projects_by_path_key(&mut s.projects);
    s
}

/// Canonical key used to decide whether two recorded cwds refer to the
/// same project. On Windows, paths are case-insensitive and can arrive
/// with either `\` or `/` separators (hook payloads, token-history, IPC
/// all vary); without normalization the same folder registered as a
/// different project every time the casing flipped.
pub fn normalize_cwd_key(p: &std::path::Path) -> String {
    let raw = p.to_string_lossy();
    let swapped: String = raw.chars().map(|c| if c == '/' { '\\' } else { c }).collect();
    let trimmed = swapped.trim_end_matches('\\');
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// One-shot migration run on every load. Collapses duplicate project
/// entries that point at the same folder under different casing or
/// separator styles. The surviving entry keeps the first id seen (so
/// existing references stay valid), the oldest `created_at`, the latest
/// `last_active_at`, and any non-empty avatar / automation / name that a
/// later duplicate had filled in.
fn dedupe_projects_by_path_key(projects: &mut Vec<crate::types::ProjectConfig>) {
    use std::collections::HashMap;
    let mut by_key: HashMap<String, usize> = HashMap::new();
    let mut survivors: Vec<crate::types::ProjectConfig> = Vec::with_capacity(projects.len());
    for p in projects.drain(..) {
        let key = normalize_cwd_key(&p.path);
        match by_key.get(&key).copied() {
            None => {
                by_key.insert(key, survivors.len());
                survivors.push(p);
            }
            Some(idx) => {
                let keep = &mut survivors[idx];
                if p.created_at < keep.created_at {
                    keep.created_at = p.created_at.clone();
                }
                match (&keep.last_active_at, &p.last_active_at) {
                    (None, Some(_)) => keep.last_active_at = p.last_active_at.clone(),
                    (Some(a), Some(b)) if b > a => keep.last_active_at = p.last_active_at.clone(),
                    _ => {}
                }
                if matches!(keep.avatar, crate::types::Avatar::None)
                    && !matches!(p.avatar, crate::types::Avatar::None)
                {
                    keep.avatar = p.avatar.clone();
                }
                if keep.automation.is_none() && p.automation.is_some() {
                    keep.automation = p.automation.clone();
                }
            }
        }
    }
    *projects = survivors;
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
    let key = normalize_cwd_key(cwd);
    if let Some(p) = settings
        .projects
        .iter_mut()
        .find(|p| normalize_cwd_key(&p.path) == key)
    {
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

    #[cfg(windows)]
    #[test]
    fn upsert_merges_case_variants_on_windows() {
        let mut s = Settings::default();
        let (id1, _) = upsert_project_for_cwd(
            &mut s,
            std::path::Path::new("C:\\Users\\joe\\proj"),
            "t1",
        );
        let (id2, created) = upsert_project_for_cwd(
            &mut s,
            std::path::Path::new("c:\\users\\JOE\\proj"),
            "t2",
        );
        assert!(!created, "same folder with different casing must not split");
        assert_eq!(id1, id2);
        assert_eq!(s.projects.len(), 1);
    }

    #[test]
    fn upsert_merges_separator_variants() {
        let mut s = Settings::default();
        let (id1, _) = upsert_project_for_cwd(&mut s, std::path::Path::new("C:\\a\\b"), "t1");
        let (id2, created) = upsert_project_for_cwd(&mut s, std::path::Path::new("C:/a/b"), "t2");
        assert!(!created);
        assert_eq!(id1, id2);
        assert_eq!(s.projects.len(), 1);
    }

    #[test]
    fn upsert_merges_trailing_separator() {
        let mut s = Settings::default();
        let (id1, _) = upsert_project_for_cwd(&mut s, std::path::Path::new("C:\\a\\b"), "t1");
        let (id2, created) = upsert_project_for_cwd(&mut s, std::path::Path::new("C:\\a\\b\\"), "t2");
        assert!(!created);
        assert_eq!(id1, id2);
        assert_eq!(s.projects.len(), 1);
    }

    #[test]
    fn load_collapses_duplicate_projects_on_disk() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let raw = r#"{
            "projects": [
                {
                    "id": "first",
                    "path": "C:\\users\\joe\\proj",
                    "name": "proj",
                    "created_at": "2026-04-01T00:00:00Z",
                    "last_active_at": "2026-04-10T00:00:00Z"
                },
                {
                    "id": "second",
                    "path": "C:/Users/Joe/proj",
                    "name": "proj",
                    "avatar": {"kind": "emoji", "value": "🦊"},
                    "created_at": "2026-03-01T00:00:00Z",
                    "last_active_at": "2026-04-20T00:00:00Z"
                }
            ]
        }"#;
        std::fs::write(&path, raw).unwrap();
        let s = load(&path);
        assert_eq!(s.projects.len(), 1, "duplicates must collapse");
        let p = &s.projects[0];
        assert_eq!(p.id, "first", "survivor keeps earliest-seen id");
        assert_eq!(p.created_at, "2026-03-01T00:00:00Z", "oldest created_at wins");
        assert_eq!(
            p.last_active_at.as_deref(),
            Some("2026-04-20T00:00:00Z"),
            "latest last_active_at wins",
        );
        assert!(
            matches!(p.avatar, crate::types::Avatar::Emoji(ref e) if e == "🦊"),
            "avatar from duplicate propagates when survivor had none",
        );
    }
}
