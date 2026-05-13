# Consolidate dismountActivePane with exitSession builtin

## Goal
Drop the duplicate pane-teardown logic between `dismountActivePane` in `src/views/sessions/active-session.ts` and `exitSession` in `src/shared/chat/builtins/exit.ts`. One shared helper.

## Context
Both functions tear down the active session pane the same way:
- Destroy `state.renderer`, `state.statusbar`, `state.composer` and null them.
- Call `setActiveSession(null)`.
- Reset the pane to `<div class="session-empty">Select or create a session</div>`.

`dismountActivePane` (added when wiring the hidden `/close` flow) does one extra step: re-renders the sidebar so the deselected row visually un-highlights. Everything else is byte-for-byte identical.

Files:
- `src/views/sessions/active-session.ts:25-41`
- `src/shared/chat/builtins/exit.ts`

## Approach
1. Move the shared teardown into one helper, e.g. `dismountActivePane({ rerenderSidebar?: boolean })` exported from `src/views/sessions/active-session.ts` (or a sibling `pane-lifecycle.ts` if you prefer keeping `active-session.ts` lean).
2. `exitSession` becomes a one-liner that calls the helper with `rerenderSidebar: false` (current behavior — exit builtin doesn't touch the sidebar).
3. `/close`-background path keeps calling it with `rerenderSidebar: true`.
4. Delete the inline duplicate from `exit.ts`.
5. `npx tsc --noEmit` clean.

## Acceptance
- Only one definition of the pane-teardown sequence in the repo.
- Both call sites (`/exit` builtin and hidden `/close`) work as before.
- No regression in detached-window flow (which also relies on pane teardown).
