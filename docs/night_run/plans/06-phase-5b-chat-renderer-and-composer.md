# Phase 5b - chat-renderer.js + composer.js

## Context

Implements Tasks 5.2 + 5.3 of `docs/superpowers/plans/2026-05-07-claude-chat-hub.md`. Frontend-only. Depends on Phase 5a.

Read "Task 5.2: Implement chat-renderer.js" and "Task 5.3: Implement composer.js" in the parent plan. Code blocks there are the source of truth.

## Goal

Two new ES modules in `src/modules/`:

- `src/modules/chat-renderer.js` - exports `class ChatRenderer { constructor(container); attach(sessionId); detach(); loadHistory(events); handleEvent(ev); ... }`. Subscribes to Tauri event `chat:<sessionId>`, renders `ChatEvent`s as DOM. Handles streaming (replace last assistant message when `streaming:true` chunks arrive; finalize on `streaming:false`).
- `src/modules/composer.js` - exports `class Composer { constructor(root, { onSend, onAttach }); setSessionId(id, { readOnly }); render(); send(); ... }`. Multi-line textarea, Enter to send, Shift+Enter for newline, paste handler converts clipboard images to base64 and calls `invoke('paste_image', { sessionId, base64Data, mime })` from Phase 6.

Append CSS for messages and composer to `src/dashboard.css` (the snippets in the parent plan's Task 5.2 Step 2 and Task 5.3 Step 2).

## Implementation

Copy the code from the parent plan verbatim with these adjustments:

- The `renderMarkdown` function in chat-renderer.js should escape HTML and return raw text for now (Phase 5d wires markdown-it). The placeholder version is fine:
  ```js
  function renderMarkdown(text) {
    return escapeHtml(text);
  }
  ```
- The composer's paste handler calls `invoke('paste_image', ...)` which doesn't exist yet (Phase 6). Wrap the invoke in a try/catch so the composer doesn't blow up on test loads:
  ```js
  try {
    const filePath = await invoke('paste_image', { sessionId: this.sessionId, base64Data: data, mime: blob.type });
    this.attachments.push({ mime: blob.type, data, path: filePath });
  } catch (e) {
    console.warn('paste_image not available yet:', e);
    this.attachments.push({ mime: blob.type, data, path: null });
  }
  ```
- Composer's `send()` builds `blocks: ContentBlock[]` to pass to the IPC `send_message`. After Phase 6 lands, image attachments become `<file:${a.path}>` mention text. For now, just push text-only:
  ```js
  if (text) blocks.push({ type: 'text', text });
  // images intentionally dropped this phase; Phase 6 wires them up
  ```

These adjustments make the modules functional without Phase 6 in place; Phase 6 will revisit composer.js to wire image-as-mention-text properly.

## Verification

- `cargo build -p claude-usage-tauri` clean (no Rust changes).
- 174 lib tests still pass.
- Read the new files to confirm:
  - Both classes export cleanly.
  - All event types from `ChatEvent` are handled in `handleEvent` (including `Notification` for hook events emitted by the parser).
  - Composer disables when `setSessionId(_, { readOnly: true })`.

## Gotchas

- The Tauri import is `import { invoke } from '@tauri-apps/api/core'` and `import { listen } from '@tauri-apps/api/event'`. Confirm these are the right module paths for this repo's Tauri 2 + Vite setup. Read another existing JS module first to mimic.
- `escapeHtml` should escape `&`, `<`, `>`, `"`, `'`. Don't escape backticks - they're harmless in HTML attributes.
- The renderer's `streamingIndex` tracks where the in-progress assistant message lives in `this.messages`. When a non-streaming `assistant_message` arrives, it replaces the streaming one. When `result` arrives (parsed as `streaming: false`), same behaviour.

## Don't

- Don't commit.
- Don't import markdown-it or shiki yet (Phase 5d).
- Don't import any image-handling lib.
- Don't add real-time scroll auto-pause logic.

## Acceptance

- Both files exist and parse without syntax errors.
- 174 lib tests still pass.
- The Composer module degrades gracefully when `paste_image` IPC is not yet registered (Phase 6 prerequisite).
