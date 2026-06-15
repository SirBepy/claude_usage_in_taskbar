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

## Investigation (autopilot 2026-06-15) - PARKED, needs live repro

Traced the code; both symptoms hinge on RUNTIME state that can't be reproduced
without the live app + real transcript data, so I did NOT ship a speculative fix
(shipping an unverified UI precedence change risks suppressing real busy, which
the acceptance explicitly forbids). What I confirmed, so the next pass starts ahead:

- **Precedence (symptom 1) lives in `sessions-helpers.ts:119-171`.** BOTH
  `statusDotClass` (line 127) and `statusIndicator` (line 159) rank `i.busy`
  ABOVE `question` (line 128 / 162). So whenever `i.busy` is true for a
  question session, the spinner wins. `statusIndicator`'s `isQuestion` is
  `!needsAttention && !isExternal && !i.busy && question.has(id)` (line 144) -
  i.e. busy hard-suppresses question. NOTE: the sidebar uses the Instance's
  `i.busy` (backend), NOT `isCurrentSessionBusy()`. So the open question is WHY
  `i.busy` becomes true on click - needs a live trace (does selecting a session
  cause the backend to report busy, or is there a transient busy on attach?).
  A candidate fix once confirmed: let question win when `question.has(id)` and
  the session is not genuinely mid-turn - but "genuinely mid-turn" must be
  defined from a real signal, not guessed, or it'll suppress true busy.

- **Symptom 2 is NOT a missing-re-derivation bug (hypothesis falsified).**
  `attach()` (chat-renderer.ts:171) DOES replay history through `handleEvent`
  (lines 204/361), which calls `setTurnStatus(detectStatusToken(blocksToText(ev.content)))`
  for every non-streaming assistant message (line 518). `detectStatusToken`
  reads the RAW content; the marker is only stripped at render time
  (`stripStatusToken`, chat-transforms.ts:87), so the in-memory event keeps it.
  And `state.renderer = renderer` is set at active-session.ts:258 BEFORE
  `await renderer.attach()` at :303, so the `if (state.renderer !== renderer) return`
  guard in `onStatusUpdate` (:292) passes during replay. So re-attach SHOULD
  re-add to `questionSessions`. Therefore the real cause is one of: (a) the
  persisted transcript does NOT actually contain the `<cc-status:question>`
  marker on the last assistant line (only the live stream does) - VERIFY by
  grepping the session's ~/.claude/projects/*/<sid>.jsonl for `cc-status`;
  (b) something clears `questionSessions` on view teardown/switch; or
  (c) the sidebar re-renders BEFORE `onStatusUpdate` fires during the async
  attach, and isn't re-rendered after. Each needs the live app to confirm.

NEXT STEP (live): open a chat that ended on a question, then (1) grep its
transcript jsonl for `cc-status:question` to settle hypothesis (a), and
(2) add a temporary console.log in `onStatusUpdate` + `statusDotClass` to watch
the precedence + set membership on click and on switch-back.

## Acceptance

- Session in question state shows the question icon in the sidebar; clicking into that chat keeps the question icon (no flip to the working spinner) as long as no turn is actually running.
- Navigate to another chat and back — the question icon is still there.
- A genuinely busy session (turn in flight) still shows the working/thinking indicator correctly; this fix must not suppress the real busy state.
- When the user sends the next message, the question status clears as before.
- `pnpm tsc --noEmit` clean.
