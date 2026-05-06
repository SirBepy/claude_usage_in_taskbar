//! On first run, copy bundled characters from the app resources dir into
//! `<app-data>/characters/` if the destination is empty. Idempotent: skips
//! per-character if the target already exists.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Returns the source dir for bundled chars. In dev: `<manifest>/assets/characters`.
/// In bundle: `<exe-parent>/resources/assets/characters`.
pub fn source_dir() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let p = parent.join("resources").join("assets").join("characters");
            if p.exists() { return Some(p); }
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let p = manifest.join("assets").join("characters");
    if p.exists() { Some(p) } else { None }
}

/// Copy each immediate subdir of `src` into `dest/<name>` if not already present.
/// Returns the number of characters copied.
pub fn ensure_bundled_at(src: &Path, dest: &Path) -> Result<usize> {
    let mut copied = 0;
    let read = std::fs::read_dir(src).with_context(|| format!("read {}", src.display()))?;
    std::fs::create_dir_all(dest).context("ensure dest")?;
    for entry in read.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
        let name = entry.file_name();
        let target = dest.join(&name);
        if target.exists() { continue; }
        copy_dir_recursive(&entry.path(), &target)?;
        copied += 1;
    }
    Ok(copied)
}

/// Convenience: source from `source_dir()`, dest from `paths::characters_dir()`.
pub fn ensure_bundled() -> Result<usize> {
    let Some(src) = source_dir() else {
        log::info!("characters: no bundled source dir found, skipping");
        return Ok(0);
    };
    let dest = crate::settings::paths::characters_dir()?;
    migrate_warcraft_slug(&dest);
    ensure_bundled_at(&src, &dest)
}

/// One-time rename: `<chars>/warcraft` → `<chars>/warcraft3` if old dir exists and new doesn't.
fn migrate_warcraft_slug(chars_dir: &Path) {
    let old = chars_dir.join("warcraft");
    let new = chars_dir.join("warcraft3");
    if old.exists() && !new.exists() {
        match std::fs::rename(&old, &new) {
            Ok(_) => log::info!("characters: migrated warcraft/ -> warcraft3/"),
            Err(e) => log::warn!("characters: failed to migrate warcraft/ -> warcraft3/: {e}"),
        }
    }
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)?.flatten() {
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn copies_each_subdir_when_dest_empty() {
        let src = TempDir::new().unwrap();
        let dest = TempDir::new().unwrap();
        fs::create_dir_all(src.path().join("alpha/sounds")).unwrap();
        fs::write(src.path().join("alpha/character.json"), "x").unwrap();
        fs::write(src.path().join("alpha/icon.png"), "x").unwrap();
        fs::write(src.path().join("alpha/sounds/a.wav"), "x").unwrap();
        fs::create_dir_all(src.path().join("beta")).unwrap();
        fs::write(src.path().join("beta/character.json"), "x").unwrap();

        let n = ensure_bundled_at(src.path(), dest.path()).unwrap();
        assert_eq!(n, 2);
        assert!(dest.path().join("alpha/character.json").exists());
        assert!(dest.path().join("alpha/sounds/a.wav").exists());
        assert!(dest.path().join("beta/character.json").exists());
    }

    #[test]
    fn skips_already_present_subdirs() {
        let src = TempDir::new().unwrap();
        let dest = TempDir::new().unwrap();
        fs::create_dir_all(src.path().join("alpha")).unwrap();
        fs::write(src.path().join("alpha/character.json"), "fresh").unwrap();
        fs::create_dir_all(dest.path().join("alpha")).unwrap();
        fs::write(dest.path().join("alpha/character.json"), "user-edited").unwrap();

        let n = ensure_bundled_at(src.path(), dest.path()).unwrap();
        assert_eq!(n, 0);
        let after = fs::read_to_string(dest.path().join("alpha/character.json")).unwrap();
        assert_eq!(after, "user-edited");
    }

    #[test]
    fn missing_source_dir_returns_err_via_ensure_bundled_at() {
        let dest = TempDir::new().unwrap();
        let res = ensure_bundled_at(std::path::Path::new("/nonexistent_xyz_nope"), dest.path());
        assert!(res.is_err());
    }
}
