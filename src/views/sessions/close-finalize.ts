// /close teardown driver. The /close skill runs a background turn; the chat
// must tear down only AFTER that turn finishes. Previously teardown waited
// solely on the `turn_usage` / `session_ended` live event, but that event rides
// the lossy daemon->app notifier (see project_daemon_notifier_broadcast_lossy)
// and can be dropped - leaving the chat stuck in the red "closing" state forever
// and never actually closing. This races the fast event path against an
// authoritative registry poll so teardown ALWAYS fires once the turn settles.

import type { ChatEvent } from "../../types/ipc.generated";

export interface CloseFinalizeOpts {
  /** Subscribe to the session's live events; returns an unsubscribe fn. */
  subscribe: (onEvent: (ev: ChatEvent) => void) => () => void;
  /**
   * Authoritative fallback: poll the registry for whether the /close turn has
   * settled. "settled" once the turn has run and completed (or the session is
   * already gone); "running" while still in flight. Independent of the lossy
   * live channel, so a dropped turn_usage can no longer hang the close.
   */
  pollSettled: () => Promise<"settled" | "running">;
  /** Tear down the session (clear_session + UI). Invoked exactly once. */
  finalize: () => void;
  /** Fallback poll interval in ms. Default 2500. */
  pollMs?: number;
}

/**
 * Finalize /close teardown as soon as EITHER the turn-complete event arrives
 * (fast path) OR the registry poll reports the turn settled (drop-proof
 * fallback). `finalize()` runs exactly once regardless of how many signals
 * fire. Returns a trigger that forces immediate finalization (used when the
 * send itself errors). Caller is responsible for not invoking the trigger after
 * teardown is otherwise complete - it is idempotent either way.
 */
export function awaitCloseThenFinalize(opts: CloseFinalizeOpts): () => void {
  const pollMs = opts.pollMs ?? 2500;
  let done = false;
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

  const finish = (): void => {
    if (done) return;
    done = true;
    cleanup();
    opts.finalize();
  };

  unsub = opts.subscribe((ev) => {
    if (ev.type === "turn_usage" || ev.type === "session_ended") finish();
  });

  const tick = async (): Promise<void> => {
    if (done) return;
    let settled = false;
    try { settled = (await opts.pollSettled()) === "settled"; } catch { /* tolerate transient IPC errors */ }
    if (done) return;
    if (settled) { finish(); return; }
    timer = setTimeout(() => { void tick(); }, pollMs);
  };
  timer = setTimeout(() => { void tick(); }, pollMs);

  return finish;
}
