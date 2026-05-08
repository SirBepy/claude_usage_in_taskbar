//! JSONL replay: read a claude session transcript file, emit ChatEvents.
//! Used by both the History view (read-only) and the Sessions view's reopen
//! path (replay before live attach).

use crate::chat::parser::parse_line;
use crate::types::chat::ChatEvent;
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
}
