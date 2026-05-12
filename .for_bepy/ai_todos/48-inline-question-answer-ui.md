# Nice inline UI for Claude question + multi-choice answer

## Goal

When Claude (running inside our Sessions chat) calls `AskUserQuestion` or any equivalent "pick one of these options" flow, render a clean inline question card with clickable choices and an "Other" free-text input. Joe picks an option → answer routes back to Claude. Should feel like a first-class chat affordance, not a fallback alert.

## Context

Already partially wired on the backend:
- `src-tauri/src/mcp/server.rs` exposes `ask_user_question` MCP tool that POSTs to `/questions/request`.
- `src-tauri/src/hooks/server.rs` has `/questions/request` + `/questions/respond` endpoints with a pending oneshot map.
- `src/views/sessions/permission-modal.ts` already listens for `question-requested` Tauri events and shows a modal (interactive). The inline chat renderer ALSO renders the `tool_use` for `AskUserQuestion` in read-only mode (see `chat-renderer.ts` + the existing `.ask-user-question` CSS).

Gap: the inline rendering is read-only display. The actual answering UX is a modal popup that interrupts flow. Joe wants the inline card itself to be interactive, matching the rest of the chat aesthetic.

Joe also reported the harness-side `AskUserQuestion` tool throws "Invalid input: expected record" intermittently — that's a separate harness/SDK issue; not in scope for this todo, but worth noting because if our inline UI relies on that schema, mirror its shape carefully.

## Approach

1. Extend the inline `AskUserQuestion` block in `chat-renderer.ts`:
   - Replace static option list with clickable buttons (one per option).
   - Add an "Other..." button that swaps the card into a textarea + submit.
   - Disable buttons after selection; show "You answered: <label>" inline.
2. On click → call `respond_question` IPC (already exists), passing the question id + chosen label / freetext.
3. Cleanup: when `question-requested` modal would have fired, suppress it if the inline card has handled the response. Modal becomes the fallback (detached window, popup permission-style cases).
4. Styling: match `.msg.tool-use` / `.card-block` look. Phosphor icons for each option. Hover state. Match the link styling we just added (`var(--primary)` border-bottom hover bg).

Existing references:
- `src/views/sessions/permission-modal.ts` — current modal flow + IPC plumbing.
- `src/shared/chat/chat-renderer.ts` — `.ask-user-question` read-only renderer (search for "AskUserQuestion" or "ask-user-question").
- `src-tauri/src/ipc/chat.rs::respond_question` — the IPC to call when an option is picked.

## Acceptance

- Claude calls AskUserQuestion → inline card appears in chat with clickable options + Other field.
- Clicking an option fires `respond_question` and immediately disables further interaction on that card.
- "Other..." opens an inline text input that submits via the same IPC.
- Modal popup no longer appears when the inline card handles the answer (modal kept as fallback for detached windows).
- Works in main window AND detached single-session window (`renderDetachedSession`).
- Must not regress permission-prompt modal (different event: `permission-requested`).
- Verify by triggering a tool from Claude in chat: should see the new inline UI, click a choice, see Claude continue with that answer.
