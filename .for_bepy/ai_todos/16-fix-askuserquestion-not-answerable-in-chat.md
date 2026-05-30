# AskUserQuestion prompts never become answerable in the Sessions chat

## Goal

When the in-app `claude -p` session calls the builtin `AskUserQuestion` tool, the Sessions chat must render an answerable question card and feed the chosen option back to the running turn. Today the question never surfaces (or surfaces but can't be answered), so the turn just sits until the tool times out.

## Context

Observed live on 2026-05-30: the agent emitted two `AskUserQuestion` calls in a row; both came back to the agent as `user did not respond in time` with no card ever appearing for Joe. So either the prompt isn't reaching the UI, or it renders but the answer never posts back.

AskUserQuestion is a Claude Code **builtin** tool, not the MCP `ask_user_question`. In headless `claude -p` it's surfaced through the permission relay (`canUseTool`), then detected and rendered as a question (not a plain allow/deny). Relevant flow:

- `src-tauri/src/mcp/server.rs` and `src-tauri/src/ipc/chat/lifecycle.rs` - permission/question relay surface.
- `src/views/sessions/permission-modal/gating.ts` - `extractQuestions(payload.input)` decides a permission-request is actually an AskUserQuestion; `isForSelectedSession()` gates whether the event is shown or parked/dropped. A bad gate here would silently drop the prompt (see `gateDiag()` logging at the drop site).
- `src/views/sessions/permission-modal/question-ui.ts` - builds the answerable card and the respond path.
- `src/views/sessions/permission-modal/permission-card.ts`, `index.ts` - mount + wiring.
- `src/views/sessions/active-session.ts` - where permission/question events are received for the active pane.
- Memory `project_mcp_permission_prompt_shape`: AskUserQuestion answers in headless `-p` must go back via the deny+message channel (allow needs `updatedInput`, deny needs `message`). If the respond shape is wrong the agent treats it as no-answer.

Deferred because confirming the exact break needs a live billed turn (or the e2e seam), not static reading.

## Approach

1. Repro with the synthetic seam first (memory `project_e2e_synthetic_seams`) or a single cheap live turn that calls AskUserQuestion. Watch the webview console for the `gateDiag()` drop log and any `[perm-...]` warnings.
2. Bisect: (a) does the `question-requested` / permission event reach the frontend at all? (b) does `extractQuestions` classify it as a question? (c) does `isForSelectedSession` return true for the active chat? (d) does the card render? (e) does answering post the response in the shape the daemon's parked oneshot expects?
3. Fix the first broken hop. Most likely suspects: a gate dropping the event for the selected session, or the respond payload shape not matching what `respond_question`/`respond_permission` expects for a builtin AskUserQuestion.

## Acceptance

- A live (or seam-driven) `AskUserQuestion` call renders an answerable card in the active Sessions chat.
- Selecting an option resolves the agent's tool call with that answer (no timeout), and multi-select / "Other" free-text both round-trip.
- Must NOT regress: normal allow/deny permission cards, parked prompts for switched-away chats, and per-session auto-accept (`gating.ts`).
- Verify by driving the real flow (WebdriverIO e2e per memory `feedback_ui_bug_regression_drives_ui`), not just a unit test.
