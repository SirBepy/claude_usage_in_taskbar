# sessions.ts should be split: extract session-control exports

## Goal
Split `src/views/sessions/sessions.ts` (713 lines) by extracting the session-control API (queue functions + select/assign/close shortcuts) into a separate module.

## Context
`sessions.ts` owns two distinct layers: (1) a large view-mount + event-loop (lines ~170-639, the `mountSessionsView` function and its inner callbacks), and (2) a set of small exported control functions (`queueHistoryResume`, `queueSessionSelect`, `queueNewChat`, `triggerNewSessionGlobal`, `selectSessionByIndex`, `selectSessionBySlot`, `assignCurrentToSlot`, `closeFocusedChat`) that callers in the keyboard/IPC layer invoke. The control functions are short and self-contained; they only touch `state` and call `selectSession`. Mixing them with the 400-line mount block makes both hard to scan.

## Approach
Create `src/views/sessions/session-controls.ts`:
- Move the queue/select/assign/close exports there.
- `sessions.ts` imports and re-exports them for backwards compat with existing callers, or callers update their import site (grep: `from "./sessions"` for these names).
- Verify no circular import: session-controls.ts uses `state`, `selectSession` (from active-session.ts) — neither imports sessions.ts, so the graph stays acyclic.

## Acceptance
- `sessions.ts` drops below 550 lines.
- `session-controls.ts` contains the queue/select/assign/close exports.
- `pnpm tsc --noEmit` passes (only pre-existing vendor error).
- Keyboard shortcuts and IPC callers still compile and work (grep their import sites before and after).
