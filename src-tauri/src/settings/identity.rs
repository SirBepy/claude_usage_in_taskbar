//! Project-identity helpers: turn a CWD into a stable, canonicalized
//! project key so we can collapse case/separator variants and roll
//! subfolders up to their owning repo root.

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
pub(crate) fn dedupe_projects_by_path_key(projects: &mut Vec<crate::types::ProjectConfig>) {
    use std::collections::HashMap;
    let mut by_key: HashMap<String, usize> = HashMap::new();
    let mut survivors: Vec<crate::types::ProjectConfig> = Vec::with_capacity(projects.len());
    for p in projects.drain(..) {
        let key = project_key(&p.path);
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
                if keep.preferred_account_id.is_none() && p.preferred_account_id.is_some() {
                    keep.preferred_account_id = p.preferred_account_id.clone();
                }
            }
        }
    }
    *projects = survivors;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample_project(path: std::path::PathBuf, preferred_account_id: Option<&str>) -> crate::types::ProjectConfig {
        crate::types::ProjectConfig {
            id: "id-1".into(),
            path,
            name: "proj".into(),
            avatar: crate::types::Avatar::None,
            automation: None,
            created_at: "2026-04-21T00:00:00Z".into(),
            last_active_at: None,
            whitelist: crate::types::CharacterWhitelist::default(),
            preferred_account_id: preferred_account_id.map(str::to_string),
        }
    }

    #[test]
    fn dedupe_carries_forward_preferred_account_id_from_a_duplicate() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();

        // Two entries for the same path (e.g. survived a casing/separator
        // split); only the second carries a binding.
        let mut projects = vec![
            sample_project(repo.clone(), None),
            sample_project(repo.clone(), Some("acct-work")),
        ];
        dedupe_projects_by_path_key(&mut projects);

        assert_eq!(projects.len(), 1, "duplicates must collapse to one entry");
        assert_eq!(projects[0].preferred_account_id.as_deref(), Some("acct-work"));
    }

    #[test]
    fn dedupe_keeps_the_survivors_own_binding_when_it_already_has_one() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo2");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();

        let mut projects = vec![
            sample_project(repo.clone(), Some("acct-personal")),
            sample_project(repo.clone(), Some("acct-work")),
        ];
        dedupe_projects_by_path_key(&mut projects);

        assert_eq!(projects.len(), 1);
        // First-seen survivor keeps its own binding; a later duplicate never
        // overwrites an existing one (mirrors the avatar/automation rule).
        assert_eq!(projects[0].preferred_account_id.as_deref(), Some("acct-personal"));
    }

    #[test]
    fn find_repo_root_returns_dir_with_git_subdir() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        let sub = repo.join("packages").join("app");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let found = find_repo_root(&sub).expect("expected to find repo root");
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
        let found = find_repo_root(&sub).expect("expected to find repo root");
        assert_eq!(found, repo);
    }

    #[test]
    fn find_repo_root_returns_none_outside_repo() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(find_repo_root(&nested).is_none());
    }

    #[test]
    fn project_key_rolls_up_subfolder_to_repo_root() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        let sub = repo.join("nested").join("inner");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let key_root = project_key(&repo);
        let key_sub = project_key(&sub);
        assert_eq!(key_root, key_sub, "subfolder must share repo-root key");
    }

    #[test]
    fn project_key_falls_back_to_normalized_path_when_not_in_repo() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("standalone");
        std::fs::create_dir_all(&p).unwrap();
        let key = project_key(&p);
        // We don't compare against an exact string (canonicalize varies by OS),
        // but it must be non-empty and stable across calls with the same path.
        assert!(!key.is_empty());
        assert_eq!(key, project_key(&p));
    }

    #[test]
    fn project_key_for_missing_path_uses_normalize_fallback() {
        // Path doesn't exist on disk; canonicalize fails, fallback kicks in.
        let p = std::path::Path::new("Z:\\definitely\\does\\not\\exist\\xyz");
        let key = project_key(p);
        assert!(!key.is_empty());
        assert_eq!(key, normalize_cwd_key(p));
    }

    #[cfg(windows)]
    #[test]
    fn project_key_collapses_drive_letter_casing() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("Repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let lower = project_key(&repo);
        // Re-create the same path with toggled drive-letter case.
        let raw = repo.to_string_lossy();
        let toggled: String = raw.chars().enumerate().map(|(i, c)| {
            if i == 0 { if c.is_ascii_uppercase() { c.to_ascii_lowercase() } else { c.to_ascii_uppercase() } } else { c }
        }).collect();
        let upper = project_key(std::path::Path::new(&toggled));
        assert_eq!(lower, upper, "drive-letter casing must not split the key");
    }
}
