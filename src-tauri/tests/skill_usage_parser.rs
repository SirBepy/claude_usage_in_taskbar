use claude_usage_tauri_lib::skill_usage::parser::parse_transcript;
use claude_usage_tauri_lib::skill_usage::types::InvocationSource;
use std::path::PathBuf;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("skill_usage")
        .join(name)
}

#[test]
fn parses_manual_invocation() {
    let events = parse_transcript(&fixture("manual.jsonl"));
    assert_eq!(events.len(), 1, "expected 1 event, got {events:?}");
    let e = &events[0];
    assert_eq!(e.skill, "commit");
    assert_eq!(e.source, InvocationSource::Manual);
    assert_eq!(e.session_id, "sess-a");
    assert_eq!(e.project, "foo");
    assert_eq!(e.tokens.input, 1200);
    assert_eq!(e.tokens.output, 300);
    assert_eq!(e.tokens.cache_read, 5000);
    assert_eq!(e.tokens.cache_create, 800);
}

#[test]
fn parses_chained_invocation() {
    let events = parse_transcript(&fixture("chained.jsonl"));
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].skill, "superpowers:brainstorming");
    // user typed "plan a feature for me" with no slash, so first skill is Auto.
    assert_eq!(events[0].source, InvocationSource::Auto);
    assert_eq!(events[1].skill, "superpowers:writing-plans");
    assert_eq!(events[1].source, InvocationSource::Skill);
    assert_eq!(events[1].tokens.input, 3000);
}

#[test]
fn parses_auto_invocation() {
    let events = parse_transcript(&fixture("auto.jsonl"));
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].source, InvocationSource::Auto);
    assert_eq!(events[0].skill, "superpowers:systematic-debugging");
    assert_eq!(events[0].tokens.input, 800);
}

#[test]
fn empty_transcript_returns_no_events() {
    let tmp = tempfile::tempdir().unwrap();
    let p = tmp.path().join("empty.jsonl");
    std::fs::write(&p, "").unwrap();
    let events = parse_transcript(&p);
    assert!(events.is_empty());
}

#[test]
fn missing_next_turn_yields_zero_tokens() {
    let tmp = tempfile::tempdir().unwrap();
    let p = tmp.path().join("orphan.jsonl");
    std::fs::write(&p, concat!(
        r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"/commit"}]},"session_id":"s","cwd":"C:/proj/x"}"#, "\n",
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Skill","input":{"skill":"commit"}}],"usage":{"input_tokens":50,"output_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}},"session_id":"s"}"#, "\n",
        r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"body"}]},"session_id":"s"}"#, "\n",
    )).unwrap();
    let events = parse_transcript(&p);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].tokens.total(), 0);
}
