# Split src/views/sessions/sessions.ts into focused submodules

## Goal

`src/views/sessions/sessions.ts` is now **1376 lines** (after sessions UI redesign — two-line rows, unread tracking, sort dropdown, 3-dot context menu — plus earlier bug-fix and modal upgrades). Single file holds: state shape, sidebar render, project picker modal (with search/sort/persistence/keyboard nav), pending-session flow with placeholder/swap mechanism, `selectSession` orchestration, detached-window entry point, header rebinding helper, statusbar wiring (new). Split for readability + future-Claude reasoning.

## Context

Pre-conditions: this only matters if the chat-hub stays alive (it will - billing fear cleared, `ai_todos/07` retired). `ai_todos/08` already targets a Rust-side analog (`ipc/chat.rs` split + `escapeHtml` dedupe across three TS files); this is the parallel TS-side cleanup.

Current concerns mixed in `sessions.ts`:
1. **State + sidebar** (~150 lines): `SessionsState`, `state` singleton, `renderSidebar`, `isLive`. (Note: `statusClass`/`sessionTitle` removed in redesign - replaced by `sessions-helpers.ts` exports.)
2. **Project picker modal** (~280 lines): `pickProject`, `openProjectPickerModal`, `ensureModalHost`, `closeModal`, sort persistence helpers, keyboard nav.
3. **Pending-session flow** (~220 lines): `startNewSession`, `renderPendingPane`, `makePlaceholderId`, `rebindPaneHeader`, the placeholder/swap-subscription wiring.
4. **Active-session orchestration** (~200 lines): `selectSession`, including read-only banner + cwd-aware load_history.
5. **View lifecycle** (~150 lines): `renderSessionsView`, `template`, teardown closure.
6. **Detached-window entry** (~80 lines): `renderDetachedSession`, `detachedTemplate`.
7. **Statusbar** (~recent additions, see Joe's working tree): `SessionStatusbar` import, wiring.
8. **Shared util**: `escapeHtml` (also duplicated in `history.ts` and `chat-renderer.ts` per ai_todo 08).

## Approach

Extract into a folder structure:

```
src/views/sessions/
  sessions.ts           // public entry: renderSessionsView + renderDetachedSession + module shared state singleton
  state.ts              // SessionsState interface + state singleton + nextMountId
  sidebar.ts            // renderSidebar, isLive, statusClass, sessionTitle
  project-picker.ts     // pickProject, openProjectPickerModal, sort persistence, keyboard nav, modal host helpers
  pending-flow.ts       // startNewSession, renderPendingPane, makePlaceholderId, rebindPaneHeader
  active-session.ts     // selectSession (including readonly + cwd-aware load_history)
  template.ts           // template() + detachedTemplate() + the lit-html shells
  sessions.css          // unchanged
```

Plus the parallel `escapeHtml` extraction from ai_todo 08:
- `src/shared/escape-html.ts` exports a single function consumed by sessions/sidebar.ts, sessions/active-session.ts, history.ts, chat-renderer.ts.

Statusbar piece (Joe's incoming `SessionStatusbar` from `chat-renderer.ts` import) stays in `chat-renderer.ts` for now since it's wired by both Sessions view and detached window; revisit if it grows.

State sharing: keep `state` as a module-level singleton EXPORTED from `state.ts`. Every other submodule imports from it. Tests for the submodules are easier when state is centralized.

**Order of extraction (smallest blast radius first):**

1. Pull `escapeHtml` to `src/shared/escape-html.ts`. Update three callers (sessions.ts, history.ts, chat-renderer.ts). Run vitest + tsc. Commit via /commit.
2. Pull `template()` + `detachedTemplate()` to `template.ts`. Re-export from sessions.ts. Commit.
3. Pull sidebar concerns to `sidebar.ts`. State import only. Commit.
4. Pull project-picker concerns to `project-picker.ts`. Heavy block; review the keyboard-nav state carefully. Commit.
5. Pull pending-flow to `pending-flow.ts`. The placeholder/swap-subscription is subtle - keep test coverage by manually firing `+ New` after the move. Commit.
6. Pull active-session to `active-session.ts`. Includes the read-only banner, cwd-aware load_history. Commit.

Each step: pnpm tsc, pnpm vite build, manual `cargo tauri dev` smoke test (open Sessions view → +New → send a message → click another row → click back). Don't batch - one logical extraction per commit makes future review tractable.

## Acceptance

- `sessions.ts` is under 200 lines (just renderSessionsView + renderDetachedSession + the lifecycle teardown closure; everything else is imported).
- No file in `src/views/sessions/` exceeds 350 lines.
- `pnpm tsc --noEmit` shows the same 2 pre-existing errors as before (chat-renderer.ts:122, ipc.generated.ts:31), no new errors.
- 30+ vitest passes.
- 207+ cargo tests pass (no Rust changes; this is pure TS reorg).
- Manual smoke: `+ New` → modal → pick → type → send works end-to-end. External row click loads transcript. Detached window still works. Read-only banner still shows for external sessions. Keyboard nav in modal still works (arrows, Enter, Home/End, Esc).
- `escapeHtml` defined exactly once in `src/shared/escape-html.ts`; the three prior copies are gone.
