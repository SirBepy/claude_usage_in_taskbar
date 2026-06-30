// Guards the /close teardown lifecycle. The recurring bug: a chat sent /close,
// the skill ran and finished, but the chat never actually closed - it sat in the
// red "closing" state forever. Root cause: teardown waited solely on the live
// turn_usage event, which rides the lossy daemon->app notifier and can be
// dropped. awaitCloseThenFinalize adds an authoritative registry-poll fallback
// so close ALWAYS completes. These tests pin both paths.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { awaitCloseThenFinalize } = await import("../src/views/sessions/close-finalize.ts");

function makeSub() {
  let cb = null;
  let unsubbed = false;
  return {
    subscribe: (fn) => { cb = fn; return () => { unsubbed = true; }; },
    emit: (ev) => { if (cb) cb(ev); },
    get unsubbed() { return unsubbed; },
  };
}

describe("awaitCloseThenFinalize (/close actually closes)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("finalizes on the turn_usage event (fast path)", () => {
    const sub = makeSub();
    const finalize = vi.fn();
    awaitCloseThenFinalize({
      subscribe: sub.subscribe,
      pollSettled: async () => "running",
      finalize,
      pollMs: 2500,
    });
    sub.emit({ type: "turn_usage" });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(sub.unsubbed).toBe(true);
  });

  it("finalizes via the registry poll when turn_usage is dropped (regression: stuck closing)", async () => {
    const sub = makeSub();
    const finalize = vi.fn();
    let polls = 0;
    awaitCloseThenFinalize({
      subscribe: sub.subscribe,
      // Turn is still running on the first poll, settled on the second. The live
      // event never arrives - this is the dropped-frame scenario.
      pollSettled: async () => (++polls >= 2 ? "settled" : "running"),
      finalize,
      pollMs: 2500,
    });
    expect(finalize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2500); // poll 1 -> running
    expect(finalize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2500); // poll 2 -> settled
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("finalizes exactly once even when both the event and the poll would fire", async () => {
    const sub = makeSub();
    const finalize = vi.fn();
    awaitCloseThenFinalize({
      subscribe: sub.subscribe,
      pollSettled: async () => "settled",
      finalize,
      pollMs: 2500,
    });
    sub.emit({ type: "turn_usage" });
    await vi.advanceTimersByTimeAsync(5000);
    sub.emit({ type: "session_ended" });
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("keeps polling while the turn is still running, never finalizing early", async () => {
    const sub = makeSub();
    const finalize = vi.fn();
    const pollSettled = vi.fn(async () => "running");
    awaitCloseThenFinalize({ subscribe: sub.subscribe, pollSettled, finalize, pollMs: 2500 });
    await vi.advanceTimersByTimeAsync(2500 * 3);
    expect(pollSettled).toHaveBeenCalledTimes(3);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("trigger() forces finalize once (send-error path) and stops polling", async () => {
    const sub = makeSub();
    const finalize = vi.fn();
    const pollSettled = vi.fn(async () => "running");
    const trigger = awaitCloseThenFinalize({ subscribe: sub.subscribe, pollSettled, finalize, pollMs: 2500 });
    trigger();
    expect(finalize).toHaveBeenCalledTimes(1);
    const pollsBefore = pollSettled.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(pollSettled.mock.calls.length).toBe(pollsBefore); // no polling after finalize
    sub.emit({ type: "turn_usage" });
    expect(finalize).toHaveBeenCalledTimes(1); // still once
  });
});
