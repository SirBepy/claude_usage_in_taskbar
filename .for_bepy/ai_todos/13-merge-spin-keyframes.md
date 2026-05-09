# Merge duplicate spin keyframes in sessions.css

## Goal

One canonical `@keyframes` for spinner rotations; remove the duplicate.

## Context

`src/views/sessions/sessions.css` currently defines two identical 360deg-rotation keyframes:

- `@keyframes session-spin` (line ~155, used by `.session-state-icon.spinning`)
- `@keyframes chat-top-spin` (added in chat history pagination, used by `.chat-top-spinner` and `.chat-loading-overlay .chat-loading-ring`)

Both are `to { transform: rotate(360deg); }` with the same duration / timing. No behavioral difference.

## Approach

Pick a generic name, e.g. `spin`, in a shared CSS file (or keep in sessions.css but rename one to match the other). Update all three consumers. Delete the duplicate keyframe. If a global `app.css` or shared module exists, prefer moving `@keyframes spin` there so dashboard / projects / future views can reuse it without re-defining.

## Acceptance

- `grep -n "@keyframes" src/` shows one spin keyframe in the chat/sessions area.
- Visual: both the session sidebar spinning state icon and the chat top-sentinel / loading-overlay spinners still rotate at the same speed.
