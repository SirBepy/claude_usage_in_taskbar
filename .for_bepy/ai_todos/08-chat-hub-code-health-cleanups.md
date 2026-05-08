# Chat-hub code health cleanups

## Goal

If the chat-hub feature is kept (any path that doesn't full-revert), tidy two structural debts that piled up during the night-run.

## Context

Two findings from `/close` retrospective at the end of the chat-hub night-run (2026-05-08):

1. **`src-tauri/src/ipc/chat.rs` is ~500 lines** with multiple unrelated concerns: per-turn run flow, image attachments, history reads, lifecycle hooks. Has an obvious split seam.
2. **`escapeHtml` is duplicated** in `src/views/sessions/sessions.ts`, `src/views/history/history.ts`, and `src/shared/chat/chat-renderer.ts`. Three identical 11-line implementations.

Pre-condition: this only matters if the chat-hub work survives the cost-rejection decision (see `ai_todos/07-chat-hub-cost-rejection-followups.md`). If we full-revert to `06760a3`, both are moot.

## Approach

**`ipc/chat.rs` split.** Move into:

- `src-tauri/src/ipc/chat/mod.rs` (or `chat.rs`) - thin module decl + `ChatState` + `Cleanup` Drop guard.
- `src-tauri/src/ipc/chat/run.rs` - `run_session_turn`, `start_session`, `send_message`, `cancel_turn`, `blocks_to_prompt_text`.
- `src-tauri/src/ipc/chat/attachments.rs` - `paste_image`, `write_attachment`, `validate_session_id` (validate_session_id stays here since paste_image is the original caller; load_history imports it).
- `src-tauri/src/ipc/chat/history.rs` - `load_history`, `list_history`. (Distinct from `crate::chat::history::replay` which is the pure JSONL reader; don't conflate.)
- `src-tauri/src/ipc/chat/lifecycle.rs` - `cancel_all_inflight_turns`, `gc_attachments`, `takeover_manual`, `detach_window`, `reattach_window`. (These all touch the AppHandle / process-tree side rather than the per-turn IO loop.)

Tests inline in each new file. Re-export the IPC commands at module level so `lib.rs` invoke_handler keeps the `ipc::start_session` / `ipc::send_message` / etc. shape.

**escapeHtml extract.** Create `src/shared/escape-html.ts`:

```ts
export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}
```

Replace the local `escapeHtml` definitions in `sessions.ts`, `history.ts`, `chat-renderer.ts` with `import { escapeHtml } from "../../shared/escape-html"`. (Path adjusts per file depth.) The chat-renderer.ts version takes `s: string`; the new shared version accepts `unknown` so the existing call sites compile without change.

## Acceptance

- `src-tauri/src/ipc/chat.rs` is gone (or shrunk to module decl + state); each new submodule is under 200 lines.
- All existing tests still pass: `cargo test -p claude-usage-tauri --lib` (currently 189) and `pnpm test` (currently 30).
- `lib.rs` `invoke_handler` registers all the chat commands via the same `ipc::<command>` paths it already uses (no breakage).
- `pnpm build` clean.
- Skip both refactors entirely if Joe picks Path A (full revert) from `ai_todos/07`.
