# chat-dom-renderer.ts crossed 400 lines: extract the flush scheduler

## Goal
Move the new throttle-scheduler concern out of chat-dom-renderer.ts (455 lines) into its own module.

## Context
The 2026-07-09 perf pass (commit c54a1ffd) added `scheduleFlush`/`flushRenderNow`/`FLUSH_THROTTLE_MS` (src/shared/chat/chat-dom-renderer.ts:106-155), a self-contained timing/coalescing concern (touches only `r._flushTimer` + calls `flushRender`), to a file already mixing turn-close queueing, reveal/hold, scroll-to-bottom, and message building. File grew 385 -> 455 lines.

## Approach
New `src/shared/chat/flush-scheduler.ts` exporting scheduleFlush/flushRenderNow, importing flushRender. Update chat-event-handler.ts imports. Keep `_flushTimer` cleanup in ChatRenderer.detach() working (see chat-renderer.ts).

## Acceptance
`pnpm exec tsc --noEmit` clean; vitest suite green (tool-chip tests assert synchronous render for non-delta events - must not regress); streaming throttle behavior unchanged (leading immediate + 80ms trailing).
