use claude_usage_tauri_lib::vault_detector;

#[test]
fn parses_vault_paths_from_obsidian_json() {
    let raw = r#"{ "vaults": {
        "abc": { "path": "C:/Users/x/Obsidian/Vault1", "ts": 1 },
        "def": { "path": "C:/Users/x/Notes",           "ts": 2 }
    }}"#;
    let got = vault_detector::parse(raw).unwrap();
    let mut paths: Vec<_> = got.iter().map(|p| p.to_string_lossy().to_string()).collect();
    paths.sort();
    assert_eq!(paths, vec!["C:/Users/x/Notes", "C:/Users/x/Obsidian/Vault1"]);
}

#[test]
fn returns_empty_when_vaults_missing() {
    let got = vault_detector::parse("{}").unwrap();
    assert!(got.is_empty());
}

#[test]
fn tolerates_malformed_entries() {
    let raw = r#"{ "vaults": {
        "abc": { "path": "C:/x" },
        "def": "garbage",
        "ghi": {}
    }}"#;
    let got = vault_detector::parse(raw).unwrap();
    assert_eq!(got.len(), 1);
}
