import { describe, it, expect } from "vitest";
import { dedupeByPath } from "../src/views/sessions/changes-panel.ts";

const v = (path, kind, added, removed) => ({
  path, basename: path.split(/[\\/]/).pop(), kind, hunks: [], addedLines: added, removedLines: removed,
});

describe("dedupeByPath", () => {
  it("returns empty for empty input", () => {
    expect(dedupeByPath([])).toEqual([]);
  });

  it("keeps a single edit as one row", () => {
    const out = dedupeByPath([v("/a.ts", "edit", 3, 1)]);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe("/a.ts");
    expect(out[0].addedLines).toBe(3);
    expect(out[0].removedLines).toBe(1);
  });

  it("aggregates two edits to the same path into one row", () => {
    const out = dedupeByPath([
      v("/a.ts", "edit", 3, 1),
      v("/b.ts", "write", 5, 0),
      v("/a.ts", "edit", 2, 4),
    ]);
    expect(out).toHaveLength(2);
    const a = out.find((r) => r.path === "/a.ts");
    expect(a.addedLines).toBe(5);
    expect(a.removedLines).toBe(5);
  });

  it("preserves first-seen order across paths", () => {
    const out = dedupeByPath([
      v("/z.ts", "edit", 1, 0),
      v("/a.ts", "edit", 1, 0),
      v("/z.ts", "edit", 1, 0),
    ]);
    expect(out.map((r) => r.path)).toEqual(["/z.ts", "/a.ts"]);
  });
});
