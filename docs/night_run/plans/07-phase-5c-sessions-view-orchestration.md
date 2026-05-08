# Phase 5c - sessions-view.js orchestration

## Context

Implements Task 5.4 of `docs/superpowers/plans/2026-05-07-claude-chat-hub.md`. Depends on Phases 4 (IPC commands) + 5a (HTML/CSS) + 5b (renderer + composer). Read "Task 5.4: Implement sessions-view.js (orchestration)" in the parent plan.

## Goal

Create `src/modules/sessions-view.js` exporting `activate()` and `deactivate()`. Wires the sidebar list, the +New button, the filter input, the chat pane, the renderer, the composer.

## Implementation

Use the parent plan's Task 5.4 Step 1 code as the starting point. Apply Path C-specific changes already incorporated in the parent plan:

- New session: prompt the user for the first message (browser `prompt()` is fine for v1), call `invoke('start_session', { cwd: project.cwd, prompt: firstPrompt })` instead of `spawn_interactive_session`.
- Send: `invoke('send_message', { sessionId, cwd: sess?.cwd ?? '.', blocks })`.
- Kill button -> `invoke('cancel_turn', { sessionId })` (cancels in-flight turn only; doesn't remove from sidebar).
- Take over button -> `invoke('takeover_manual', { manualPid: sess.pid })` (the command exists in Phase 7; if it doesn't yet, the call will reject - acceptable for night-run mid-execution since Phase 7 follows).

Wire the dashboard.js router to dispatch `activate` when `view-sessions` becomes visible and `deactivate` when it hides. Match the existing router lifecycle pattern.

The `pickProject` helper uses `invoke('list_project_groups')` (existing IPC, returns `ProjectGroup[]`). Use the simple `prompt()` picker for v1; a proper modal can come later.

Update `src/dashboard.js` router so:
- Switching to `view-sessions` calls `import('./modules/sessions-view.js').then(m => m.activate())`.
- Switching away from `view-sessions` calls `m.deactivate()` to unsubscribe from `instances-changed`.

## Gotchas

- `instances-changed` is the existing Tauri event for registry mutations. The sidebar listens to it for live updates.
- Filter active sessions only (no `manual` or `automated` or `remote` AND `!ended`) - look at `InstanceKind` enum keys: `interactive`, `manual`, `automated`, `external` (not `remote` - the actual variant in this repo is `external`). Adapt the filter accordingly.
- `IceCheckListener` style: hold the `unlistenInstances` returned by `listen(...)` and call it on deactivate.
- The chat renderer needs `loadHistory(events)` after attach. Phase 8a adds the `load_history` IPC; for this phase, call it in a try/catch so missing IPC doesn't blow up:
  ```js
  try {
    const history = await invoke('load_history', { sessionId });
    state.renderer.loadHistory(history);
  } catch { /* phase 8 not in yet */ }
  ```

## Verification

- `cargo build -p claude-usage-tauri` clean.
- 174 lib tests still pass.
- Read the file to confirm:
  - `activate` and `deactivate` are exported.
  - All button handlers wire through `invoke`.
  - `instances-changed` subscription is set up and torn down.
  - Filter input dispatches re-render.

## Don't

- Don't commit.
- Don't add a custom modal for project picking; `prompt()` is the v1 placeholder.
- Don't add detach window logic yet (Phase 9).

## Acceptance

- `src/modules/sessions-view.js` exists, syntactically valid, exports `activate`/`deactivate`.
- `src/dashboard.js` router calls activate/deactivate at view transitions.
- 174 lib tests still pass.
