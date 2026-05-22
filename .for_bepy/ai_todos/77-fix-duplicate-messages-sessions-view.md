# Fix duplicate messages in Sessions chat view

## Goal

Eliminate duplicate messages appearing in the Sessions chat history: "Continue from where you left off.", isUsingOverage JSON blocks, and user messages repeating.

## Context

Observed in chat: "Continue from where you left off." appears twice, two identical isUsingOverage stat blocks, and user messages like "say 5" duplicated. Root cause likely in:
- `src-tauri/src/chat/parser.rs` (ParserContext::new_live dedup logic for stream-json -> ChatEvent)
- `src/shared/chat/chat-renderer.ts` (virtualized DOM render, duplicate suppression)
- IPC event flow (instance state updates broadcasting to all windows)

Memory note: [[project_parser_live_mode_dedup.md]] states live stream finalizes only from `result` line; per-assistant-line usage is history-only. Don't break that dedup.

## Approach

1. Trace one duplicated message end-to-end: check parser output, IPC events, frontend render.
2. Identify which layer is emitting duplicates (parser, runner, IPC, or renderer).
3. Fix at source (prefer parser/runner over renderer suppression).
4. Verify no regression in parser live-mode dedup or history load.

## Acceptance

- "Continue from where you left off." appears exactly once in chat.
- isUsingOverage stats not duplicated.
- User messages appear once.
- No new duplicates on turn complete or history reload.
