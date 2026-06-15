import { describe, it, expect } from "vitest";

const { markSessionClosing, unmarkSessionClosing, isSessionClosing } = await import(
  "../src/views/sessions/closing-sessions.ts"
);

describe("closing-sessions", () => {
  it("tracks a session as closing until unmarked", () => {
    expect(isSessionClosing("s1")).toBe(false);
    markSessionClosing("s1");
    expect(isSessionClosing("s1")).toBe(true);
    unmarkSessionClosing("s1");
    expect(isSessionClosing("s1")).toBe(false);
  });

  it("is independent per session id", () => {
    markSessionClosing("a");
    expect(isSessionClosing("a")).toBe(true);
    expect(isSessionClosing("b")).toBe(false);
    unmarkSessionClosing("a");
  });
});
