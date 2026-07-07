//! Profile-dir factory: builds/adopts an app-owned `CLAUDE_CONFIG_DIR` (e.g.
//! `~/.claude-work`) that holds ONLY that account's credentials, junctioning
//! everything else (projects/todos/sessions/skills/commands/plugins/refs/
//! code-style/snippets) and symlinking CLAUDE.md/settings.json/
//! settings.local.json back to the shared `~/.claude` - "one brain, one
//! transcript pool, one hook config" (00-overview.md, locked decision).
//!
//! Windows: junctions (`cmd /c mklink /J`) need no admin; file symlinks use
//! `cmd /c mklink` (works under Dev Mode - `New-Item -ItemType
//! SymbolicLink` does not). macOS/Linux: plain symlinks for both.

use std::path::{Path, PathBuf};

/// Dirs junctioned (not symlinked) from `~/.claude` into every profile dir.
pub const JUNCTION_DIRS: &[&str] = &[
    "projects",
    "todos",
    "sessions",
    "skills",
    "commands",
    "plugins",
    "refs",
    "code-style",
    "snippets",
];

/// Files symlinked from `~/.claude` into every profile dir.
pub const SYMLINK_FILES: &[&str] = &["CLAUDE.md", "settings.json", "settings.local.json"];

#[derive(thiserror::Error, Debug)]
pub enum ProfileError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileDirOutcome {
    pub config_dir: PathBuf,
    /// True if this call created a brand-new dir; false if `config_dir`
    /// already existed (adoption path - only missing links were filled in,
    /// existing `.credentials.json` was never touched).
    pub created_new: bool,
}

/// Computes the profile dir path for a slug: a sibling of `home_claude_dir`
/// named `.claude-<slug>` (so `~/.claude` + slug `"work"` -> `~/.claude-work`).
/// `home_claude_dir` is a parameter (not resolved internally) so tests can
/// point the whole factory at a temp dir tree.
pub fn config_dir_for_slug(home_claude_dir: &Path, slug: &str) -> PathBuf {
    let parent = home_claude_dir.parent().unwrap_or(home_claude_dir);
    parent.join(format!(".claude-{slug}"))
}

/// Creates (or adopts) `~/.claude-<slug>`. Never modifies `.credentials.json`
/// or any other real file already inside an existing dir - it only fills in
/// missing junctions/symlinks. On any failure while building a BRAND NEW dir,
/// the half-made dir is deleted before returning the error (abort-clean); an
/// adoption failure never deletes the pre-existing dir.
pub fn create_or_adopt_profile_dir(
    home_claude_dir: &Path,
    slug: &str,
) -> Result<ProfileDirOutcome, ProfileError> {
    let config_dir = config_dir_for_slug(home_claude_dir, slug);
    if config_dir.exists() {
        fill_missing_links(home_claude_dir, &config_dir)?;
        return Ok(ProfileDirOutcome { config_dir, created_new: false });
    }
    if let Err(e) = build_fresh(home_claude_dir, &config_dir) {
        // Abort-clean: never leave a half-made profile dir behind.
        let _ = delete_profile_dir(&config_dir);
        return Err(e);
    }
    Ok(ProfileDirOutcome { config_dir, created_new: true })
}

fn build_fresh(home_claude_dir: &Path, config_dir: &Path) -> Result<(), ProfileError> {
    std::fs::create_dir_all(config_dir)?;
    fill_missing_links(home_claude_dir, config_dir)
}

/// Fills in whatever junctions/symlinks `config_dir` is missing. Creates any
/// missing target under `home_claude_dir` first. Existing links are left
/// alone. An existing REAL dir/file at a link's spot (e.g. the hand-built
/// `~/.claude-fibo/sessions/` real dir) is merged into the shared target
/// (non-destructively - never overwrites a same-named file already in the
/// target) and then replaced with the junction.
fn fill_missing_links(home_claude_dir: &Path, config_dir: &Path) -> Result<(), ProfileError> {
    std::fs::create_dir_all(home_claude_dir)?;

    for name in JUNCTION_DIRS {
        let target = home_claude_dir.join(name);
        let link = config_dir.join(name);
        std::fs::create_dir_all(&target)?;
        if link_entry_exists(&link) {
            if is_link(&link) {
                continue;
            }
            // Real dir already present at the link's spot: merge its
            // contents into the shared target (never clobbering a file the
            // target already has), then remove it so the junction can land.
            crate::settings::paths::copy_missing_recursive(&link, &target);
            std::fs::remove_dir_all(&link)?;
        }
        create_dir_junction(&target, &link)?;
    }

    for name in SYMLINK_FILES {
        let target = home_claude_dir.join(name);
        ensure_target_file(&target)?;
        let link = config_dir.join(name);
        if link_entry_exists(&link) {
            if is_link(&link) {
                continue;
            }
            // Real file already present: back it up rather than silently
            // discarding whatever the user (or a hand-built profile) had.
            let backup = link.with_extension(append_ext(&link, "bak-orig"));
            std::fs::rename(&link, &backup)?;
        }
        create_file_symlink(&target, &link)?;
    }

    Ok(())
}

