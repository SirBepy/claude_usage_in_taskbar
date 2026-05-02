use claude_usage_tauri_lib::settings::load;
use std::io::Write;
use tempfile::NamedTempFile;

/// `Settings.extra` uses `#[serde(flatten)]`, so any top-level JSON key that
/// does not match a named field lands in `extra`. Legacy settings files stored
/// `projectNotifOverrides` as a top-level key (serialised out of `extra` by
/// flatten). This test verifies that `load` strips it so it can never come back.
#[test]
fn load_drops_legacy_project_notif_overrides() {
    let raw = r#"{
        "projectNotifOverrides": {
            "C:/proj": { "workFinished": { "enabled": true } }
        }
    }"#;
    let mut tmp = NamedTempFile::new().unwrap();
    tmp.write_all(raw.as_bytes()).unwrap();
    let s = load(tmp.path());
    assert!(s.extra.get("projectNotifOverrides").is_none(),
        "projectNotifOverrides must be dropped on load");
}
