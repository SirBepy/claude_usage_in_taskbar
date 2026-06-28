use claude_conductor_lib::skill_usage::parser::parse_transcript;
use claude_conductor_lib::skill_usage::types::InvocationSource;
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
fn splits_multi_skill_turn_proportionally() {
    // Bodies in fixture: alpha=100 chars, beta=300 chars (total 400).
    // Next-turn usage: input=4000, output=100, cache_read=2000, cache_create=40.
    // alpha gets floor(usage * 100/400), beta gets the remainder.
    let events = parse_transcript(&fixture("multi_skill.jsonl"));
    assert_eq!(events.len(), 2, "expected 2 events, got {events:?}");

    let alpha = &events[0];
    let beta = &events[1];
    assert_eq!(alpha.skill, "alpha");
    assert_eq!(beta.skill, "beta");

    // First skill in turn keeps original source classification.
    assert_eq!(alpha.source, InvocationSource::Auto);
    // Second skill in the same turn was chained (skill_seen_since_user was set).
    assert_eq!(beta.source, InvocationSource::Skill);

    // Proportional split (alpha = 25%, beta = 75%) with remainder to last.
    assert_eq!(alpha.tokens.input, 1000);
    assert_eq!(alpha.tokens.output, 25);
    assert_eq!(alpha.tokens.cache_read, 500);
    assert_eq!(alpha.tokens.cache_create, 10);

    assert_eq!(beta.tokens.input, 3000);
    assert_eq!(beta.tokens.output, 75);
    assert_eq!(beta.tokens.cache_read, 1500);
    assert_eq!(beta.tokens.cache_create, 30);

    // Invariant: per-skill tokens sum to the original turn usage exactly.
    assert_eq!(alpha.tokens.input + beta.tokens.input, 4000);
    assert_eq!(alpha.tokens.output + beta.tokens.output, 100);
    assert_eq!(alpha.tokens.cache_read + beta.tokens.cache_read, 2000);
    assert_eq!(alpha.tokens.cache_create + beta.tokens.cache_create, 40);
}

#[test]
fn multi_skill_no_bodies_falls_back_to_equal_split() {
    // Edge: tool_results are missing (e.g. errored mid-turn). Split equally.
    let tmp = tempfile::tempdir().unwrap();
    let p = tmp.path().join("no_bodies.jsonl");
    std::fs::write(&p, concat!(
        r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]},"session_id":"s","cwd":"C:/proj/x"}"#, "\n",
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"a","name":"Skill","input":{"skill":"x"}},{"type":"tool_use","id":"b","name":"Skill","input":{"skill":"y"}}],"usage":{}},"session_id":"s"}"#, "\n",
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":100,"output_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}},"session_id":"s"}"#, "\n",
    )).unwrap();
    let events = parse_transcript(&p);
    assert_eq!(events.len(), 2);
    // Equal split: first gets 50, second gets remainder (50).
    assert_eq!(events[0].tokens.input + events[1].tokens.input, 100);
    assert_eq!(events[0].tokens.output + events[1].tokens.output, 10);
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
