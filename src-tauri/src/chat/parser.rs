//! Line-delimited stream-json parser. Each line of `claude -p --output-format=stream-json --verbose`
//! is one JSON object describing a chat event. This module turns those lines into typed
//! `ChatEvent`s and buffers across read boundaries (a line may straddle two `read()` calls
//! when streaming partial messages).

use crate::types::chat::{ChatEvent, ContentBlock};
use serde_json::Value;

pub struct ParserContext {
    buf: Vec<u8>,
    /// Accumulator for the current text content_block being assembled from
    /// `stream_event` `content_block_delta` lines. `--include-partial-messages`
    /// emits one stream_event per token chunk; we concatenate them so the
    /// frontend sees the running text grow in place. Cleared on each new
    /// `content_block_start { type: "text" }`.
    current_text: String,
}

impl ParserContext {
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(4096),
            current_text: String::new(),
        }
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
            // stream_event lines (--include-partial-messages output) need
            // accumulator state, so handle them inline. parse_line covers the
            // stateless lines (system/user/assistant/tool_use/tool_result/result).
            if let Some(stream_events) = self.parse_stream_event_line(&line_str) {
                events.extend(stream_events);
            } else if let Some(ev) = parse_line(&line_str) {
                events.push(ev);
            } else {
                eprintln!("parser: unrecognised line: {}", line_str);
            }
        }
        events
    }

    /// Returns `Some(events)` if `line` is a `stream_event` (possibly empty
    /// vec when the inner event is a no-op like message_start). `None` means
    /// the line is not a stream_event and should fall through to parse_line.
    fn parse_stream_event_line(&mut self, line: &str) -> Option<Vec<ChatEvent>> {
        let v: Value = serde_json::from_str(line).ok()?;
        if v.get("type").and_then(|t| t.as_str())? != "stream_event" {
            return None;
        }
        let event = v.get("event")?;
        let event_type = event.get("type").and_then(|t| t.as_str())?;
        let ts = v.get("timestamp").and_then(|t| t.as_i64()).unwrap_or(0);

        match event_type {
            "content_block_start" => {
                let block_type = event
                    .get("content_block")
                    .and_then(|c| c.get("type"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("");
                if block_type == "text" {
                    // New text block; discard any prior accumulator (defensive
                    // against malformed streams that skip content_block_stop).
                    self.current_text.clear();
                }
                Some(Vec::new())
            }
            "content_block_delta" => {
                let delta = event.get("delta")?;
                let delta_type = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if delta_type == "text_delta" {
                    let text = delta.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    self.current_text.push_str(text);
                    return Some(vec![ChatEvent::AssistantMessage {
                        content: vec![ContentBlock::Text { text: self.current_text.clone() }],
                        streaming: true,
                        timestamp: ts,
                    }]);
                }
                // signature_delta / thinking_delta / input_json_delta - skip silently.
                Some(Vec::new())
            }
            // message_start / content_block_stop / message_delta / message_stop
            // are bookkeeping; the standalone `result` line will finalize the
            // turn, so we don't emit a finalize from message_stop (would
            // duplicate).
            _ => Some(Vec::new()),
        }
    }
}

pub fn parse_line(line: &str) -> Option<ChatEvent> {
    let v: Value = serde_json::from_str(line).ok()?;
    let ts = v.get("timestamp").and_then(|t| t.as_i64()).unwrap_or(0);
    match v.get("type").and_then(|t| t.as_str())? {
        // The init `system` line is what carries the session_id we care about.
        // Other system subtypes (hook_started / hook_response / SessionStart hook
        // re-emissions on each --resume turn) are noise for the chat surface and
        // are dropped here. The instance registry is fed via the dedicated
        // SessionStart HTTP hook, not via this stdout stream.
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
                None
            }
        }
        "user" => Some(ChatEvent::UserMessage {
            content: extract_content_blocks(v.get("message")?.get("content")?),
            timestamp: ts,
        }),
        "assistant" => {
            // The transcript JSONL stores every claude reply as `assistant` lines
            // with a populated `stop_reason` (turn already finalized on disk).
            // The live `-p` stdout uses `stream_event` envelopes for partial
            // chunks plus a single trailing `assistant` line carrying the full
            // final message (also with `stop_reason` set). Either way, an
            // `assistant` line with a non-empty `stop_reason` is finalized -
            // mark streaming=false so the renderer doesn't keep its
            // streamingIndex pointing at the row across turn boundaries.
            //
            // Empty-content assistant lines (thinking-only blocks have no text)
            // are skipped to keep the chat clean.
            let message = v.get("message")?;
            let content = extract_content_blocks(message.get("content")?);
            if content.is_empty() {
                return None;
            }
            let has_stop_reason = message
                .get("stop_reason")
                .and_then(|s| s.as_str())
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            Some(ChatEvent::AssistantMessage {
                content,
                streaming: !has_stop_reason,
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
    fn assistant_chunk_without_stop_reason_marked_streaming() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":"partial"},"timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        match &events[0] {
            ChatEvent::AssistantMessage { streaming, .. } => assert!(*streaming),
            _ => panic!("expected streaming AssistantMessage"),
        }
    }

    #[test]
    fn assistant_with_stop_reason_marked_finalized() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"},"timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        match &events[0] {
            ChatEvent::AssistantMessage { streaming, content, .. } => {
                assert_eq!(*streaming, false);
                match &content[0] {
                    ContentBlock::Text { text } => assert_eq!(text, "done"),
                    _ => panic!("expected text"),
                }
            }
            _ => panic!("expected finalized AssistantMessage"),
        }
    }

    #[test]
    fn assistant_with_only_thinking_block_is_skipped() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"...","signature":"sig"}],"stop_reason":"end_turn"},"timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        assert!(events.is_empty(), "thinking-only assistant lines must not surface");
    }

    #[test]
    fn system_hook_subtypes_dropped() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"system","subtype":"hook_started","hook_name":"SessionStart:resume","timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        assert!(events.is_empty(), "hook chatter must not appear in chat");
    }

    #[test]
    fn replay_two_turn_jsonl_preserves_message_order() {
        // Reproduces Joe's bug: previously, every transcript assistant line was
        // marked streaming=true, so streamingIndex stayed pointing at turn 1's
        // reply slot and turn 2's reply overwrote it instead of appending.
        let lines = [
            r#"{"type":"user","message":{"role":"user","content":"first"},"timestamp":1}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"reply 1"}],"stop_reason":"end_turn"},"timestamp":2}"#,
            r#"{"type":"user","message":{"role":"user","content":"second"},"timestamp":3}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"reply 2"}],"stop_reason":"end_turn"},"timestamp":4}"#,
        ];
        let mut ctx = ParserContext::new();
        let mut all = Vec::new();
        for l in lines {
            all.extend(ctx.feed(format!("{}\n", l).as_bytes()));
        }
        // Expect 4 events in order, and every assistant marked finalized.
        assert_eq!(all.len(), 4);
        match &all[0] { ChatEvent::UserMessage { .. } => {}, _ => panic!("0: user") }
        match &all[1] {
            ChatEvent::AssistantMessage { streaming, content, .. } => {
                assert_eq!(*streaming, false);
                match &content[0] {
                    ContentBlock::Text { text } => assert_eq!(text, "reply 1"),
                    _ => panic!("text"),
                }
            }
            _ => panic!("1: assistant"),
        }
        match &all[2] { ChatEvent::UserMessage { .. } => {}, _ => panic!("2: user") }
        match &all[3] {
            ChatEvent::AssistantMessage { streaming, content, .. } => {
                assert_eq!(*streaming, false);
                match &content[0] {
                    ContentBlock::Text { text } => assert_eq!(text, "reply 2"),
                    _ => panic!("text"),
                }
            }
            _ => panic!("3: assistant"),
        }
    }

    #[test]
    fn stream_event_text_delta_accumulates_into_streaming_assistant() {
        let mut ctx = ParserContext::new();
        let lines = [
            r#"{"type":"stream_event","event":{"type":"message_start","message":{}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi. "}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Ready."}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#,
            r#"{"type":"stream_event","event":{"type":"message_stop"}}"#,
        ];
        let mut all = Vec::new();
        for l in lines {
            all.extend(ctx.feed(format!("{}\n", l).as_bytes()));
        }
        // Expect two streaming AssistantMessage events: "Hi. " then "Hi. Ready.".
        let streaming_msgs: Vec<_> = all
            .iter()
            .filter_map(|e| match e {
                ChatEvent::AssistantMessage { content, streaming, .. } if *streaming => {
                    match &content[0] {
                        ContentBlock::Text { text } => Some(text.clone()),
                        _ => None,
                    }
                }
                _ => None,
            })
            .collect();
        assert_eq!(streaming_msgs, vec!["Hi. ".to_string(), "Hi. Ready.".to_string()]);
    }

    #[test]
    fn stream_event_thinking_delta_does_not_emit() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        assert!(events.is_empty(), "signature_delta must not surface to UI");
    }

    #[test]
    fn stream_event_then_result_finalizes_correctly() {
        let mut ctx = ParserContext::new();
        let stream_lines = [
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Final answer."}}}"#,
            r#"{"type":"stream_event","event":{"type":"message_stop"}}"#,
        ];
        for l in stream_lines {
            ctx.feed(format!("{}\n", l).as_bytes());
        }
        let result_line = r#"{"type":"result","subtype":"success","is_error":false,"result":"Final answer.","timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", result_line).as_bytes());
        // The result line emits a finalized AssistantMessage (streaming=false).
        match &events[0] {
            ChatEvent::AssistantMessage { streaming, content, .. } => {
                assert_eq!(*streaming, false);
                match &content[0] {
                    ContentBlock::Text { text } => assert_eq!(text, "Final answer."),
                    _ => panic!("expected text"),
                }
            }
            _ => panic!("expected finalized AssistantMessage from result line"),
        }
    }

    #[test]
    fn new_text_block_resets_accumulator() {
        let mut ctx = ParserContext::new();
        let lines = [
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"First"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Second"}}}"#,
        ];
        let mut last: Option<String> = None;
        for l in lines {
            for ev in ctx.feed(format!("{}\n", l).as_bytes()) {
                if let ChatEvent::AssistantMessage { content, .. } = ev {
                    if let ContentBlock::Text { text } = &content[0] {
                        last = Some(text.clone());
                    }
                }
            }
        }
        assert_eq!(last, Some("Second".to_string()));
    }
}
