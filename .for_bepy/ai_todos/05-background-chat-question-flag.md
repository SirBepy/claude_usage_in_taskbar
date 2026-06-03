# Show the question flag on background chats too

## Goal
Make the amber "Claude asked a question" sidebar flag appear for chats the user has NOT opened this session, not just the active/opened one.

## Context
The turn-status feature (commit 8a73e1a, see memory `project_turn_status_marker`) is frontend-only: status is captured by the active session's `ChatRenderer.onStatusUpdate` and stored in `state.questionSessions` (in `src/views/sessions/state.ts`). A session that has never been opened has no mounted renderer, so it never reports a status — it falls back to the existing unread check. Joe was told this limitation and may want it lifted.

## Approach
Move the status to the backend so every session carries it regardless of an open pane:
- Strip + detect `<cc-status:..>` in `src-tauri/src/chat/parser.rs` (both the live `result` path and the history `assistant` path) instead of (or in addition to) the frontend strip.
- Add an `awaiting: Option<"done"|"question">` field to the `Instance` type; set it on turn-end where `busy` is cleared. Regenerate `ipc.generated.ts` via `export_types.rs` (see memory `project_ipc_generated_source_of_truth`, `project_cargo_target_dir_for_locked_exe`).
- Sidebar reads `i.awaiting` directly instead of `state.questionSessions`.

## Acceptance
A background (never-opened) chat that ends a turn with `<cc-status:question>` shows the amber flag in the sidebar and sorts up, without the user opening it first.
