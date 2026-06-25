---
id: 136
title: Inject app-aware formatting instructions when starting a new chat
priority: low
area: backend / chat
---

## What

When the app spawns a new Claude session, inject a short system-level instruction block so Claude knows how to format things the app can act on. The immediate need is full absolute file paths (so todo 135 can parse and open them), but the mechanism is general - a single place to add future app-aware formatting rules.

## Behavior spec

- Injected text is silent to the user - it should not appear as a visible message bubble in the chat UI
- It must arrive as the very first user turn (before Joe types anything), since `-p` sessions don't have a true system prompt slot
- Claude should acknowledge it implicitly by following the rules, not by replying to it
- The instruction block should be short and mechanical - not a persona prompt

## Suggested injection text (starting point, refine as needed)

```
<app-instructions>
You are running inside the Claude Companion app. Follow these formatting rules so the app can parse and act on your output:
- File paths: always use the full absolute path (e.g. C:\Users\joe\project\src\main.rs or /home/joe/project/src/main.rs). Never use relative paths or ~ shorthand.
- These rules apply to every file mention: in prose, in code block headers, in tool output references, everywhere.
</app-instructions>
```

## Implementation sketch

1. In `chat/session.rs` (or wherever the daemon spawns the `claude -p` process and sends the first stdin turn), add an optional `inject_instructions` step that writes the instruction block as the opening stdin message before the session is handed to the user
2. The injected message should use a sentinel format the frontend recognizes and suppresses from rendering - e.g. wrap it in `<app-instructions>` tags and teach the message renderer to drop any assistant/user bubble whose content is only an `<app-instructions>` block
3. Make the instruction text configurable (stored in app config or a hardcoded constant in one place) so it's easy to extend later without hunting through Rust source
4. Consider a dev toggle to echo the injected text in a collapsed chip for debugging, hidden in prod

## Why inject vs. CLAUDE.md

CLAUDE.md changes are per-project and require the user to have a CLAUDE.md in every repo. Injection at the session level is universal - it applies to every session the app starts regardless of project. Both can coexist: CLAUDE.md handles project-specific rules, injection handles app-level UI contracts.

## Success criteria

- Every new session started from the app has the instruction block sent as the first turn
- The instruction bubble is not visible in the chat UI
- Claude's replies in those sessions use full absolute paths for file references
- Adding a new formatting rule requires editing exactly one place in the codebase

## Related

- Todo 135 depends on this landing first
