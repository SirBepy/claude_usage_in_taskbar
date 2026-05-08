use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ts_rs::TS)]
#[serde(tag = "type", rename_all = "lowercase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum ContentBlock {
    Text { text: String },
    Code { language: Option<String>, text: String },
    Image { mime: String, data: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ts_rs::TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum ChatEvent {
    SessionStarted {
        session_id: String,
        model: String,
        cwd: String,
        timestamp: i64,
    },
    UserMessage {
        content: Vec<ContentBlock>,
        timestamp: i64,
    },
    AssistantMessage {
        content: Vec<ContentBlock>,
        streaming: bool,
        timestamp: i64,
    },
    ToolUse {
        tool_name: String,
        #[ts(type = "unknown")]
        input: serde_json::Value,
        id: String,
        timestamp: i64,
    },
    ToolResult {
        tool_use_id: String,
        output: ContentBlock,
        is_error: bool,
        timestamp: i64,
    },
    Notification {
        kind: String,
        body: String,
    },
    SessionEnded {
        exit_code: Option<i32>,
        timestamp: i64,
    },
    /// Emitted once per completed turn from the `result` line.
    /// `input_tokens` = full context window usage for this turn (not additive).
    /// `total_cost_usd` = cumulative session cost estimate.
    TurnUsage {
        input_tokens: u64,
        output_tokens: u64,
        cache_creation_input_tokens: u64,
        cache_read_input_tokens: u64,
        total_cost_usd: f64,
        duration_ms: u64,
        has_thinking: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct HistoryEntry {
    pub session_id: String,
    pub project_id: String,
    pub title: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub message_count: u32,
    pub last_kind: crate::sessions::kinds::InstanceKind,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_message_round_trips() {
        let ev = ChatEvent::UserMessage {
            content: vec![ContentBlock::Text { text: "hi".into() }],
            timestamp: 1700000000,
        };
        let s = serde_json::to_string(&ev).unwrap();
        let back: ChatEvent = serde_json::from_str(&s).unwrap();
        assert_eq!(ev, back);
    }

    #[test]
    fn streaming_assistant_message_marks_partial() {
        let ev = ChatEvent::AssistantMessage {
            content: vec![ContentBlock::Text { text: "partial".into() }],
            streaming: true,
            timestamp: 1700000001,
        };
        let s = serde_json::to_string(&ev).unwrap();
        assert!(s.contains("\"streaming\":true"));
    }

    #[test]
    fn content_block_image_serializes_with_base64_data() {
        let block = ContentBlock::Image {
            mime: "image/png".into(),
            data: "ZmFrZQ==".into(),
        };
        let s = serde_json::to_string(&block).unwrap();
        assert!(s.contains("\"mime\":\"image/png\""));
        assert!(s.contains("\"data\":\"ZmFrZQ==\""));
    }
}
