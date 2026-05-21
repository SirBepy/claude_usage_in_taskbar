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
    /// Set when a `content_block_start` with type "thinking" is seen in the
    /// stream. Stays true for the session lifetime so the statusbar keeps
    /// the indicator after the first thinking turn.
    has_thinking: bool,
    /// Live-stream mode. When true, the full `assistant` message line is
    /// suppressed: its visible text is already streamed via `stream_event`
    /// deltas and finalized by the trailing `result` line, and its usage is
    /// authoritative only on `result`. Forwarding it duplicates both the
    /// message and the TurnUsage, tripling every live turn (ai_todo 47).
    /// History replay (bare `parse_line`, no `result` line) is unaffected and
    /// keeps per-assistant-line usage. Defaults to false for back-compat.
    live: bool,
}

impl ParserContext {
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(4096),
            current_text: String::new(),
            has_thinking: false,
            live: false,
        }
    }

    /// Parser for a live `claude` stdout stream (daemon pump / runner). See the
    /// `live` field for why the full `assistant` line is suppressed.
    pub fn new_live() -> Self {
        Self { live: true, ..Self::new() }
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
            // accumulator state, so handle them inline. parse_result_line
            // handles `result` (also stateful: reads has_thinking). parse_line
            // covers the remaining stateless lines.
            if let Some(stream_events) = self.parse_stream_event_line(&line_str) {
                events.extend(stream_events);
            } else if let Some(result_events) = self.parse_result_line(&line_str) {
                events.extend(result_events);
            } else if self.live && is_full_assistant_line(&line_str) {
                // Redundant in a live stream: deltas already showed the text and
                // the `result` line finalizes it + carries authoritative usage.
                // Suppress to avoid duplicate messages / TurnUsage (ai_todo 47).
                // Tool calls are unaffected: tool_use blocks are not renderable
                // ContentBlocks, so an assistant line never carried them here.
                continue;
            } else {
                events.extend(parse_line(&line_str));
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
                } else if block_type == "thinking" {
                    self.has_thinking = true;
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

    /// Returns `Some(events)` if `line` is a `result` line, `None` otherwise.
    /// Emits both a finalized AssistantMessage and a TurnUsage event.
    fn parse_result_line(&mut self, line: &str) -> Option<Vec<ChatEvent>> {
        let v: Value = serde_json::from_str(line).ok()?;
        if v.get("type").and_then(|t| t.as_str())? != "result" {
            return None;
        }
        let ts = v.get("timestamp").and_then(|t| t.as_i64()).unwrap_or(0);
        let mut events = Vec::new();

        if let Some(t) = v.get("result").and_then(|s| s.as_str()) {
            events.push(ChatEvent::AssistantMessage {
                content: vec![crate::types::chat::ContentBlock::Text { text: t.to_string() }],
                streaming: false,
                timestamp: ts,
            });
        }

        let usage = v.get("usage");
        let input_tokens = usage.and_then(|u| u.get("input_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
        let output_tokens = usage.and_then(|u| u.get("output_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
        let cache_creation = usage.and_then(|u| u.get("cache_creation_input_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
        let cache_read = usage.and_then(|u| u.get("cache_read_input_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
        let total_cost_usd = v.get("total_cost_usd").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let duration_ms = v.get("duration_ms").and_then(|v| v.as_u64()).unwrap_or(0);

        events.push(ChatEvent::TurnUsage {
            input_tokens,
            output_tokens,
            cache_creation_input_tokens: cache_creation,
            cache_read_input_tokens: cache_read,
            total_cost_usd,
            duration_ms,
            has_thinking: self.has_thinking,
            model: None,
        });

        Some(events)
    }
}

/// True if `line` is a full `assistant` message line (`"type":"assistant"`),
/// as opposed to a `stream_event` delta or a `result` line. Used by live-mode
/// `feed()` to suppress these redundant lines (see `ParserContext::live`).
fn is_full_assistant_line(line: &str) -> bool {
    serde_json::from_str::<Value>(line)
        .ok()
        .as_ref()
        .and_then(|v| v.get("type"))
        .and_then(Value::as_str)
        == Some("assistant")
}

/// Parse one JSONL line and return 0-2 `ChatEvent`s. Most lines produce one
/// event; an "assistant" JSONL line that carries `message.model` + `message.usage`
/// also emits a `TurnUsage` so the statusbar can show model/cost from history.
pub fn parse_line(line: &str) -> Vec<ChatEvent> {
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let ts = v.get("timestamp").and_then(|t| t.as_i64()).unwrap_or(0);
    let Some(ty) = v.get("type").and_then(|t| t.as_str()) else { return vec![]; };
    match ty {
        // The init `system` line is what carries the session_id we care about.
        // Other system subtypes (hook_started / hook_response / SessionStart hook
        // re-emissions on each --resume turn) are noise for the chat surface and
        // are dropped here. The instance registry is fed via the dedicated
        // SessionStart HTTP hook, not via this stdout stream.
        "system" => {
            let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
            if subtype == "init" {
                vec![ChatEvent::SessionStarted {
                    session_id: v.get("session_id").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                    model: v.get("model").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                    cwd: v.get("cwd").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                    timestamp: ts,
                }]
            } else {
                vec![]
            }
        }
        "user" => {
            let Some(content_val) = v.get("message").and_then(|m| m.get("content")) else { return vec![]; };
            vec![ChatEvent::UserMessage {
                content: extract_content_blocks(content_val),
                timestamp: ts,
            }]
        }
        "assistant" => {
            // The transcript JSONL stores every claude reply as `assistant` lines
            // with a populated `stop_reason` (turn already finalized on disk).
            // The live `-p` stdout uses `stream_event` envelopes for partial
            // chunks plus a single trailing `assistant` line carrying the full
            // final message (also with `stop_reason` set). Either way, an
            // `assistant` line with a non-empty `stop_reason` is finalized -
            // mark streaming=false so the renderer doesn't keep its
            // streamingIndex pointing at the row across turn boundaries.
            let Some(message) = v.get("message") else { return vec![]; };
            let Some(content_val) = message.get("content") else { return vec![]; };
            let has_thinking = content_val
                .as_array()
                .map(|arr| arr.iter().any(|b| b.get("type").and_then(|t| t.as_str()) == Some("thinking")))
                .unwrap_or(false);
            let content = extract_content_blocks(content_val);
            let model = message.get("model").and_then(|s| s.as_str()).map(|s| s.to_string());
            let usage = message.get("usage");

            let mut evs = Vec::new();

            // Only emit AssistantMessage when there is visible text/image content.
            // Tool-use-only turns (all content blocks are type "tool_use") have no
            // renderable content, but we must NOT skip TurnUsage for them - those
            // turns still consume context window tokens that must reach the statusbar.
            if !content.is_empty() {
                let has_stop_reason = message
                    .get("stop_reason")
                    .and_then(|s| s.as_str())
                    .map(|s| !s.is_empty())
                    .unwrap_or(false);
                evs.push(ChatEvent::AssistantMessage {
                    content,
                    streaming: !has_stop_reason,
                    timestamp: ts,
                });
            }

            // JSONL assistant lines carry model + usage on the message object.
            // Always emit TurnUsage when present so the statusbar ctx% reflects
            // every turn's input tokens (including tool-use-only turns).
            if model.is_some() || usage.is_some() {
                let input_tokens = usage.and_then(|u| u.get("input_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
                let output_tokens = usage.and_then(|u| u.get("output_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
                let cache_creation = usage.and_then(|u| u.get("cache_creation_input_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
                let cache_read = usage.and_then(|u| u.get("cache_read_input_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
                evs.push(ChatEvent::TurnUsage {
                    input_tokens,
                    output_tokens,
                    cache_creation_input_tokens: cache_creation,
                    cache_read_input_tokens: cache_read,
                    total_cost_usd: 0.0,
                    duration_ms: 0,
                    has_thinking,
                    model,
                });
            }

            // If both evs are empty (no renderable content, no model/usage) drop silently.
            evs
        }
        "tool_use" => {
            let Some(id) = v.get("id").and_then(|s| s.as_str()) else { return vec![]; };
            vec![ChatEvent::ToolUse {
                tool_name: v.get("name").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                input: v.get("input").cloned().unwrap_or(Value::Null),
                id: id.to_string(),
                timestamp: ts,
            }]
        }
        "tool_result" => vec![ChatEvent::ToolResult {
            tool_use_id: v.get("tool_use_id").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            output: ContentBlock::Text {
                text: v.get("content").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            },
            is_error: v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false),
            timestamp: ts,
        }],
        // "result" is handled by ParserContext::parse_result_line (stateful:
        // needs has_thinking). If it reaches here somehow, drop it.
        "result" => vec![],
        "rate_limit_event" => {
            let info = v.get("rate_limit_info").cloned().unwrap_or(Value::Null);
            // status:"allowed" is the steady-state heartbeat claude -p emits
            // every turn. Surface only the actual rate-limit failures.
            let status = info.get("status").and_then(|s| s.as_str()).unwrap_or("");
            if status == "allowed" {
                return vec![];
            }
            vec![ChatEvent::Notification {
                kind: "rate_limit".into(),
                body: info.to_string(),
            }]
        }
        _ => vec![],
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

    // Realistic single-turn live stream: a streamed text delta, then the full
    // `assistant` line (finalized text + model/usage), then the `result` line.
    fn live_turn_lines() -> String {
        [
            r#"{"type":"stream_event","timestamp":1,"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}}"#,
            r#"{"type":"assistant","timestamp":2,"message":{"role":"assistant","model":"claude-haiku-4-5","stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":2},"content":[{"type":"text","text":"OK"}]}}"#,
            r#"{"type":"result","subtype":"success","timestamp":3,"result":"OK","total_cost_usd":0.01,"duration_ms":100,"usage":{"input_tokens":10,"output_tokens":2}}"#,
        ]
        .join("\n")
            + "\n"
    }

    #[test]
    fn live_mode_dedups_turn_to_single_usage_and_final_message() {
        // Regression for ai_todo 47: in a live stream the full `assistant` line
        // duplicated the streamed text + TurnUsage, tripling each turn.
        let mut ctx = ParserContext::new_live();
        let events = ctx.feed(live_turn_lines().as_bytes());

        let turn_usages = events
            .iter()
            .filter(|e| matches!(e, ChatEvent::TurnUsage { .. }))
            .count();
        assert_eq!(turn_usages, 1, "exactly one TurnUsage per live turn (from result)");

        let finalized = events
            .iter()
            .filter(|e| matches!(e, ChatEvent::AssistantMessage { streaming: false, .. }))
            .count();
        assert_eq!(finalized, 1, "exactly one finalized AssistantMessage (from result)");

        // The streaming delta still flows so the UI shows live typing.
        let streaming = events
            .iter()
            .filter(|e| matches!(e, ChatEvent::AssistantMessage { streaming: true, .. }))
            .count();
        assert!(streaming >= 1, "streaming deltas still forwarded in live mode");
    }

    #[test]
    fn history_mode_keeps_per_assistant_line_usage() {
        // History replay (non-live feed + bare parse_line) must still emit a
        // TurnUsage per assistant line - JSONL files have no `result` line, so
        // that is the only source of per-message model/cost.
        let mut ctx = ParserContext::new();
        let events = ctx.feed(live_turn_lines().as_bytes());
        let turn_usages = events
            .iter()
            .filter(|e| matches!(e, ChatEvent::TurnUsage { .. }))
            .count();
        assert_eq!(turn_usages, 2, "non-live: assistant line + result line both emit usage");

        // Bare parse_line on an assistant line is unchanged.
        let line = r#"{"type":"assistant","timestamp":2,"message":{"role":"assistant","model":"m","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"text","text":"hi"}]}}"#;
        let evs = parse_line(line);
        assert!(evs.iter().any(|e| matches!(e, ChatEvent::TurnUsage { .. })));
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
        let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"final answer","total_cost_usd":0.001,"duration_ms":1200,"usage":{"input_tokens":100,"output_tokens":10},"timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        // result emits AssistantMessage + TurnUsage
        assert_eq!(events.len(), 2);
        match &events[0] {
            ChatEvent::AssistantMessage { streaming, content, .. } => {
                assert_eq!(*streaming, false);
                match &content[0] {
                    ContentBlock::Text { text } => assert_eq!(text, "final answer"),
                    _ => panic!("expected text block"),
                }
            }
            _ => panic!("expected finalized AssistantMessage at index 0"),
        }
        match &events[1] {
            ChatEvent::TurnUsage { input_tokens, total_cost_usd, duration_ms, has_thinking, .. } => {
                assert_eq!(*input_tokens, 100);
                assert_eq!(*total_cost_usd, 0.001);
                assert_eq!(*duration_ms, 1200);
                assert!(!has_thinking);
            }
            _ => panic!("expected TurnUsage at index 1"),
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
    fn thinking_block_sets_has_thinking_in_turn_usage() {
        let mut ctx = ParserContext::new();
        let lines = [
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"result":"done","timestamp":1}"#,
        ];
        let mut all = Vec::new();
        for l in lines {
            all.extend(ctx.feed(format!("{}\n", l).as_bytes()));
        }
        let usage = all.iter().find(|e| matches!(e, ChatEvent::TurnUsage { .. }));
        match usage {
            Some(ChatEvent::TurnUsage { has_thinking, .. }) => assert!(has_thinking),
            _ => panic!("expected TurnUsage with has_thinking=true"),
        }
    }

    #[test]
    fn jsonl_assistant_with_thinking_block_sets_has_thinking() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"...","signature":"sig"},{"type":"text","text":"answer"}],"stop_reason":"end_turn","model":"claude-opus-4-7","usage":{"input_tokens":100,"output_tokens":20}},"timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        let usage = events.iter().find(|e| matches!(e, ChatEvent::TurnUsage { .. }));
        match usage {
            Some(ChatEvent::TurnUsage { has_thinking, .. }) => assert!(*has_thinking, "JSONL thinking block must set has_thinking"),
            _ => panic!("expected TurnUsage"),
        }
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
        // result emits AssistantMessage + TurnUsage.
        assert!(events.len() >= 1);
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
