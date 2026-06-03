# Project-detail "+" new chat should open the chats window, not the main-window route

## Goal
The "+" button on the project-detail RUNNING INSTANCES header currently starts a new-chat draft in the MAIN window's Sessions route. It should open/focus the separate `session-chats` window and start the draft THERE, matching the just-fixed "Open in chats" CTA.

## Context
Chats is a separate OS window (`session-chats`), not a main-window route - see memory `project_chats_separate_window`. The "+" handler in `src/views/project-detail/project-detail.ts` (the `#projectNewChatBtn` onclick) calls `openModelEffortModal` then `queueNewChat(...)` + `showView("sessions")`, which mutates the MAIN window's sessions module and renders the draft in the wrong window. The Open-in-chats CTA was fixed the same session via `open_chats_for_session` (backend command + `AppState.pending_chat_open` drain + `chats-open-session` event); the "+" needs an analogous cross-window handoff for "start a NEW chat with project X + config Y".

## Approach
- Add a backend pending slot like `pending_chat_open` but for a new chat: store `(project_path, model, effort)` (e.g. `pending_new_chat` on `AppState`), plus a command `open_chats_new_chat(project_path, model, effort)` that focuses/creates `session-chats` and stashes the request, and a `take_pending_new_chat` drain.
- Also emit a `chats-new-chat` event for the already-open-window case.
- In `main.ts` chats-window branch, drain `take_pending_new_chat` on boot and listen for `chats-new-chat`; on receipt call `launchNewSession(pane, {path,name}, {model,effort})` against the chats window's pane.
- Keep the model/effort modal in the main window (it overlays `document.body`), pass the resolved config across.
- Update `project-detail.ts` "+" handler to call the new command instead of `queueNewChat`+`showView`.

## Acceptance
- Clicking "+" on a project detail: model/effort modal appears in the main window; after picking, the `session-chats` window opens/focuses and shows a fresh draft for that project (NOT a draft in the main window).
- Works whether the chats window was already open or had to be created.
- `cargo build`, `tsc --noEmit` (no new errors), `vite build`, `vitest run` all green.
