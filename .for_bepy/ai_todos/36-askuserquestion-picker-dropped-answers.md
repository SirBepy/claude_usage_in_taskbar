# AskUserQuestion picker silently drops the user's answers

## Goal

Fix the chat-hub question relay so that when the in-app headless `claude -p` fires an `AskUserQuestion` and the user answers, the answers reach the model instead of "user dismissed the question without answering".

## Status: root cause NOT yet pinned - needs a live log capture (do NOT blind-fix)

Investigated 2026-06-11. A first pass blamed an arg-key mismatch on `respond_question`. **That was wrong** - verified the whole chain is consistent:

- Frontend `invoke("respond_question", { id, answers })` (`src/views/sessions/permission-modal/index.ts:74`)
- -> Tauri cmd `ipc::respond_question(id, answers)` (`src-tauri/src/ipc/chat/lifecycle.rs:331`)
- -> `daemon_client::respond_question` maps `id` -> `request_id` (`src-tauri/src/daemon_client/mod.rs:199-208`)
- -> daemon RPC `respond_question` Body `{ request_id, answers }` (`src-tauri/src/daemon/methods/permission.rs:62`). Keys line up. No bug here.

Also verified the frontend builds a correct, non-empty answers map keyed by question text on submit (`src/views/sessions/permission-modal/question-ui.ts:98-115`). So a real Submit produces non-empty answers and would NOT read as "dismissed".

"Dismissed" is only produced when the answers object is empty/null (`src-tauri/src/daemon/hooks_server/permission.rs:165-167`), which happens on: (a) the 300s oneshot TIMEOUT (card never resolved), (b) onCancel/Skip/Escape posting `{}`, or (c) the card never rendering at all.

## Most likely cause (to confirm with logs)

The `question-requested` event is PARKED or DROPPED by the session gate before it ever shows: `index.ts:137 if (!isForSelectedSession(payload.session_id)) { park/drop; return }`. The hook's `session_id` (claude's own session id, from the PreToolUse body in `hooks_server/permission.rs:125-128`) may not match the frontend's selected-session id, so the card is parked on the row and the daemon oneshot times out -> empty -> "dismissed". This matches the standing "AUQ never surfaces in app chat" behaviour. Candidate alternatives: a session-id representation mismatch (claude vs daemon id), or the event being delivered only via the lossy broadcast and dropped (poll path `list_pending_prompts` should cover it, but verify it surfaces questions, not just permissions).

## What's needed (Joe, live - reuses the ai_todo-16 capture)

Run `cargo tauri dev`, open a chat, trigger an `AskUserQuestion`, then capture: the webview console `[perm-relay]` lines (they log `frontend received question-requested` + `gateDiag()` selected-session id), the daemon log around the `question_request` publish (the `id` + `session_id`), and whether a card actually rendered. Paste back. The logs will say which of (a)/(b)/(c) it is and whether `session_id` matched - then the fix is one-shot (likely: make question parking surface on the row + ensure the poll path replays questions, or fix the id comparison).

## Acceptance

- Answering an in-app `AskUserQuestion` (incl. multi-question) delivers the selected options to the model; it does NOT see "dismissed".
- A regression test at whichever seam the logs implicate (gating/session-match or the poll-replay of questions), not a GUI test.

## Update 2026-06-12 (live observation in an in-app chat)

AUQ now RENDERS and DELIVERS answers in an established (already-selected) session - Joe answered a 4-question and a 2-question picker successfully. So the "always dropped" framing is stale; it is INTERMITTENT. Two distinct failure modes were captured live this session:

1. **`MCP error -32000: Connection closed`** when the AUQ tool was called while the **app window was OFF**. The builtin `AskUserQuestion` is serviced through the app's MCP server (`cc_companion`), so app-off => tool errors immediately. Corrects the old memory that said the relay is purely a PreToolUse curl hook - for the BUILTIN tool there is an MCP path that dies with the app. (App back on => next call worked.)
2. **Expiry / "user did not respond in time"** when Joe was AFK - this is the 300s oneshot timeout firing, NOT a drop. Mitigated 2026-06-12: bumped to 1h via `PROMPT_TIMEOUT_SECS` in `hooks_server/permission.rs` (commit on master). The pending-pane gating race (section above) is still the prime suspect for the brand-new-session case.

## New UX requirements (Joe, 2026-06-12) - make AUQ robust

- **Longer timeout: DONE** (1h, see above).
- **Hide on expire**: when the prompt times out, the question card must be REMOVED from the UI (today it lingers). Daemon should emit a `question-expired { id, session_id }` event on timeout; frontend removes the matching card + clears any sidebar flag.
- **Notify on expire**: fire an OS notification ("A question expired without an answer") when the timeout fires, so Joe knows he missed it. Reuse the `notifications::fire` path (`NotifKind`).
- **Remote-dismiss / cross-device sync**: Joe sometimes answers on his PHONE (remote-control). When answered (or expired) anywhere, the DESKTOP card for that `id` must clear. Needs the daemon to broadcast a `question-resolved { id }` to ALL clients (not just the answering one) + frontend removes the card on receipt. Design Q: which relay carries the phone's answer back, and does it already hit `respond_question`? Confirm before building.

## Acceptance (additions)

- Prompt timeout removes the card AND fires an OS notification.
- Answering on one device (phone) clears the same question card on the desktop.
