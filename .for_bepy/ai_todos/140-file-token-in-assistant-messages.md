# Fix: `<file:...>` tokens incorrectly rendered as chips in assistant messages

## Goal

`renderFileSegments` currently runs on ALL message types (user AND assistant). When Claude writes
example text containing `<file:PATH>` (e.g. in a summary like "sent as `<file:PATH>` mentions"),
the token is converted to a broken chip with a warning icon instead of showing as plain code text.
Restrict chip conversion to user messages only.

## Context

Added paperclip attach button (`629a9a0`) which exposed this pre-existing rendering gap.

**Bug visible in screenshots** (`.for_bepy/screenshots/140-file-token-assistant-messages/`):
- `03-path-chip-in-assistant-bubble.png` - the clearest repro: Claude's summary sentence ends with
  "get sent as `<file:PATH>`..." and the `<file:PATH>` token became a ⚠️ chip labelled "PATH".
- `02-conversation-overview.png` / `01-question-popup-with-warning-chips.png` - earlier in the
  same conversation showing ⚠️ "displayname" chips in Claude's response (from example text
  "`<file:PATH::displayname>`").

**User message chips work fine** - thumbnail chip visible bottom-right of `02-...png`.

**Rendering pipeline** (`src/shared/chat/chat-transforms.ts`):
- `renderMessage()` calls `renderBlocks(content, true)` for user, `renderBlocks(blocks)` for
  assistant (no `breaks` flag = false).
- `renderBlocks` → `renderTextBlock(text, breaks)` → `renderFileSegments(text, breaks)`.
- `renderFileSegments` applies `FILE_TOKEN_RE = /<file:(.+?)(?:::(.+?))?>/g` to ALL text,
  regardless of role. Tokens found are converted to `attachmentChipHtml(path, name)`.

`<file:...>` tokens only legitimately appear in USER messages (emitted by `buildBlocks()` in
`src/shared/chat/composer.ts`). Assistant messages should NEVER have them as real attachment
references - any occurrence is example/code text that must pass through as markdown.

## Approach

Add a `fileChips` boolean parameter to `renderBlocks` and `renderTextBlock` (default `false`).
Only set it to `true` when rendering user messages.

```typescript
// chat-transforms.ts

export function renderBlocks(blocks: ContentBlock[], breaks = false, fileChips = false): string {
  return blocks.map((b) => {
    switch (b.type) {
      case "text":
        return renderTextBlock(b.text, breaks, fileChips);
      // ... rest unchanged
    }
  }).join("");
}

function renderTextBlock(rawText: string, breaks = false, fileChips = false): string {
  // ... existing voice/pasted-log stripping unchanged ...
  if (!fileChips) {
    // Assistant or other roles: go straight to markdown, never chip-convert.
    PASTED_LOG_RE.lastIndex = 0;
    if (!PASTED_LOG_RE.test(text)) {
      PASTED_LOG_RE.lastIndex = 0;
      return prefix + `<div class="block text">${renderMarkdown(text, breaks)}</div>`;
    }
    // pasted-log peeling still applies (those are user-composed blocks anyway)
    // but inner segments go to renderMarkdown, not renderFileSegments
  }
  PASTED_LOG_RE.lastIndex = 0;
  if (!PASTED_LOG_RE.test(text)) {
    PASTED_LOG_RE.lastIndex = 0;
    return prefix + renderFileSegments(text, breaks);
  }
  // ... pasted-log loop: pass fileChips down to inner segments ...
}

// Call site: user messages only
case "user":
  return `<div class="msg user">${renderBlocks(m.content ?? [], true, true)}</div>`;
```

Alternative rejected: gate on `breaks` (already a proxy for user vs. assistant). Works but
conflates two unrelated concerns - better to be explicit.

`eventToRenderedMessage` in `chat-transforms.ts` (line 314) is the other render path (bulk
history load) - it also calls `renderBlocks(m.content ?? [], true)` for user and needs the
`true` flag added there too.

Check `tool_result` rendering too - those blocks should not chip-convert either.

## Acceptance

- Attach an image in the chat via the paperclip button, send it - user message shows image chip.
- Claude's reply text that mentions `<file:path>` or `<file:path::name>` as an example renders as
  plain code/text (inside backticks or otherwise), NOT as a chip.
- Pasted-log chips in user messages still work.
- Voice-input chip still shows for dictated user messages.
- No TS errors (`pnpm tsc --noEmit` - ignore the 3 pre-existing errors in tool-views.ts and
  vendor/tauri_kit/frontend).
- Cargo build clean (`cargo build --manifest-path src-tauri/Cargo.toml`).
