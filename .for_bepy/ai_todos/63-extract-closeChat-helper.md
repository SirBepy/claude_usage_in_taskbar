# Extract closeChat helper for the busy-confirm + clear_session pattern

## Goal
Replace the four near-identical "close this chat" handlers with a single helper.

## Context
The same handler shape is duplicated in four places after the close-button rework:

1. `src/views/sessions/active-session.ts` — close-session-btn click handler (interactive sessions).
2. `src/views/sessions/pending-flow.ts` — close-session-btn handler in the initial pending pane render.
3. `src/views/sessions/pending-flow.ts` — close-session-btn rebind inside `rebindPaneHeader` after `start_session` resolves.
4. `src/views/sessions/sidebar.ts` — ctx-menu "Close chat" item.

Each one does:
```ts
const sess = state.sessions.find(s => s.session_id === id);
if (sess?.busy) {
  if (!confirm("A turn is in progress. Close and discard it?")) return;
  try { await invoke("cancel_turn", { sessionId: id }); } catch {}
}
try { await invoke("clear_session", { sessionId: id }); } catch (err) { ... }
```

Only callsite-2 has a wrinkle: it uses `realId || placeholderId` so the pre-resolution pending session can also be closed.

## Approach
1. Add `closeChat(sessionId: string, opts?: { skipBusyConfirm?: boolean }): Promise<void>` to `src/views/sessions/sessions-helpers.ts` (or a new `close-chat.ts` in the same folder).
2. Helper handles: busy lookup, confirm prompt, optional cancel_turn, clear_session, error logging.
3. Update all four sites to call the helper.
4. For callsite-2, compute the target id (`realId || placeholderId`) at the callsite and pass it in.
5. `npx tsc --noEmit` clean.

## Acceptance
- One implementation of close-chat semantics.
- All four UI entry points still work: header X on interactive session, header X on new/pending session, sidebar 3-dot menu, X after pending-resolution rebind.
- Busy-confirm still fires when there is an active turn.
- `npx tsc --noEmit` clean.
