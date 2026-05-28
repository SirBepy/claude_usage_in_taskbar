// Regression: ctx% pinned at 100% because the window denominator collapsed
// 1M -> 200K. Root cause: the lookup only matched "opus-4-7", so the locked
// session short name "opus" (and a sub-call's full id) didn't map to 1M.

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn() }));

const { modelContextWindow } = await import("../src/views/sessions/session-statusbar.ts");

describe("modelContextWindow", () => {
  it("opus short name -> 1M", () => {
    expect(modelContextWindow("opus")).toBe(1_000_000);
  });
  it("full opus stream id -> 1M", () => {
    expect(modelContextWindow("claude-opus-4-7")).toBe(1_000_000);
  });
  it("haiku -> 200K", () => {
    expect(modelContextWindow("claude-haiku-4-5")).toBe(200_000);
  });
  it("sonnet short name -> 200K", () => {
    expect(modelContextWindow("sonnet")).toBe(200_000);
  });
  it("null -> 200K", () => {
    expect(modelContextWindow(null)).toBe(200_000);
  });
});
