//! JSONL replay: read a claude session transcript file, emit ChatEvents.
//! Used by both the History view (read-only) and the Sessions view's reopen
//! path (replay before live attach).

use crate::chat::parser::parse_line;
use crate::types::chat::{ChatEvent, HistoryPage};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

pub fn replay(path: &Path) -> Result<Vec<ChatEvent>, String> {
    let f = File::open(path).map_err(|e| format!("open {}: {}", path.display(), e))?;
    let reader = BufReader::new(f);
    let mut events = Vec::new();
    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        if let Some(ev) = parse_line(&line) {
            events.push(ev);
        }
    }
    Ok(events)
}

/// Returns true for events that count toward `message_limit` — the
/// user-perceived "message bubble" view: plain UserMessage and
/// AssistantMessage. Tool calls, results, notifications, session boundaries,
/// and turn-usage records are non-message events (returned in the page
/// alongside their surrounding messages, but do not count toward the limit).
fn is_message_event(ev: &ChatEvent) -> bool {
    matches!(
        ev,
        ChatEvent::UserMessage { .. } | ChatEvent::AssistantMessage { .. }
    )
}

/// Read a paginated window of the JSONL transcript at `path`.
///
/// - `before_seq = None` → window ends at EOF (the last lines).
/// - `before_seq = Some(s)` → window ends at seq `s - 1` (exclusive of `s`).
/// - `message_limit` is in *messages*, not events. Walk backward from the end
///   of the window counting only message-class events; stop when the count
///   reaches the limit or when seq 0 is reached.
///
/// All events in the resolved [oldest_seq, newest_seq] range are returned in
/// forward order, including non-message events like tool_use/tool_result that
/// fall between the message boundaries.
///
/// Orphan tool_results: a page may contain a `ToolResult` whose matching
/// `ToolUse` lives at a seq below `oldest_seq`. The renderer tolerates this
/// (tool_result rendering does not look up the matching tool_use), so no
/// backend expansion is performed.
pub fn read_page(
    path: &Path,
    before_seq: Option<u64>,
    message_limit: u32,
) -> Result<HistoryPage, String> {
    if matches!(before_seq, Some(0)) || message_limit == 0 {
        return Ok(HistoryPage {
            events: Vec::new(),
            oldest_seq: 0,
            newest_seq: 0,
            has_more: false,
        });
    }

    let f = File::open(path).map_err(|e| format!("open {}: {}", path.display(), e))?;
    let reader = BufReader::new(f);
    let mut all: Vec<(u64, ChatEvent)> = Vec::new();
    for (idx, line) in reader.lines().enumerate() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        if let Some(ev) = parse_line(&line) {
            all.push((idx as u64, ev));
        }
    }

    if all.is_empty() {
        return Ok(HistoryPage {
            events: Vec::new(),
            oldest_seq: 0,
            newest_seq: 0,
            has_more: false,
        });
    }

    let upper_idx: usize = match before_seq {
        None => all.len() - 1,
        Some(s) => match all.iter().rposition(|(seq, _)| *seq < s) {
            Some(i) => i,
            None => {
                return Ok(HistoryPage {
                    events: Vec::new(),
                    oldest_seq: 0,
                    newest_seq: 0,
                    has_more: false,
                });
            }
        },
    };

    let mut msg_count: u32 = 0;
    let mut lower_idx = upper_idx;
    loop {
        if is_message_event(&all[lower_idx].1) {
            msg_count += 1;
            if msg_count >= message_limit {
                break;
            }
        }
        if lower_idx == 0 {
            break;
        }
        lower_idx -= 1;
    }

    let slice = &all[lower_idx..=upper_idx];
    let oldest_seq = slice.first().map(|(s, _)| *s).unwrap_or(0);
    let newest_seq = slice.last().map(|(s, _)| *s).unwrap_or(0);
    let events: Vec<ChatEvent> = slice.iter().map(|(_, e)| e.clone()).collect();
    let has_more = oldest_seq > 0;
    Ok(HistoryPage {
        events,
        oldest_seq,
        newest_seq,
        has_more,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::chat::ContentBlock;
    use std::io::Write;

    #[test]
    fn replays_jsonl_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        let mut f = File::create(&p).unwrap();
        writeln!(
            f,
            r#"{{"type":"user","message":{{"role":"user","content":"hi"}},"timestamp":1}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"assistant","message":{{"role":"assistant","content":"hello"}},"timestamp":2}}"#
        )
        .unwrap();
        let events = replay(&p).unwrap();
        assert_eq!(events.len(), 2);
        match &events[0] {
            ChatEvent::UserMessage { content, .. } => match &content[0] {
                ContentBlock::Text { text } => assert_eq!(text, "hi"),
                _ => panic!("expected text block"),
            },
            _ => panic!("expected UserMessage"),
        }
    }

    #[test]
    fn replay_ignores_blank_lines() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("blank.jsonl");
        let mut f = File::create(&p).unwrap();
        writeln!(f).unwrap();
        writeln!(f, "   ").unwrap();
        writeln!(
            f,
            r#"{{"type":"user","message":{{"role":"user","content":"x"}},"timestamp":1}}"#
        )
        .unwrap();
        writeln!(f).unwrap();
        let events = replay(&p).unwrap();
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn replay_skips_unrecognized_lines() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("garbage.jsonl");
        let mut f = File::create(&p).unwrap();
        writeln!(f, "not json at all").unwrap();
        writeln!(f, r#"{{"type":"unknown_variant","x":1}}"#).unwrap();
        writeln!(
            f,
            r#"{{"type":"user","message":{{"role":"user","content":"keepme"}},"timestamp":1}}"#
        )
        .unwrap();
        let events = replay(&p).unwrap();
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn replay_returns_err_on_missing_file() {
        let r = replay(Path::new("/this/file/does/not/exist.jsonl"));
        assert!(r.is_err());
    }

    fn write_jsonl(path: &Path, lines: &[&str]) {
        let mut f = File::create(path).unwrap();
        for l in lines {
            writeln!(f, "{}", l).unwrap();
        }
    }

    fn user_line(text: &str, ts: i64) -> String {
        format!(
            r#"{{"type":"user","message":{{"role":"user","content":{:?}}},"timestamp":{}}}"#,
            text, ts
        )
    }

    fn assistant_line(text: &str, ts: i64) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"role":"assistant","content":{:?}}},"timestamp":{}}}"#,
            text, ts
        )
    }

    fn tool_use_line(id: &str, ts: i64) -> String {
        format!(
            r#"{{"type":"tool_use","id":{:?},"name":"X","input":{{}},"timestamp":{}}}"#,
            id, ts
        )
    }

    fn tool_result_line(tool_use_id: &str, ts: i64) -> String {
        format!(
            r#"{{"type":"tool_result","tool_use_id":{:?},"content":"ok","is_error":false,"timestamp":{}}}"#,
            tool_use_id, ts
        )
    }

    #[test]
    fn read_page_last_n_messages() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.jsonl");
        let mut lines: Vec<String> = Vec::new();
        for i in 0..30 {
            lines.push(user_line(&format!("u{}", i), i as i64 * 2));
            lines.push(assistant_line(&format!("a{}", i), i as i64 * 2 + 1));
        }
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        write_jsonl(&p, &refs);
        let page = read_page(&p, None, 20).unwrap();
        assert_eq!(page.events.len(), 20);
        assert_eq!(page.oldest_seq, 40);
        assert_eq!(page.newest_seq, 59);
        assert!(page.has_more);
    }

    #[test]
    fn read_page_non_message_events_dont_count() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("b.jsonl");
        let mut lines: Vec<String> = Vec::new();
        for i in 0..5 {
            lines.push(user_line(&format!("u{}", i), i as i64));
            lines.push(tool_use_line(&format!("t{}", i), i as i64));
            lines.push(tool_result_line(&format!("t{}", i), i as i64));
            lines.push(assistant_line(&format!("a{}", i), i as i64));
        }
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        write_jsonl(&p, &refs);
        let page = read_page(&p, None, 10).unwrap();
        assert_eq!(page.oldest_seq, 0);
        assert!(!page.has_more);
        assert_eq!(page.events.len(), 20);
    }

    #[test]
    fn read_page_before_seq_returns_disjoint() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("c.jsonl");
        let mut lines: Vec<String> = Vec::new();
        for i in 0..40 {
            lines.push(user_line(&format!("u{}", i), i as i64 * 2));
            lines.push(assistant_line(&format!("a{}", i), i as i64 * 2 + 1));
        }
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        write_jsonl(&p, &refs);
        let p1 = read_page(&p, None, 20).unwrap();
        let p2 = read_page(&p, Some(p1.oldest_seq), 20).unwrap();
        assert_eq!(p2.newest_seq + 1, p1.oldest_seq);
        assert_eq!(p2.events.len(), 20);
        assert!(p2.has_more);
    }

    #[test]
    fn read_page_walks_to_start() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("d.jsonl");
        let mut lines: Vec<String> = Vec::new();
        for i in 0..15 {
            lines.push(user_line(&format!("u{}", i), i as i64));
        }
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        write_jsonl(&p, &refs);
        let p1 = read_page(&p, None, 10).unwrap();
        let p2 = read_page(&p, Some(p1.oldest_seq), 10).unwrap();
        assert!(!p2.has_more);
        assert_eq!(p1.events.len() + p2.events.len(), 15);
    }

    #[test]
    fn read_page_orphan_tool_result_passes_through() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("e.jsonl");
        let lines = vec![
            tool_use_line("t1", 0),
            user_line("u0", 1),
            tool_result_line("t1", 2),
            assistant_line("a0", 3),
        ];
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        write_jsonl(&p, &refs);
        let page = read_page(&p, None, 2).unwrap();
        assert_eq!(page.oldest_seq, 1);
        assert_eq!(page.newest_seq, 3);
        assert_eq!(page.events.len(), 3);
        assert!(page.has_more);
        assert!(matches!(page.events[1], ChatEvent::ToolResult { .. }));
    }

    #[test]
    fn read_page_before_seq_zero_empty() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.jsonl");
        write_jsonl(&p, &[&user_line("u0", 0)]);
        let page = read_page(&p, Some(0), 20).unwrap();
        assert_eq!(page.events.len(), 0);
        assert!(!page.has_more);
        assert_eq!(page.oldest_seq, 0);
        assert_eq!(page.newest_seq, 0);
    }
}