fn append_ext(path: &Path, suffix: &str) -> String {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => format!("{ext}.{suffix}"),
        None => suffix.to_string(),
    }
}

fn ensure_target_file(target: &Path) -> Result<(), ProfileError> {
    if target.exists() {
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let default_content = if target.extension().and_then(|e| e.to_str()) == Some("json") {
        "{}\n"
    } else {
        ""
    };
    std::fs::write(target, default_content)?;
    Ok(())
}

/// True if `path` is a symlink or a Windows junction (reparse point). Used to
/// skip already-linked entries during adoption.
fn is_link(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// True if `path` has ANY filesystem entry - including a broken symlink whose
/// target no longer exists. Uses `symlink_metadata` (lstat-like) rather than
/// `Path::exists` (which dereferences and would report a broken link as
/// absent, tripping the mklink/symlink calls below over an already-occupied
/// path).
fn link_entry_exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// Deletes a profile dir's own files/links WITHOUT recursing into junction
/// targets. `std::fs::remove_dir_all` on Windows unlinks reparse points
/// (junctions, symlink-dirs) rather than descending into them - verified by
/// the `deleting_profile_dir_never_touches_junction_targets` test below,
/// since this is exactly the failure mode that would silently wipe out
/// `~/.claude`'s shared content on account removal.
pub fn delete_profile_dir(config_dir: &Path) -> std::io::Result<()> {
    if !config_dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(config_dir)
}

#[cfg(windows)]
fn create_dir_junction(target: &Path, link: &Path) -> Result<(), ProfileError> {
    let mut cmd = std::process::Command::new("cmd");
    cmd.arg("/C").arg("mklink").arg("/J").arg(link).arg(target);
    crate::util::process::hide_console(&mut cmd);
    let out = cmd.output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(ProfileError::Other(format!(
            "mklink /J {} -> {} failed: {}",
            link.display(),
            target.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        )))
    }
}

#[cfg(windows)]
fn create_file_symlink(target: &Path, link: &Path) -> Result<(), ProfileError> {
    let mut cmd = std::process::Command::new("cmd");
    cmd.arg("/C").arg("mklink").arg(link).arg(target);
    crate::util::process::hide_console(&mut cmd);
    let out = cmd.output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(ProfileError::Other(format!(
            "mklink {} -> {} failed: {}",
            link.display(),
            target.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        )))
    }
}

#[cfg(not(windows))]
fn create_dir_junction(target: &Path, link: &Path) -> Result<(), ProfileError> {
    std::os::unix::fs::symlink(target, link)?;
    Ok(())
}

