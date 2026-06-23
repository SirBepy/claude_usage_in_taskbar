# AI takes screenshots and shows them inline in a chat

## Goal

Give the in-app chat AI (the daemon-hosted `claude -p` session) the ability to capture a screenshot and have it render INLINE in the chat, so when Joe says e.g. "test this with Playwright", Claude runs the test, grabs screenshots, and Joe sees them in the conversation instead of just a file path or prose.

## Context

- The in-app chat is a persistent `claude -p --output-format=stream-json` process hosted by the daemon (one per session). Its stream-json output is parsed and rendered by the chat UI. See memory `project_daemon_chat_persistent_process` and `project_claude_cli_stream_json`.
- **Image rendering in chat already partly exists.** Pasted-image attachments render via the `read_attachment` IPC (daemon RPC + HttpTransport mapping), which path-validates against the chat-attachments dir so it is NOT an arbitrary file read (see `COMMENTS_FOR_BEPY.md` "Bug 4", `src/shared/transport.ts` `read_attachment` case, and `read_image_file` deliberately NOT exposed). Tool chips render in `src/shared/chat/tool-views.ts`.
- **Phone parity matters.** Whatever serves the image must work over the HttpTransport too (phone PWA), like `read_attachment` and `character_asset_url` already do. A desktop-only tauri asset:// path would not show on the phone.
- A `/screenshot` skill + a persistent Playwright helper already exist for desktop portfolio screenshots — but that is a Claude Code skill, NOT reusable by the headless in-app `claude -p` AI (see memory `reference_btw_is_cc_builtin_not_headless`). The in-app AI would drive Playwright itself (it has Bash) and save image files.
- Joe flagged this likely needs a **CLAUDE.md** update: the AI needs to KNOW the convention for surfacing a screenshot (where to save it + how to reference it so the renderer picks it up). This is the same shape as the send-vs-display sentinel pattern (memory `feedback_send_vs_display_split`): the AI emits something the renderer collapses/expands, not raw bytes.

## Approach

Decisions to settle with Joe before building (don't guess these):
1. **Mechanism** — three candidates:
   - (a) **File convention + sentinel**: AI saves the PNG into the chat-attachments dir and emits a sentinel/marker (e.g. a fenced `screenshot:<path>` or an HTML-ish chip) that the chat renderer detects and replaces with an `<img>` served through `read_attachment`. Lowest new surface; reuses the existing path-validated image route. Pairs naturally with a CLAUDE.md instruction.
   - (b) **Custom MCP tool** `show_screenshot(path)` exposed to the in-app session; the daemon validates + relays it to the chat UI as an image block. More structured, more wiring (new tool + relay + render).
   - (c) **Markdown image** `![](...)`: markdown-it already renders in chat, but a raw local path won't load in the webview/PWA without routing through an allowed scheme — so it still needs (a)'s serving route under the hood.
   - Lean: (a) — convention + sentinel reusing `read_attachment`, because the secure image-serving path already exists and is phone-mapped.
2. **Trigger** — explicit ("take a screenshot") only, or automatic after a Playwright/test run? Probably explicit-or-on-request first; auto-capture is a later nicety.
3. **Storage + cleanup** — reuse the chat-attachments dir (already path-validated + phone-served) vs a new screenshots dir; retention/cleanup policy.
4. **CLAUDE.md change** — once the convention is fixed, add a short instruction to the project CLAUDE.md (and/or the per-session injected instructions the daemon writes) telling the AI: where to save a screenshot and the exact marker to emit so it renders inline.

Then implement the chosen mechanism, wire the renderer (and the phone path), and document the convention in CLAUDE.md.

## Acceptance

- In an in-app chat, asking the AI to screenshot something (e.g. a Playwright run) results in the image rendering INLINE in the conversation, on BOTH desktop and the phone PWA.
- The image-serving path stays path-validated (no arbitrary-file-read regression — `read_image_file` must remain unexposed; reuse/extend `read_attachment`'s validation).
- CLAUDE.md documents the convention so the AI does it without being re-told each turn.
- No regression to existing pasted-attachment image rendering.
