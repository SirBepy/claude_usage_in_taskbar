import { describe, it, expect, beforeEach } from "vitest";
import {
  storePendingPrompt,
  takePendingPrompt,
  clearPendingPrompt,
  pendingPromptSessionIds,
} from "../src/views/sessions/permission-modal/gating.ts";

// Regression for ai_todo 80 (switched-away busy chat drops its tool-permission
// prompt and hangs). The frontend used to DROP a permission/question event
// raised on a non-selected session, which left the daemon's responder oneshot
// (keyed by payload.id) parked forever. The fix parks the full payload keyed by
// session_id so it can be replayed and answered when the user switches back.
//
// These cover the gating-store invariant without a billed `claude -p` turn:
// the payload (carrying the responder id) is preserved, retrievable exactly
// once, and reflected in the attention set the sidebar reads.

const SESSION = "sess-bg-1";

function permPrompt(id = "perm-1") {
  return {
    kind: "permission",
    payload: { id, tool_name: "Bash", input: { command: "ls" }, session_id: SESSION },
  };
}

describe("parked permission/question prompts", () => {
  beforeEach(() => clearPendingPrompt(SESSION));

  it("a parked prompt is NOT lost: the payload (with its responder id) survives", () => {
    storePendingPrompt(SESSION, permPrompt("perm-42"));
    const taken = takePendingPrompt(SESSION);
    expect(taken).not.toBeNull();
    expect(taken.kind).toBe("permission");
    // The responder id must survive so respond_permission can resolve the
    // daemon oneshot and the chat's turn continues.
    expect(taken.payload.id).toBe("perm-42");
    expect(taken.payload.session_id).toBe(SESSION);
  });

  it("marks the session as needing attention while parked", () => {
    expect(pendingPromptSessionIds().has(SESSION)).toBe(false);
    storePendingPrompt(SESSION, permPrompt());
    expect(pendingPromptSessionIds().has(SESSION)).toBe(true);
  });

  it("is consumed exactly once (replay clears the attention marker)", () => {
    storePendingPrompt(SESSION, permPrompt());
    expect(takePendingPrompt(SESSION)).not.toBeNull();
    expect(pendingPromptSessionIds().has(SESSION)).toBe(false);
    expect(takePendingPrompt(SESSION)).toBeNull();
  });

  it("a newer prompt for the same session replaces the older one", () => {
    storePendingPrompt(SESSION, permPrompt("old"));
    storePendingPrompt(SESSION, permPrompt("new"));
    expect(takePendingPrompt(SESSION).payload.id).toBe("new");
  });

  it("question-shaped prompts park the same way", () => {
    storePendingPrompt(SESSION, {
      kind: "question",
      payload: { id: "q-1", questions: { question: "Proceed?" }, session_id: SESSION },
    });
    const taken = takePendingPrompt(SESSION);
    expect(taken.kind).toBe("question");
    expect(taken.payload.id).toBe("q-1");
  });

  it("clearPendingPrompt drops a parked prompt (GC of a dead session)", () => {
    storePendingPrompt(SESSION, permPrompt());
    clearPendingPrompt(SESSION);
    expect(pendingPromptSessionIds().has(SESSION)).toBe(false);
    expect(takePendingPrompt(SESSION)).toBeNull();
  });
});
