//! Line-delimited stream-json parser. Each line of `claude -p --output-format=stream-json --verbose`
//! is one JSON object describing a chat event. This module turns those lines into typed
//! `ChatEvent`s and buffers across read boundaries (a line may straddle two `read()` calls
//! when streaming partial messages).

use crate::types::chat::{ChatEvent, ContentBlock};
use serde_json::Value;

pub struct ParserContext {
    buf: Vec<u8>,
}

impl ParserContext {
    pub fn new() -> Self {
        Self { buf: Vec::with_capacity(4096) }
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<ChatEvent> {
        self.buf.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            // strip trailing \n (and possible \r on Windows)
            let len = line.len().saturating_sub(1);
            let trimmed = if len > 0 && line[len - 1] == b'\r' { len - 1 } else { len };
            let line_str = String::from_utf8_lossy(&line[..trimmed]);
            if line_str.trim().is_empty() {
                continue;
            }
            if let Some(ev) = parse_line(&line_str) {
                events.push(ev);
            } else {
                eprintln!("parser: unrecognised line: {}", line_str);
            }
        }
        events
    }
}

pub fn parse_line(line: &str) -> Option<ChatEvent> {
    let v: Value = serde_json::from_str(line).ok()?;
    let ts = v.get("timestamp").and_then(|t| t.as_i64()).unwrap_or(0);
    match v.get("type").and_then(|t| t.as_str())? {
        // The init `system` line is what carries the session_id we care about.
        "system" => {
            let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
            if subtype == "init" {
                Some(ChatEvent::SessionStarted {
                    session_id: v.get("session_id").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                    model: v.get("model").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                    cwd: v.get("cwd").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                    timestamp: ts,
                })
            } else {
                // hook_started / hook_response / etc - surface as Notification so the UI can
                // show "running hook X" if desired, without a dedicated variant.
                let body = v.get("hook_name").and_then(|s| s.as_str()).unwrap_or(subtype).to_string();
                Some(ChatEvent::Notification { kind: format!("system.{}", subtype), body })
            }
        }
        "user" => Some(ChatEvent::UserMessage {
            content: extract_content_blocks(v.get("message")?.get("content")?),
            timestamp: ts,
        }),
        "assistant" => {
            // -p --include-partial-messages emits multiple `assistant` lines per turn,
            // each carrying a token chunk. The runner detects "is this the final assistant
            // line for the turn" by seeing the subsequent `result` line; for now, we mark
            // every chunk as streaming=true and finalize on the result line.
            Some(ChatEvent::AssistantMessage {
                content: extract_content_blocks(v.get("message")?.get("content")?),
                streaming: true,
                timestamp: ts,
            })
        }
        "tool_use" => Some(ChatEvent::ToolUse {
            tool_name: v.get("name").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            input: v.get("input").cloned().unwrap_or(Value::Null),
            id: v.get("id").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            timestamp: ts,
        }),
        "tool_result" => Some(ChatEvent::ToolResult {
            tool_use_id: v.get("tool_use_id").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            output: ContentBlock::Text {
                text: v.get("content").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            },
            is_error: v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false),
            timestamp: ts,
        }),
        // "result" marks the end of a turn under -p. Translate it into a finalized
        // assistant message so the UI flips streaming->finalized in one event.
        // The runner additionally consults this line for `total_cost_usd` / `usage`.
        "result" => {
            let final_text = v.get("result").and_then(|s| s.as_str()).map(|s| s.to_string());
            final_text.map(|t| ChatEvent::AssistantMessage {
                content: vec![ContentBlock::Text { text: t }],
                streaming: false,
                timestamp: ts,
            })
        }
        "rate_limit_event" => {
            let info = v.get("rate_limit_info").cloned().unwrap_or(Value::Null);
            Some(ChatEvent::Notification {
                kind: "rate_limit".into(),
                body: info.to_string(),
            })
        }
        _ => None,
    }
}

fn extract_content_blocks(v: &Value) -> Vec<ContentBlock> {
    if let Some(s) = v.as_str() {
        return vec![ContentBlock::Text { text: s.to_string() }];
    }
    if let Some(arr) = v.as_array() {
        return arr.iter().filter_map(|item| {
            match item.get("type")?.as_str()? {
                "text" => Some(ContentBlock::Text {
                    text: item.get("text")?.as_str()?.to_string(),
                }),
                "image" => Some(ContentBlock::Image {
                    mime: item.get("source")?.get("media_type")?.as_str()?.to_string(),
                    data: item.get("source")?.get("data")?.as_str()?.to_string(),
                }),
                _ => None,
            }
        }).collect();
    }
    vec![]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_system_init_as_session_started() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"system","subtype":"init","session_id":"abc","model":"claude-opus-4-7","cwd":"/tmp/x","timestamp":1700000000}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        assert_eq!(events.len(), 1);
        match &events[0] {
            ChatEvent::SessionStarted { session_id, model, cwd, .. } => {
                assert_eq!(session_id, "abc");
                assert_eq!(model, "claude-opus-4-7");
                assert_eq!(cwd, "/tmp/x");
            }
            _ => panic!("expected SessionStarted"),
        }
    }

    #[test]
    fn parses_user_message() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"user","message":{"role":"user","content":"hello"},"timestamp":1700000000}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        assert_eq!(events.len(), 1);
        match &events[0] {
            ChatEvent::UserMessage { content, .. } => {
                match &content[0] {
                    ContentBlock::Text { text } => assert_eq!(text, "hello"),
                    _ => panic!("expected text block"),
                }
            }
            _ => panic!("expected UserMessage"),
        }
    }

    #[test]
    fn buffers_across_boundaries() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"user","message":{"role":"user","content":"hi"},"timestamp":1}"#;
        let bytes = format!("{}\n", line);
        let mid = bytes.len() / 2;
        let first = ctx.feed(&bytes.as_bytes()[..mid]);
        let second = ctx.feed(&bytes.as_bytes()[mid..]);
        assert!(first.is_empty());
        assert_eq!(second.len(), 1);
    }

    #[test]
    fn ignores_empty_lines_and_blank_whitespace() {
        let mut ctx = ParserContext::new();
        let events = ctx.feed(b"\n\n   \n");
        assert!(events.is_empty());
    }

    #[test]
    fn handles_crlf_line_endings() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"system","subtype":"init","session_id":"x","timestamp":1}"#;
        let events = ctx.feed(format!("{}\r\n", line).as_bytes());
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], ChatEvent::SessionStarted { .. }));
    }

    #[test]
    fn result_line_finalizes_assistant_message() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"final answer","timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        assert_eq!(events.len(), 1);
        match &events[0] {
            ChatEvent::AssistantMessage { streaming, content, .. } => {
                assert_eq!(*streaming, false);
                match &content[0] {
                    ContentBlock::Text { text } => assert_eq!(text, "final answer"),
                    _ => panic!("expected text block"),
                }
            }
            _ => panic!("expected finalized AssistantMessage"),
        }
    }

    #[test]
    fn assistant_chunk_marked_streaming() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":"partial"},"timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        match &events[0] {
            ChatEvent::AssistantMessage { streaming, .. } => assert!(*streaming),
            _ => panic!("expected streaming AssistantMessage"),
        }
    }
}
