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
