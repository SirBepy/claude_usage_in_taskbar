# Apply the tool-chip settings filter to in-body tool groups too

## Goal

The "Tool activity chips" setting (Settings > Statusline) hides chosen tool types
(default: AskUserQuestion, TodoWrite) from the STATUSBAR chip row only. Extend the
same hide-list to the CHAT BODY per-type tool groups so a hidden tool also doesn't
render its foldable counter in the message stream.

## Context

This session added per-type tool grouping in the chat body (`groupToolRange` in
`src/shared/chat/turn-collapse.ts`, driven from `chat-renderer.ts` flushRender +
`applyTurnCollapse`) and a settings filter for the statusbar chips
(`tallyHiddenTools` via `loadTallyHiddenTools` in
`src/views/sessions/session-statusbar-helpers.ts`, applied in
`session-statusbar.ts` chip render). The body grouping currently folds EVERY tool
type with no awareness of the hide-list. Joe offered/asked to consider filtering
the body groups too ("say the word if you want the body groups filtered too").

## Approach

- Thread the hidden-tool list into `ChatRenderer` (it has no access today). Options:
  load `loadTallyHiddenTools()` where the renderer is constructed
  (`active-session.ts`, `pending-pane.ts`) and pass it in, mirroring how the
  statusbar receives `tallyHiddenTools`.
- In `groupToolRange`, skip creating/using a group for a tool whose name is in the
  hidden list (leave those rows inline, or drop them - decide with Joe). Keep the
  statusbar behavior identical.
- Add a jsdom test in `tests/chat-renderer-activity.test.mjs`: a hidden tool's
  rows are not folded into a `.tool-group`.

## Acceptance

- A tool in the hide-list shows neither a statusbar chip nor a body group.
- Non-hidden tools group as before. `npx tsc --noEmit` clean, `npx vitest run` green.
