# Question status icon lost when opening or switching chats

## Goal

A session in the "question" state (Claude asked the user something, `<cc-status:question>` marker) must keep showing its question icon in the sidebar even after the user clicks into that chat or navigates away and back. Today the question state is fragile and gets clobbered by interaction.

## Context

Two reported symptoms, same area (sidebar question-status handling):

1. **Click clobbers the icon.** When a session is in the question state the sidebar shows the correct question icon for the user. As soon as Joe clicks into that chat, the icon flips to the "working/thinking" spinner (spinning green indicator) instead of staying as the question icon. Likely the act of selecting/opening the session marks it busy (or `isCurrentSessionBusy()` returns true on open), and the busy/working state takes precedence over the question state in the sidebar render.

2. **Switching away drops the state entirely.** Navigate to another chat, then back to this one, and the question state is gone (no question icon at all). The `questionSessions` state is probably recomputed from live render state on view switch and not re-derived from the persisted `<cc-status:question>` marker, so it's lost when the renderer is torn down / rebuilt.

Relevant memory (turn-status marker):
- `project_turn_status_marker.md` — chat sidebar done/question state comes from a `<cc-status:..>` marker injected via `--append-system-prompt`, stripped in chat-transforms, surfaced via `state.questionSessions`; red is permission-only now.

Key files to investigate:
- `src/views/sessions/sidebar.ts` — sidebar icon render; precedence between busy/working state and question state lives here.
- `src/views/sessions/state.ts` — `questionSessions` set; how it's populated and cleared.
- `src/shared/chat/chat-transforms.ts` — where the `<cc-status:..>` marker is stripped and the status is detected (`detectStatusToken`).
- `src/views/sessions/sessions.ts` — `isCurrentSessionBusy()` / `updateThinkingBar()` (the working bar logic that may be overriding the question icon on open).
- `src/shared/chat/chat-renderer.ts:346-348` — `setTurnStatus(detectStatusToken(joined))` on the final assistant message.

## Approach

1. Reproduce symptom 1: trace what changes when a session is selected/opened — does opening flip a busy flag or clear `questionSessions`? Establish the precedence rule in `sidebar.ts`: a known question status should win over the working/spinner icon when the session is NOT actually mid-turn.
2. Distinguish "actually busy" (a turn is in flight) from "selected/open but idle in question state". The open action alone must not set busy.
3. Reproduce symptom 2: confirm `questionSessions` is dropped on view switch. Make the question status derive from the persisted marker (re-detected on re-render) rather than only from transient live state, so returning to the chat re-surfaces it.
4. Decide where question status should be the source of truth so both the sidebar and any re-entry path read the same value (persist per-session, keyed by session id, cleared when the next user turn starts — same point `user_message` calls `setTurnStatus(null)`).

## Acceptance

- Session in question state shows the question icon in the sidebar; clicking into that chat keeps the question icon (no flip to the working spinner) as long as no turn is actually running.
- Navigate to another chat and back — the question icon is still there.
- A genuinely busy session (turn in flight) still shows the working/thinking indicator correctly; this fix must not suppress the real busy state.
- When the user sends the next message, the question status clears as before.
- `pnpm tsc --noEmit` clean.
