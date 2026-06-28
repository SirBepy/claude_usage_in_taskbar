//! Smoke test: parser + store wire up end-to-end on a fixture transcript.
//! We bypass axum routing and invoke the parse + store helpers directly,
//! since spinning up a full Tauri AppHandle in a unit test is heavyweight.

use claude_conductor_lib::skill_usage::{parser, store};
use std::path::PathBuf;

#[test]
fn parser_plus_store_roundtrips_on_fixture() {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/skill_usage/manual.jsonl");
    let tmp = tempfile::tempdir().unwrap();
    let events = parser::parse_transcript(&fixture);
    assert_eq!(events.len(), 1);
    store::append_events(tmp.path(), &events).unwrap();
    let day = events[0].ts.split('T').next().unwrap();
    store::mark_session(tmp.path(), &events[0].session_id, day).unwrap();
    let week = store::get_week(tmp.path(), day);
    assert_eq!(week.total_sessions, 1);
    let entry = week.entries.iter().find(|e| e.skill == "commit").unwrap();
    assert_eq!(entry.invocations.manual, 1);
    assert!(entry.tokens.total() > 0);
}