#[cfg(not(windows))]
fn create_file_symlink(target: &Path, link: &Path) -> Result<(), ProfileError> {
    std::os::unix::fs::symlink(target, link)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let root = tempdir().unwrap();
        let home_claude = root.path().join(".claude");
        std::fs::create_dir_all(&home_claude).unwrap();
        (root, home_claude)
    }

    #[test]
    fn config_dir_for_slug_is_sibling_of_home_claude() {
        let home = Path::new("C:/Users/joe/.claude");
        let dir = config_dir_for_slug(home, "work");
        assert_eq!(dir, PathBuf::from("C:/Users/joe/.claude-work"));
    }

    #[test]
    fn create_fresh_builds_all_junctions_and_symlinks() {
        let (_root, home_claude) = setup();
        let outcome = create_or_adopt_profile_dir(&home_claude, "work").unwrap();
        assert!(outcome.created_new);
        assert!(outcome.config_dir.exists());

        for name in JUNCTION_DIRS {
            let link = outcome.config_dir.join(name);
            assert!(is_link(&link), "{name} should be a junction/symlink");
            assert!(home_claude.join(name).is_dir(), "target dir {name} must exist");
        }
        for name in SYMLINK_FILES {
            let link = outcome.config_dir.join(name);
            assert!(is_link(&link), "{name} should be a symlink");
            assert!(home_claude.join(name).is_file(), "target file {name} must exist");
        }
    }

    #[test]
    fn junction_makes_content_instantly_visible_both_ways() {
        let (_root, home_claude) = setup();
        let outcome = create_or_adopt_profile_dir(&home_claude, "work").unwrap();
        // Write a skill into the SHARED ~/.claude/skills; it must appear
        // through the profile dir's junction, matching the locked decision
        // that skill/memory edits apply to every account instantly.
        std::fs::write(home_claude.join("skills").join("foo.md"), "hello").unwrap();
        let via_profile = outcome.config_dir.join("skills").join("foo.md");
        assert_eq!(std::fs::read_to_string(via_profile).unwrap(), "hello");
    }

    #[test]
    fn adopting_existing_dir_fills_missing_junctions_without_touching_present_ones() {
        let (_root, home_claude) = setup();
        // Simulate a hand-built profile dir with only ONE junction already
        // wired up, mirroring the ~/.claude-fibo reference case.
        let existing = config_dir_for_slug(&home_claude, "fibo");
        std::fs::create_dir_all(&existing).unwrap();
        std::fs::write(existing.join(".credentials.json"), "secret").unwrap();

        let outcome = create_or_adopt_profile_dir(&home_claude, "fibo").unwrap();
        assert!(!outcome.created_new, "adoption path must report created_new=false");
        // Credentials must survive untouched.
        assert_eq!(
            std::fs::read_to_string(existing.join(".credentials.json")).unwrap(),
            "secret"
        );
        // Missing junctions/symlinks must now be filled in.
        for name in JUNCTION_DIRS {
            assert!(is_link(&existing.join(name)), "{name} should now be linked");
        }
        for name in SYMLINK_FILES {
            assert!(is_link(&existing.join(name)), "{name} should now be linked");
        }
    }

    #[test]
    fn adopting_dir_with_real_sessions_folder_merges_then_junctions() {
        let (_root, home_claude) = setup();
        let existing = config_dir_for_slug(&home_claude, "fibo");
        std::fs::create_dir_all(existing.join("sessions")).unwrap();
        std::fs::write(existing.join("sessions").join("s1.jsonl"), "transcript-1").unwrap();
        // Shared home already has an unrelated session file - must survive.
        std::fs::create_dir_all(home_claude.join("sessions")).unwrap();
        std::fs::write(home_claude.join("sessions").join("s0.jsonl"), "transcript-0").unwrap();

        let outcome = create_or_adopt_profile_dir(&home_claude, "fibo").unwrap();
        assert!(is_link(&outcome.config_dir.join("sessions")));
        assert_eq!(
            std::fs::read_to_string(home_claude.join("sessions").join("s1.jsonl")).unwrap(),
            "transcript-1",
            "the real profile dir's session must be merged into the shared home"
        );
        assert_eq!(
            std::fs::read_to_string(home_claude.join("sessions").join("s0.jsonl")).unwrap(),
            "transcript-0",
            "pre-existing shared content must not be clobbered by the merge"
        );
    }

    #[test]
    fn build_failure_aborts_and_deletes_half_made_dir() {
        let (_root, home_claude) = setup();
        // Force a failure: occupy one of the junction target names with a
        // FILE at the home level, so create_dir_all(target) for it errors.
        std::fs::write(home_claude.join("skills"), "not a dir").unwrap();

        let slug = "broken";
        let config_dir = config_dir_for_slug(&home_claude, slug);
        let result = create_or_adopt_profile_dir(&home_claude, slug);
        assert!(result.is_err());
        assert!(!config_dir.exists(), "half-made dir must be deleted on failure");
    }

    #[test]
    fn deleting_profile_dir_never_touches_junction_targets() {
        let (_root, home_claude) = setup();
        let outcome = create_or_adopt_profile_dir(&home_claude, "work").unwrap();
        std::fs::write(home_claude.join("skills").join("keepme.md"), "keep").unwrap();
        std::fs::write(outcome.config_dir.join(".credentials.json"), "secret").unwrap();

        delete_profile_dir(&outcome.config_dir).unwrap();

        assert!(!outcome.config_dir.exists(), "profile dir itself must be gone");
        assert!(
            home_claude.join("skills").join("keepme.md").exists(),
            "shared ~/.claude content behind the junction must survive"
        );
    }

    #[test]
    fn delete_profile_dir_is_idempotent_when_missing() {
        let (_root, home_claude) = setup();
        let missing = config_dir_for_slug(&home_claude, "never-created");
        delete_profile_dir(&missing).unwrap();
    }
}
