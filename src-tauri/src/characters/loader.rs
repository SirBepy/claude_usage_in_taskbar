//! Loads characters from two directory layouts:
//!
//! **Flat (legacy):** `<chars_dir>/<char-id>/character.json`
//!   Detected when the immediate subdir contains `character.json`.
//!
//! **Game-grouped (current):** `<chars_dir>/<game-slug>/<char-id>/character.json`
//!   Detected when the immediate subdir has no `character.json` itself.
//!   `game.json` in the game-slug dir supplies the pretty label.
//!   `_shared` bundles (character.json with `"shared": true`) are skipped.

use anyhow::{Context, Result};
use std::path::Path;

use crate::characters::Character;

/// Reads every non-shared character from `dir`, handling both flat and
/// game-grouped layouts. Characters with parse/validation errors are logged
/// and skipped.
pub fn load_all(dir: &Path) -> Vec<Character> {
    let mut out = Vec::new();
    let read = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) => {
            log::warn!("characters: read_dir({}) failed: {e}", dir.display());
            return out;
        }
    };
    for entry in read.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
        let subdir = entry.path();
        if subdir.join("character.json").exists() {
            // Flat (legacy) structure: this dir IS the character dir.
            match load_one(&subdir) {
                Ok(c) if !c.shared => out.push(c),
                Ok(_) => {}
                Err(e) => log::warn!("characters: skip {}: {e:#}", subdir.display()),
            }
        } else {
            // Game-grouped structure: subdir is a game dir, recurse one level.
            let game_label = read_game_label(&subdir);
            let char_entries = match std::fs::read_dir(&subdir) {
                Ok(r) => r,
                Err(e) => {
                    log::warn!("characters: read_dir({}) failed: {e}", subdir.display());
                    continue;
                }
            };
            for char_entry in char_entries.flatten() {
                if !char_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
                let char_dir = char_entry.path();
                if !char_dir.join("character.json").exists() { continue; }
                match load_one(&char_dir) {
                    Ok(mut c) if !c.shared => {
                        if c.game_label.is_none() {
                            c.game_label = game_label.clone();
                        }
                        out.push(c);
                    }
                    Ok(_) => {}
                    Err(e) => log::warn!("characters: skip {}: {e:#}", char_dir.display()),
                }
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn read_game_label(game_dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(game_dir.join("game.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v["label"].as_str().map(|s| s.to_string())
}

fn load_one(char_dir: &Path) -> Result<Character> {
    let json_path = char_dir.join("character.json");
    let raw = std::fs::read_to_string(&json_path)
        .with_context(|| format!("read {}", json_path.display()))?;
    let mut c: Character = serde_json::from_str(&raw)
        .with_context(|| format!("parse {}", json_path.display()))?;
    c.dir = char_dir.to_path_buf();

    if c.shared {
        return Ok(c); // skip id/icon/slot validation for shared bundles
    }

    let dir_name = char_dir.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if c.id != dir_name {
        anyhow::bail!("character id {:?} does not match dir name {:?}", c.id, dir_name);
    }
    let icon_path = char_dir.join(&c.icon);
    if !icon_path.exists() {
        anyhow::bail!("missing icon: {}", icon_path.display());
    }
    for (slot, files) in &c.slots {
        for f in files {
            let p = char_dir.join(f);
            if !p.exists() {
                anyhow::bail!("missing slot {slot} file: {}", p.display());
            }
        }
    }
    Ok(c)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write(p: &Path, contents: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, contents).unwrap();
    }

    fn write_valid(root: &Path, id: &str) {
        let dir = root.join(id);
        write(&dir.join("character.json"), &format!(r#"{{
            "id": "{id}", "label": "Test {id}", "icon": "icon.png",
            "slots": {{ "work_finished": ["sounds/done.wav"] }}
        }}"#));
        write(&dir.join("icon.png"), "x");
        write(&dir.join("sounds/done.wav"), "x");
    }

    fn write_grouped(root: &Path, game: &str, id: &str, game_label: Option<&str>) {
        let game_dir = root.join(game);
        if let Some(lbl) = game_label {
            write(&game_dir.join("game.json"), &format!(r#"{{"id":"{game}","label":"{lbl}"}}"#));
        }
        let dir = game_dir.join(id);
        write(&dir.join("character.json"), &format!(r#"{{
            "id": "{id}", "label": "Test {id}", "game": "{game}", "icon": "icon.png",
            "slots": {{ "work_finished": ["sounds/done.wav"] }}
        }}"#));
        write(&dir.join("icon.png"), "x");
        write(&dir.join("sounds/done.wav"), "x");
    }

    #[test]
    fn empty_dir_yields_empty_list() {
        let tmp = TempDir::new().unwrap();
        assert!(load_all(tmp.path()).is_empty());
    }

    #[test]
    fn missing_dir_yields_empty_list() {
        assert!(load_all(Path::new("/nonexistent/xx")).is_empty());
    }

    #[test]
    fn loads_flat_character() {
        let tmp = TempDir::new().unwrap();
        write_valid(tmp.path(), "peon");
        let chars = load_all(tmp.path());
        assert_eq!(chars.len(), 1);
        assert_eq!(chars[0].id, "peon");
    }

    #[test]
    fn loads_grouped_character_and_injects_game_label() {
        let tmp = TempDir::new().unwrap();
        write_grouped(tmp.path(), "warcraft", "peon", Some("Warcraft"));
        let chars = load_all(tmp.path());
        assert_eq!(chars.len(), 1);
        assert_eq!(chars[0].id, "peon");
        assert_eq!(chars[0].game_label.as_deref(), Some("Warcraft"));
    }

    #[test]
    fn grouped_without_game_json_still_loads() {
        let tmp = TempDir::new().unwrap();
        write_grouped(tmp.path(), "warcraft", "peon", None);
        let chars = load_all(tmp.path());
        assert_eq!(chars.len(), 1);
        assert_eq!(chars[0].game_label, None);
    }

    #[test]
    fn skips_shared_bundle_in_grouped() {
        let tmp = TempDir::new().unwrap();
        let game_dir = tmp.path().join("warcraft");
        let shared_dir = game_dir.join("_shared");
        write(
            &shared_dir.join("character.json"),
            r#"{"id":"warcraft","label":"Warcraft Shared","shared":true,"icon":"icon.png","slots":{}}"#,
        );
        write(&shared_dir.join("icon.png"), "x");
        assert!(load_all(tmp.path()).is_empty());
    }

    #[test]
    fn skips_character_with_missing_icon() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("broken");
        write(&dir.join("character.json"), r#"{
            "id": "broken", "label": "Broken", "icon": "icon.png", "slots": {}
        }"#);
        assert!(load_all(tmp.path()).is_empty());
    }

    #[test]
    fn skips_character_when_id_mismatches_dir_name() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("dirname");
        write(&dir.join("character.json"), r#"{
            "id": "different", "label": "X", "icon": "icon.png", "slots": {}
        }"#);
        write(&dir.join("icon.png"), "x");
        assert!(load_all(tmp.path()).is_empty());
    }

    #[test]
    fn returns_sorted_by_id() {
        let tmp = TempDir::new().unwrap();
        write_valid(tmp.path(), "zeta");
        write_valid(tmp.path(), "alpha");
        write_valid(tmp.path(), "mu");
        let ids: Vec<_> = load_all(tmp.path()).into_iter().map(|c| c.id).collect();
        assert_eq!(ids, vec!["alpha", "mu", "zeta"]);
    }

    #[test]
    fn flat_and_grouped_coexist() {
        let tmp = TempDir::new().unwrap();
        write_valid(tmp.path(), "legacy-char");
        write_grouped(tmp.path(), "warcraft", "peon", Some("Warcraft"));
        let chars = load_all(tmp.path());
        assert_eq!(chars.len(), 2);
        let ids: Vec<_> = chars.iter().map(|c| c.id.as_str()).collect();
        assert!(ids.contains(&"legacy-char"));
        assert!(ids.contains(&"peon"));
    }
}
