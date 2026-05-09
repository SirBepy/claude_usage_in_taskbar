# Extend cleanUserBlocks coverage to tool_result content if grey blocks turn out to be tool_result

## Goal

Decide whether `<command-*>` wrapper tags also bleed into `tool_result` blocks rendered in the chat pane, and if so, strip them there too.

## Context

In the 2026-05-09 chat-hub UI fix session, Joe sent two screenshots:

- Image 1: empty purple user bubbles on the right + grey-bordered blocks on the left containing raw `<command-message>...</command-message><command-name>...</command-name>` text.
- Image 2: chat with normal-looking assistant replies + user messages.

The fix shipped in `src/shared/chat/chat-renderer.ts::cleanUserBlocks` strips those tags from `user_message` events and drops the message entirely if all blocks become empty. That handles the empty-bubble case (user msgs in the JSONL with only `tool_result` content blocks were already filtered to empty by `extract_content_blocks` in parser.rs; we now skip the empty render).

What's NOT covered: the grey blocks in image 1 may have been `tool_result` events, not user messages. `tool_result` is rendered via `.msg.tool-result` (left-aligned, surface bg, success-green left border). If the underlying tool_result text contained slash-command wrapper markup (e.g. SlashCommand tool output that surfaces the command-message text), the cleaner won't reach it.

`chat-renderer.ts::renderMessage` for `tool_result` calls `renderBlocks([m.output])` — so adding a `cleanUserBlocks` pass against `m.output` (or renaming to `cleanContentBlocks` and applying broadly) would cover this.

Files cited:
- `src/shared/chat/chat-renderer.ts:283` (current user_message branch with cleaner)
- `src/shared/chat/chat-renderer.ts:438` (tool_result render path)
- `src/shared/chat/chat-renderer.ts:506` (cleanUserBlocks helper)
- `src-tauri/src/chat/parser.rs::extract_content_blocks` (filters tool_result out of user content; relevant for the empty-bubble half)

## Approach

1. Reproduce: open a session in the chat hub that previously ran a slash command (e.g. `/rate-it`). Inspect a tool_result message in DevTools. Look for raw `<command-name>` text inside `.msg.tool-result`.
2. If reproduced:
   - Rename `cleanUserBlocks` to `cleanContentBlocks` (drop the user-specific name).
   - Apply it in the `tool_result` arm of `renderMessage`.
   - Skip the message render entirely if cleaning yields zero text.
3. If not reproduced:
   - Add a unit test fixture under `src/shared/chat/` capturing what the grey-block content actually was, so the next session avoids guessing.
4. Update the comment block above `COMMAND_TAG_RE` to reflect whichever is true.

## Acceptance

- Either: a slash-command-bearing chat session has zero `<command-*>` tag text rendered in tool_result blocks, OR
- A vitest test fixture proves the grey blocks were never tool_result and the existing user-message cleaner is sufficient.
- No regression on assistant messages (which legitimately contain ` < `, `>` characters in code).
