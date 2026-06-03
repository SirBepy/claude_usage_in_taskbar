# (Low priority) Share the stream-json text_delta extraction

## Goal
Two places now parse the same `stream_event -> content_block_delta -> text_delta` shape from `claude --output-format stream-json`. Consider a shared helper so the wire format lives in one spot. Low priority - they serve different needs and the duplication is ~6 lines.

## Context
- `src-tauri/src/chat/parser.rs` `ParserContext` - a stateful, buffering machine that turns the full stream into typed `ChatEvent`s (handles content_block_start/delta/stop, thinking, result, usage). Used by the chat daemon.
- `src-tauri/src/news/summarizer.rs` `parse_text_delta` - a tiny stateless extractor that pulls just the visible `text_delta` text from one line, for the news summary stream.

They're not a clean dup: reusing the heavy `ParserContext` for the one-shot summary would be the wrong call (stateful, ChatEvent-producing, overkill). The only真 overlap is the literal JSON path `event.type=="content_block_delta" && delta.type=="text_delta"`.

## Approach
If/when it's worth it: extract a free function like `stream_json::text_delta(line: &str) -> Option<&str>` into a shared module (e.g. `chat/parser.rs` or a small `stream_json.rs`) and have both `ParserContext`'s delta branch and `summarizer::parse_text_delta` call it. Keep `parse_text_delta`'s thinking-filter behavior. Only do this if touching that area anyway - not worth a standalone change.

## Acceptance
- One function owns the `text_delta` JSON-path knowledge; both callers use it.
- summarizer tests (`parse_text_delta_*`) and chat parser tests still pass.
