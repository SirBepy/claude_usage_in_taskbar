// /close lifecycle driver. Replaces guessing "this turn is a /close" from the
// user's typed text (which used to false-fire on any message containing the
// substring "/close" anywhere, e.g. "//close" in prose, and marked the row
// "closing" before the skill had even started). The skill itself now emits
// two sentinels (see ~/.claude/skills/close/SKILL.md):
//   <cc-close:starting> - the literal first thing the skill outputs, once it
//                          is genuinely running.
//   <cc-close:done>     - emitted right before Phase 6 kills the terminal,
//                          ONLY when Phase 6 actually proceeds (never on
//                          `--dont-close`, a failed chained command, or
//                          active background work).
//
// watchCloseLifecycle runs every sent turn through three states:
//   waiting -> no <cc-close:starting> seen yet. If the turn settles here
//              (turn_usage/session_ended) without ever seeing it, this was
//              never a real /close invocation - quietly do nothing.
//   running -> <cc-close:starting> seen. onStarting() fires (mark the row
//              "closing"). Settling now races the live event against an
//              authoritative registry poll, same drop-proofing as before
//              (the daemon->app notifier is lossy under backpressure - see
//              project_daemon_notifier_broadcast_lossy).
//   settled -> the turn ended. finalize() fires if <cc-close:done> was seen
//              (the terminal really is closing) - otherwise onStandDown()
//              fires (e.g. --dont-close: revert the row to normal, don't
//              tear the chat down).
// Either way `settled` is terminal: callbacks fire exactly once.

import type { ChatEvent } from "../../types/ipc.generated";
import { blocksToText } from "../../shared/chat/content-blocks";
import { detectCloseStartToken, detectCloseDoneToken } from "../../shared/chat/chat-transforms";

export interface CloseLifecycleOpts {
  /** Subscribe to the session's live events; returns an unsubscribe fn. */
  subscribe: (onEvent: (ev: ChatEvent) => void) => () => void;
  /**
   * Authoritative fallback, polled only once `onStarting` has fired: whether
   * the running turn has settled. "settled" once the turn has completed (or
   * the session is already gone); "running" while still in flight.
   * Independent of the lossy live channel, so a dropped turn_usage can no
   * longer hang the close.
   */
  pollSettled: () => Promise<"settled" | "running">;
  /** <cc-close:starting> was seen - promote the row to "closing". */
  onStarting: () => void;
  /** The turn settled without <cc-close:done> - revert to normal, no teardown. */
  onStandDown: () => void;
  /** <cc-close:done> was seen and the turn settled - tear the session down. */
  finalize: () => void;
  /** Fallback poll interval in ms. Default 2500. */
  pollMs?: number;
}

/**
 * Drives a sent turn through the close lifecycle described above. Returns a
 * cancel function (e.g. for a send_message failure before any reply arrived -
 * nothing was promoted, so this is a clean no-op). Idempotent: at most one of
 * onStarting -> {finalize, onStandDown} fires.
 */
export function watchCloseLifecycle(opts: CloseLifecycleOpts): () => void {
  const pollMs = opts.pollMs ?? 2500;
  let stage: "waiting" | "running" | "settled" = "waiting";
  let sawDone = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsub: (() => void) | null = null;

  const cleanup = (): void => {
    if (unsub) {
      try { unsub(); } catch { /* ignore */ }
      unsub = null;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const settle = (): void => {
    if (stage === "settled") return;
    stage = "settled";
    cleanup();
    if (sawDone) opts.finalize();
    else opts.onStandDown();
  };

  const tick = async (): Promise<void> => {
    if (stage !== "running") return;
    let settled = false;
    try { settled = (await opts.pollSettled()) === "settled"; } catch { /* tolerate transient IPC errors */ }
    if (stage !== "running") return;
    if (settled) { settle(); return; }
    timer = setTimeout(() => { void tick(); }, pollMs);
  };

  unsub = opts.subscribe((ev) => {
    if (ev.type === "assistant_message") {
      const text = blocksToText(ev.content);
      if (stage === "waiting" && detectCloseStartToken(text)) {
        stage = "running";
        opts.onStarting();
        timer = setTimeout(() => { void tick(); }, pollMs);
      }
      if (stage === "running" && detectCloseDoneToken(text)) sawDone = true;
      return;
    }
    if (ev.type === "turn_usage" || ev.type === "session_ended") {
      if (stage === "waiting") { cleanup(); return; } // never a real /close - nothing to settle
      settle();
    }
  });

  return () => {
    if (stage === "waiting") { cleanup(); return; }
    settle();
  };
}
