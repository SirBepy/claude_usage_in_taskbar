import { describe, it, expect, beforeEach, vi } from "vitest";
import { reconcilePendingPrompts } from "../src/views/sessions/permission-modal/remote-prompt-poll.ts";

// The phone had no way to learn about AskUserQuestion / permission prompts: the
// desktop got them via a Rust-side poll + Tauri events, but the phone's
// transport never polled list_pending_prompts. reconcilePendingPrompts is the
// JS demux that drives the phone poll, mirroring daemon_link.rs. Each stored
// prompt is { id, event, payload }.

function cbs() {
  return {
    onQuestion: vi.fn(),
    onPermission: vi.fn(),
    onResolved: vi.fn(),
  };
}

const QUESTION = { id: "q1", event: "question-requested", payload: { id: "q1", session_id: "s1", questions: [] } };
const PERMISSION = { id: "p1", event: "permission-requested", payload: { id: "p1", session_id: "s1", tool_name: "Bash", input: {} } };

describe("reconcilePendingPrompts", () => {
  let emitted;
  let cb;
  beforeEach(() => { emitted = new Set(); cb = cbs(); });

  it("surfaces a new question prompt once and marks it emitted", () => {
    reconcilePendingPrompts([QUESTION], emitted, cb);
    expect(cb.onQuestion).toHaveBeenCalledTimes(1);
    expect(cb.onQuestion).toHaveBeenCalledWith(QUESTION.payload);
    expect(emitted.has("q1")).toBe(true);
  });

  it("surfaces a new permission prompt", () => {
    reconcilePendingPrompts([PERMISSION], emitted, cb);
    expect(cb.onPermission).toHaveBeenCalledTimes(1);
    expect(cb.onPermission).toHaveBeenCalledWith(PERMISSION.payload);
  });

  it("does not re-emit a prompt still present on the next poll", () => {
    reconcilePendingPrompts([QUESTION], emitted, cb);
    reconcilePendingPrompts([QUESTION], emitted, cb);
    expect(cb.onQuestion).toHaveBeenCalledTimes(1);
    expect(cb.onResolved).not.toHaveBeenCalled();
  });

  it("fires onResolved exactly once when a prompt disappears", () => {
    reconcilePendingPrompts([QUESTION], emitted, cb);
    reconcilePendingPrompts([], emitted, cb);
    expect(cb.onResolved).toHaveBeenCalledTimes(1);
    expect(cb.onResolved).toHaveBeenCalledWith("q1");
    expect(emitted.has("q1")).toBe(false);
    // A further empty poll must not re-resolve it.
    reconcilePendingPrompts([], emitted, cb);
    expect(cb.onResolved).toHaveBeenCalledTimes(1);
  });

  it("ignores a non-array snapshot (network/parse hiccup)", () => {
    reconcilePendingPrompts(null, emitted, cb);
    reconcilePendingPrompts(undefined, emitted, cb);
    expect(cb.onQuestion).not.toHaveBeenCalled();
    expect(cb.onResolved).not.toHaveBeenCalled();
  });

  it("skips malformed entries (missing id / payload / unknown event)", () => {
    reconcilePendingPrompts([
      { event: "question-requested", payload: {} },       // no id
      { id: "x", event: "question-requested" },           // no payload
      { id: "y", event: "something-else", payload: {} },  // unknown event
    ], emitted, cb);
    expect(cb.onQuestion).not.toHaveBeenCalled();
    expect(cb.onPermission).not.toHaveBeenCalled();
    expect(emitted.size).toBe(0);
  });
});
