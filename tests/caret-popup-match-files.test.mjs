import { describe, it, expect } from "vitest";
import { matchFiles } from "../src/shared/chat/caret-popup/match-files.ts";

describe("matchFiles", () => {
  it("empty query returns full list capped at 50", () => {
    const items = Array.from({ length: 100 }, (_, i) => `f${i}.ts`);
    expect(matchFiles(items, "")).toHaveLength(50);
  });

  it("basename prefix beats basename contains", () => {
    const items = ["src/Compact.tsx", "src/Composer.tsx"];
    const out = matchFiles(items, "compo");
    expect(out[0]).toBe("src/Composer.tsx");
  });

  it("basename contains beats path contains", () => {
    const items = ["src/comp/widget.tsx", "src/foo/Composer.tsx"];
    const out = matchFiles(items, "compo");
    expect(out[0]).toBe("src/foo/Composer.tsx");
  });

  it("path contains finds files when basename doesn't match", () => {
    const items = ["a/b/c.ts", "x/y/z.ts"];
    const out = matchFiles(items, "a/b");
    expect(out).toContain("a/b/c.ts");
  });

  it("fuzzy fallback catches subsequence", () => {
    const items = ["src/views/sessions/sessions.ts"];
    const out = matchFiles(items, "vwsessns");
    expect(out).toContain("src/views/sessions/sessions.ts");
  });

  it("returns empty when nothing matches", () => {
    expect(matchFiles(["a", "b"], "xyz")).toHaveLength(0);
  });
});
