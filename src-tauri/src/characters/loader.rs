//! Reads `<characters_dir>/<id>/character.json` for every subdirectory.
//! Validates that referenced icon and slot files exist on disk; characters
//! with broken refs are logged and skipped (so a half-installed character
//! never crashes startup).

use anyhow::{Context, Result};
use std::path::Path;

use crate::characters::Character;

/// Reads every character from `dir`. Returns characters that parsed and whose
/// referenced files all exist. Characters with errors are logged and skipped.
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
        let char_dir = entry.path();
        match load_one(&char_dir) {
            Ok(c) => out.push(c),
            Err(e) => log::warn!("characters: skip {}: {e:#}", char_dir.display()),
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn load_one(char_dir: &Path) -> Result<Character> {
    let json_path = char_dir.join("character.json");
    let raw = std::fs::read_to_string(&json_path)
        .with_context(|| format!("read {}", json_path.display()))?;
    let c: Character = serde_json::from_str(&raw)
        .with_context(|| format!("parse {}", json_path.display()))?;
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
    fn loads_one_valid_character() {
        let tmp = TempDir::new().unwrap();
        write_valid(tmp.path(), "peon");
        let chars = load_all(tmp.path());
        assert_eq!(chars.len(), 1);
        assert_eq!(chars[0].id, "peon");
    }

    #[test]
    fn skips_character_with_missing_icon() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("broken");
        write(&dir.join("character.json"), r#"{
            "id": "broken", "label": "Broken", "icon": "icon.png", "slots": {}
        }"#);
        // no icon.png
        assert!(load_all(tmp.path()).is_empty());
    }

    #[test]
    fn skips_character_with_missing_slot_file() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("broken");
        write(&dir.join("character.json"), r#"{
            "id": "broken", "label": "Broken", "icon": "icon.png",
            "slots": { "work_finished": ["sounds/missing.wav"] }
        }"#);
        write(&dir.join("icon.png"), "x");
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
    fn skips_character_with_malformed_json() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("broken");
        write(&dir.join("character.json"), "{ this is not json");
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
}
