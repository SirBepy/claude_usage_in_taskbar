---
id: 135
title: Clickable file references in chat - open in app or right-click open with
priority: low
area: frontend / chat
---

## What

When Claude mentions a file path in a chat message, it should be rendered as a clickable chip/link. Left-click opens the file in the default editor (VS Code, or whatever the OS default is). Right-click shows a context menu with "Open with..." so the user can pick the app.

## Behavior spec

- **Detection**: scan each assistant message for full absolute paths (see todo 136 for the injection that ensures Claude always emits full paths). Also handle relative paths if the session's working directory is known (available from the session CWD in session state).
- **Rendering**: inline chip styled like the existing tool-chip components - monospace filename, small icon (folder or file type icon), not a raw underlined hyperlink
- **Left-click**: `tauri::api::shell::open()` or the equivalent Tauri 2 opener plugin - opens in OS default for that extension
- **Right-click**: context menu with:
  - Open (default app)
  - Open with... (OS file picker / shell verb)
  - Copy path
  - Reveal in Explorer / Finder
- **Scope**: assistant messages only; user messages are not parsed (no false positives on paths the user pastes)

## Implementation sketch

1. In the message renderer (where tool-chips are already built), add a post-pass regex that matches full paths: `[A-Za-z]:\\[^\s"'<>]+` (Windows) and `/[^\s"'<>]+` (Unix), min 3 path segments to avoid false positives on short tokens
2. Replace matched spans with a `<file-ref>` custom element (or a Lit directive) that carries the resolved absolute path
3. `file-ref` renders a chip; click handlers call a new `open_file` IPC command
4. Rust side: `open_file` uses `opener::open()` (the `opener` crate, already used by Tauri for shell opens) for left-click; for "Open with" emit a Tauri event that triggers the OS "open with" dialog (Windows: `ShellExecute` with `openas` verb; macOS: `NSWorkspace openFile:withApplication:`)
5. New IPC command needs an entry in `src-tauri/capabilities/default.json`

## Success criteria

- Full paths in Claude's replies render as chips, not raw text
- Left-click opens the file immediately in the default editor
- Right-click shows the context menu with all 4 options
- Non-path text is never incorrectly matched
- Works on both Windows (drive-letter paths) and macOS (Unix paths)

## Dependencies

- Todo 136 (inject full-path instruction) must land first so Claude reliably emits parseable paths
