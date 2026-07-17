// Throttled flush scheduling for ChatRenderer's live render path, split out
// of chat-dom-renderer.ts (ai_todo 195) - a self-contained timing/coalescing
// concern that only ever touches `r._flushTimer` and calls flushRender.

import { flushRender } from "./chat-dom-renderer";
import type { ChatRenderer } from "./chat-renderer";

/** Trailing-edge-with-immediate-leading throttle window for scheduleFlush. */
const FLUSH_THROTTLE_MS = 80;

/**
 * Throttled entry point for the live per-event render path (ai_todo
 * streaming-render O(n^2) fix, Fix 2). Every content_block_delta used to
 * call flushRender() directly - one full render pass per token. This
 * coalesces a burst of events into at most one flush per ~80ms window: the
 * first event in a burst still renders immediately (so typing/tool-card feel
 * stays instant), and any events that land inside an already-open window
 * mark their state (messages/dirtyIndices, done by the caller before this
 * runs) and ride the single trailing flush at the end of the window instead
 * of each triggering their own.
 *
 * Uses setTimeout, not requestAnimationFrame: rAF callbacks are paused while
 * the hosting WebView2 window is hidden/backgrounded (a chat pane not
 * currently focused), so an rAF-only trailing flush could stall indefinitely.
 * setTimeout keeps firing regardless, so the transcript never gets stuck
 * behind a stale throttle window.
 *
 * `afterFlush`, if given, runs synchronously right after flushRender - both
 * for the immediate leading-edge render AND for the eventual trailing one -
 * so a caller doing e.g. a `wasAtBottom`-gated scrollToBottom always reads a
 * FRESH scrollHeight (the DOM update that grew it just ran), never a stale
 * one from before a throttled/swallowed call. Events swallowed by an
 * already-open window don't run their own `afterFlush`; the leading event's
 * decision (rarely stale across one ~80ms window) governs the burst.
 */
export function scheduleFlush(r: ChatRenderer, afterFlush?: () => void): void {
  if (r._flushTimer !== null) return; // window already open; trailing flush below will pick this up
  flushRender(r);
  afterFlush?.();
  r._flushTimer = setTimeout(() => {
    r._flushTimer = null;
    flushRender(r);
    afterFlush?.();
  }, FLUSH_THROTTLE_MS);
}

/**
 * Force an immediate flush and cancel any pending trailing timer, so a
 * turn-end/settle event (e.g. turn_usage landing) is never delayed behind
 * scheduleFlush's throttle window.
 */
export function flushRenderNow(r: ChatRenderer): void {
  if (r._flushTimer !== null) {
    clearTimeout(r._flushTimer);
    r._flushTimer = null;
  }
  flushRender(r);
}
