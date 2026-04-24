//! Parses Obsidian's vault registry. Windows: `%APPDATA%\Obsidian\obsidian.json`.
//! macOS: `~/Library/Application Support/{Obsidian,obsidian}/obsidian.json`
//! (directory casing has varied across installer versions, so both are tried).

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
    let Some(cfg) = dirs::config_dir() else { return Ok(vec![]) };
    // On Windows `config_dir()` = %APPDATA%/Roaming.
    // On macOS `config_dir()` = ~/Library/Application Support.
    let candidates = [
        cfg.join("Obsidian").join("obsidian.json"),
        cfg.join("obsidian").join("obsidian.json"),
    ];
    for path in &candidates {
        match std::fs::read_to_string(path) {
            Ok(s) => return parse(&s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(vec![])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vaults_with_unix_style_paths() {
        let raw = r#"{"vaults":{"a":{"path":"/Users/joe/Vault A"},"b":{"path":"/Users/joe/Vault B"}}}"#;
        let out = parse(raw).unwrap();
        let paths: Vec<String> = out.iter().map(|p| p.display().to_string()).collect();
        assert!(paths.contains(&"/Users/joe/Vault A".to_string()));
        assert!(paths.contains(&"/Users/joe/Vault B".to_string()));
    }

    #[test]
    fn parses_vaults_with_windows_style_paths() {
        let raw = r#"{"vaults":{"a":{"path":"C:\\Users\\joe\\Vault"}}}"#;
        let out = parse(raw).unwrap();
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn empty_object_returns_empty_vec() {
        assert_eq!(parse(r#"{}"#).unwrap().len(), 0);
        assert_eq!(parse(r#"{"vaults":{}}"#).unwrap().len(), 0);
    }
}
