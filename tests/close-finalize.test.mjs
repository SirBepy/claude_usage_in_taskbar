// Guards the /close lifecycle. Two regressions this pins:
// 1. The row used to be marked "closing" the instant the user's typed text
//    merely CONTAINED the substring "/close" (e.g. "//close" in prose), before
//    the skill ever ran. watchCloseLifecycle now only promotes on the skill's
//    own <cc-close:starting> sentinel.
// 2. Once promoted, teardown used to fire on any turn completion, including
//    `/close --dont-close` (which never closes the terminal) - tearing the
//    chat down anyway. watchCloseLifecycle now only tears down when the skill
//    emits <cc-close:done>; otherwise it stands the row down without teardown.
// Drop-proofing (turn_usage riding the lossy daemon->app notifier) is pinned
// the same way as before, just gated behind having seen the starting marker.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { watchCloseLifecycle } = await import("../src/views/sessions/close-finalize.ts");

function makeSub() {
  let cb = null;
  let unsubbed = false;
  return {
    subscribe: (fn) => { cb = fn; return () => { unsubbed = true; }; },
    emit: (ev) => { if (cb) cb(ev); },
    get unsubbed() { return unsubbed; },
  };
}

function assistantText(text) {
  return { type: "assistant_message", content: [{ type: "text", text }], streaming: false };
}

describe("watchCloseLifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does nothing if the turn settles without ever seeing <cc-close:starting>", () => {
    const sub = makeSub();
    const onStarting = vi.fn();
    const onStandDown = vi.fn();
    const finalize = vi.fn();
    watchCloseLifecycle({
      subscribe: sub.subscribe,
      pollSettled: async () => "running",
      onStarting,
      onStandDown,
      finalize,
      pollMs: 2500,
    });
    sub.emit(assistantText("just a normal reply, no markers here"));
    sub.emit({ type: "turn_usage" });
    expect(onStarting).not.toHaveBeenCalled();
    expect(onStandDown).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    expect(sub.unsubbed).toBe(true);
  });

  it("a bare substring match (no real skill run) never promotes - regression for '//close' false-positive", () => {
    const sub = makeSub();
    const onStarting = vi.fn();
    watchCloseLifecycle({
      subscribe: sub.subscribe,
      pollSettled: async () => "running",
      onStarting,
      onStandDown: vi.fn(),
      finalize: vi.fn(),
      pollMs: 2500,
    });
    // The model's reply happens to mention "/close" in prose - never the sentinel.
    sub.emit(assistantText("instead we //close, got it"));
    sub.emit({ type: "turn_usage" });
    expect(onStarting).not.toHaveBeenCalled();
  });

  it("promotes on <cc-close:starting> and finalizes on <cc-close:done> + turn_usage (fast path)", () => {
    const sub = makeSub();
    const onStarting = vi.fn();
    const onStandDown = vi.fn();
    const finalize = vi.fn();
    watchCloseLifecycle({
      subscribe: sub.subscribe,
      pollSettled: async () => "running",
      onStarting,
      onStandDown,
      finalize,
      pollMs: 2500,
    });
    sub.emit(assistantText("<cc-close:starting>\nRetrospective..."));
    expect(onStarting).toHaveBeenCalledTimes(1);
    sub.emit(assistantText("N memory writes . closing: yes\n<cc-close:done>"));
    sub.emit({ type: "turn_usage" });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(onStandDown).not.toHaveBeenCalled();
  });

  it("stands down instead of finalizing when the turn settles without <cc-close:done> (--dont-close)", () => {
    const sub = makeSub();
    const onStarting = vi.fn();
    const onStandDown = vi.fn();
    const finalize = vi.fn();
    watchCloseLifecycle({
      subscribe: sub.subscribe,
      pollSettled: async () => "running",
      onStarting,
      onStandDown,
      finalize,
      pollMs: 2500,
    });
    sub.emit(assistantText("<cc-close:starting>\nRetrospective..."));
    sub.emit(assistantText("N memory writes . closing: no\nTerminal kept open. Run /clear or close manually."));
    sub.emit({ type: "turn_usage" });
    expect(onStandDown).toHaveBeenCalledTimes(1);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("finalizes via the registry poll when turn_usage is dropped after <cc-close:done> (regression: stuck closing)", async () => {
    const sub = makeSub();
    const finalize = vi.fn();
    let polls = 0;
    watchCloseLifecycle({
      subscribe: sub.subscribe,
      pollSettled: async () => (++polls >= 2 ? "settled" : "running"),
      onStarting: vi.fn(),
      onStandDown: vi.fn(),
      finalize,
      pollMs: 2500,
    });
    sub.emit(assistantText("<cc-close:starting>"));
    sub.emit(assistantText("...<cc-close:done>"));
    // The live turn_usage event never arrives - dropped-frame scenario.
    expect(finalize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2500); // poll 1 -> running
    expect(finalize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2500); // poll 2 -> settled
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("settles exactly once even when both the event and the poll would fire", async () => {
    const sub = makeSub();
    const finalize = vi.fn();
    watchCloseLifecycle({
      subscribe: sub.subscribe,
      pollSettled: async () => "settled",
      onStarting: vi.fn(),
      onStandDown: vi.fn(),
      finalize,
      pollMs: 2500,
    });
    sub.emit(assistantText("<cc-close:starting>"));
    sub.emit(assistantText("...<cc-close:done>"));
    sub.emit({ type: "turn_usage" });
    await vi.advanceTimersByTimeAsync(5000);
    sub.emit({ type: "session_ended" });
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("keeps polling while the turn is still running, never settling early", async () => {
    const sub = makeSub();
    const finalize = vi.fn();
    const onStandDown = vi.fn();
    const pollSettled = vi.fn(async () => "running");
    watchCloseLifecycle({ subscribe: sub.subscribe, pollSettled, onStarting: vi.fn(), onStandDown, finalize, pollMs: 2500 });
    sub.emit(assistantText("<cc-close:starting>"));
    await vi.advanceTimersByTimeAsync(2500 * 3);
    expect(pollSettled).toHaveBeenCalledTimes(3);
    expect(finalize).not.toHaveBeenCalled();
    expect(onStandDown).not.toHaveBeenCalled();
  });

  it("cancel() before any marker arrives (send-error path) is a clean no-op", async () => {
    const sub = makeSub();
    const onStarting = vi.fn();
    const onStandDown = vi.fn();
    const finalize = vi.fn();
    const pollSettled = vi.fn(async () => "running");
    const cancel = watchCloseLifecycle({ subscribe: sub.subscribe, pollSettled, onStarting, onStandDown, finalize, pollMs: 2500 });
    cancel();
    expect(sub.unsubbed).toBe(true);
    expect(onStarting).not.toHaveBeenCalled();
    expect(onStandDown).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10000);
    expect(pollSettled).not.toHaveBeenCalled();
  });
});
