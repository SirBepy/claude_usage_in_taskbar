//! Load and save user settings to disk.

use crate::types::Settings;
use anyhow::{Context, Result};
use std::path::Path;

/// Loads settings from disk. If the file is missing, returns defaults.
/// If the file is present but unparsable, renames it to
/// `settings.json.broken-<unix-ts>` before returning defaults so the next
/// save can't clobber the only copy of the user's data. Recovery is then
/// a manual rename away.
pub fn load(path: &Path) -> Settings {
    let mut s: Settings = match std::fs::read_to_string(path) {
        Err(_) => Settings::default(),
        Ok(raw) => match serde_json::from_str::<Settings>(&raw) {
            Ok(parsed) => parsed,
            Err(err) => {
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let backup = path.with_extension(format!("json.broken-{ts}"));
                let _ = std::fs::rename(path, &backup);
                eprintln!(
                    "[settings] parse failed ({err}); preserved at {} and loaded defaults",
                    backup.display()
                );
                Settings::default()
            }
        },
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

/// Walks `start` and its ancestors looking for a `.git` entry (file or dir).
/// Returns the first ancestor that has one. None if no ancestor does.
pub fn find_repo_root(start: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut cur: Option<&std::path::Path> = Some(start);
    while let Some(p) = cur {
        if p.join(".git").exists() {
            return Some(p.to_path_buf());
        }
        cur = p.parent();
    }
    None
}

/// Canonicalizes via the filesystem (resolves real casing, junctions,
/// symlinks). On Windows, strips the `\\?\` UNC prefix that
/// `fs::canonicalize` emits. Falls back to `normalize_cwd_key` when the
/// path doesn't exist (so missing dirs still produce a stable key).
pub fn normalize_path(p: &std::path::Path) -> String {
    match std::fs::canonicalize(p) {
        Ok(canon) => {
            let s = canon.to_string_lossy().into_owned();
            #[cfg(windows)]
            {
                if let Some(stripped) = s.strip_prefix(r"\\?\") {
                    return normalize_cwd_key(std::path::Path::new(stripped));
                }
            }
            normalize_cwd_key(std::path::Path::new(&s))
        }
        Err(_) => normalize_cwd_key(p),
    }
}

/// Identity key for a project. Walks parents to find a `.git` ancestor;
/// if found, that's the repo root. Otherwise the input path itself is
/// the root. Returns the normalized form of the chosen path.
pub fn project_key(p: &std::path::Path) -> String {
    let root = find_repo_root(p).unwrap_or_else(|| p.to_path_buf());
    normalize_path(&root)
}

/// Canonical key used to decide whether two recorded cwds refer to the
/// same project. On Windows and macOS (default APFS), paths are
/// case-insensitive and can arrive with either `\` or `/` separators
/// (hook payloads, token-history, IPC all vary); without normalization
/// the same folder registered as a different project every time the
/// casing flipped.
pub fn normalize_cwd_key(p: &std::path::Path) -> String {
    let raw = p.to_string_lossy();
    let swapped: String = raw.chars().map(|c| if c == '/' { '\\' } else { c }).collect();
    let trimmed = swapped.trim_end_matches('\\');
    if cfg!(any(windows, target_os = "macos")) {
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
    let key = project_key(cwd);
    if let Some(p) = settings
        .projects
        .iter_mut()
        .find(|p| project_key(&p.path) == key)
    {
        p.last_active_at = Some(now.to_string());
        return (p.id.clone(), false);
    }
    // Store the resolved root (repo root when found, else the cwd as-is)
    // so subfolder cwds never spawn duplicate entries.
    let root = find_repo_root(cwd).unwrap_or_else(|| cwd.to_path_buf());
    let id = uuid::Uuid::new_v4().to_string();
    let name = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("(unknown)")
        .to_string();
    settings.projects.push(crate::types::ProjectConfig {
        id: id.clone(),
        path: root,
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
    fn load_corrupt_file_preserves_original_so_save_cannot_clobber() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{ not valid json").unwrap();
        let _ = load(&path);
        assert!(!path.exists(), "broken file must be moved aside");
        let backups: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("settings.json.broken-")
            })
            .collect();
        assert_eq!(backups.len(), 1, "exactly one backup file");
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

    #[cfg(target_os = "macos")]
    #[test]
    fn upsert_merges_case_variants_on_macos() {
        let mut s = Settings::default();
        let (id1, _) = upsert_project_for_cwd(
            &mut s,
            std::path::Path::new("/Users/joe/Proj"),
            "t1",
        );
        let (id2, created) = upsert_project_for_cwd(
            &mut s,
            std::path::Path::new("/users/JOE/proj"),
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
    fn find_repo_root_returns_dir_with_git_subdir() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        let sub = repo.join("packages").join("app");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let found = super::find_repo_root(&sub).expect("expected to find repo root");
        assert_eq!(found, repo);
    }

    #[test]
    fn find_repo_root_returns_dir_with_git_file() {
        // Submodules use a `.git` *file* pointing at the parent's modules dir.
        let dir = tempdir().unwrap();
        let repo = dir.path().join("submod");
        let sub = repo.join("src");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(repo.join(".git"), b"gitdir: ../.git/modules/submod").unwrap();
        let found = super::find_repo_root(&sub).expect("expected to find repo root");
        assert_eq!(found, repo);
    }

    #[test]
    fn find_repo_root_returns_none_outside_repo() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(super::find_repo_root(&nested).is_none());
    }

    #[test]
    fn project_key_rolls_up_subfolder_to_repo_root() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        let sub = repo.join("nested").join("inner");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let key_root = super::project_key(&repo);
        let key_sub = super::project_key(&sub);
        assert_eq!(key_root, key_sub, "subfolder must share repo-root key");
    }

    #[test]
    fn project_key_falls_back_to_normalized_path_when_not_in_repo() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("standalone");
        std::fs::create_dir_all(&p).unwrap();
        let key = super::project_key(&p);
        // We don't compare against an exact string (canonicalize varies by OS),
        // but it must be non-empty and stable across calls with the same path.
        assert!(!key.is_empty());
        assert_eq!(key, super::project_key(&p));
    }

    #[test]
    fn project_key_for_missing_path_uses_normalize_fallback() {
        // Path doesn't exist on disk; canonicalize fails, fallback kicks in.
        let p = std::path::Path::new("Z:\\definitely\\does\\not\\exist\\xyz");
        let key = super::project_key(p);
        assert!(!key.is_empty());
        assert_eq!(key, super::normalize_cwd_key(p));
    }

    #[cfg(windows)]
    #[test]
    fn project_key_collapses_drive_letter_casing() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("Repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let lower = super::project_key(&repo);
        // Re-create the same path with toggled drive-letter case.
        let raw = repo.to_string_lossy();
        let toggled: String = raw.chars().enumerate().map(|(i, c)| {
            if i == 0 { if c.is_ascii_uppercase() { c.to_ascii_lowercase() } else { c.to_ascii_uppercase() } } else { c }
        }).collect();
        let upper = super::project_key(std::path::Path::new(&toggled));
        assert_eq!(lower, upper, "drive-letter casing must not split the key");
    }

    #[test]
    fn upsert_rolls_subfolder_up_to_repo_root() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("myrepo");
        let sub = repo.join("packages").join("app");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();

        let mut s = Settings::default();
        let (id1, _) = upsert_project_for_cwd(&mut s, &repo, "t1");
        let (id2, created) = upsert_project_for_cwd(&mut s, &sub, "t2");

        assert!(!created, "subfolder of a known repo must reuse the repo entry");
        assert_eq!(id1, id2);
        assert_eq!(s.projects.len(), 1);
        // Path stays at the repo root regardless of which cwd was passed.
        assert_eq!(s.projects[0].path, repo);
        assert_eq!(s.projects[0].name, "myrepo");
    }

    #[test]
    fn upsert_creates_subfolder_entry_when_not_in_repo() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("plain");
        std::fs::create_dir_all(&p).unwrap();
        let mut s = Settings::default();
        let (_id, created) = upsert_project_for_cwd(&mut s, &p, "t1");
        assert!(created);
        assert_eq!(s.projects[0].name, "plain");
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
