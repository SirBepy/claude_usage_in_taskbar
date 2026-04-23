//! Parses Obsidian's vault registry from `%APPDATA%\Obsidian\obsidian.json`.

use anyhow::Result;
use std::path::PathBuf;

pub fn parse(raw: &str) -> Result<Vec<PathBuf>> {
    let v: serde_json::Value = serde_json::from_str(raw)?;
    let Some(vaults) = v.get("vaults").and_then(|v| v.as_object()) else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    for (_, entry) in vaults {
        if let Some(p) = entry.get("path").and_then(|p| p.as_str()) {
            out.push(PathBuf::from(p));
        }
    }
    Ok(out)
}

pub fn detect() -> Result<Vec<PathBuf>> {
    let Some(appdata) = dirs::config_dir() else { return Ok(vec![]) };
    // On Windows `config_dir()` = %APPDATA%/Roaming.
    let path = appdata.join("Obsidian").join("obsidian.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.into()),
    };
    parse(&raw)
}
