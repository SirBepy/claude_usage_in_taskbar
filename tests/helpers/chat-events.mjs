// Shared ChatEvent factory helpers for the chat-renderer / event-store tests.
// Extracted from the per-file duplicates so new test files don't repeat them.

export function userEvent(text, ts = 0) {
  return { type: "user_message", content: [{ type: "text", text }], timestamp: ts };
}

export function assistantEvent(text, ts = 0) {
  return { type: "assistant_message", content: [{ type: "text", text }], streaming: false, timestamp: ts };
}

export function streamingEvent(text, ts = 0) {
  return { type: "assistant_message", content: [{ type: "text", text }], streaming: true, timestamp: ts };
}

export function finalEvent(text, ts = 0) {
  return { type: "assistant_message", content: [{ type: "text", text }], streaming: false, timestamp: ts };
}
