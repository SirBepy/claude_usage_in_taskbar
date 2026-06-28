use claude_conductor_lib::hooks::session_files;
use std::io::Write;

#[test]
fn parses_bridge_session_id_from_fixture() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("123.json");
    let mut f = std::fs::File::create(&path).unwrap();
    writeln!(f, r#"{{"bridgeSessionId":"abc-123","other":"field"}}"#).unwrap();
    let out = session_files::read_bridge_session_id(&path).unwrap();
    assert_eq!(out, Some("abc-123".to_string()));
}

#[test]
fn returns_none_when_field_missing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("123.json");
    std::fs::write(&path, "{}").unwrap();
    assert!(session_files::read_bridge_session_id(&path).unwrap().is_none());
}

#[test]
fn returns_none_when_file_missing() {
    let path = std::path::PathBuf::from("C:/does/not/exist/123.json");
    assert!(session_files::read_bridge_session_id(&path).unwrap().is_none());
}
