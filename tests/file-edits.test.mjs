import { describe, it, expect } from "vitest";
import { parseFileEdit } from "../src/shared/chat/file-edits.ts";

describe("parseFileEdit", () => {
  it("returns null for unknown tools", () => {
    expect(parseFileEdit("Bash", { command: "ls" })).toBeNull();
    expect(parseFileEdit("Read", { file_path: "/x.ts" })).toBeNull();
    expect(parseFileEdit("Grep", { pattern: "foo" })).toBeNull();
  });

  it("parses Edit into one hunk", () => {
    const view = parseFileEdit("Edit", {
      file_path: "C:/repo/src/foo.ts",
      old_string: "const a = 1;",
      new_string: "const a = 1;\nconst b = 2;",
    });
    expect(view).not.toBeNull();
    expect(view.path).toBe("C:/repo/src/foo.ts");
    expect(view.basename).toBe("foo.ts");
    expect(view.kind).toBe("edit");
    expect(view.hunks).toHaveLength(1);
    expect(view.hunks[0].oldText).toBe("const a = 1;");
    expect(view.hunks[0].newText).toBe("const a = 1;\nconst b = 2;");
    expect(view.addedLines).toBe(1);
    expect(view.removedLines).toBe(0);
  });

  it("parses Write with empty oldText and write kind", () => {
    const view = parseFileEdit("Write", {
      file_path: "/repo/new.ts",
      content: "line1\nline2\nline3",
    });
    expect(view.kind).toBe("write");
    expect(view.hunks[0].oldText).toBe("");
    expect(view.hunks[0].newText).toBe("line1\nline2\nline3");
    expect(view.addedLines).toBe(3);
    expect(view.removedLines).toBe(0);
  });

  it("parses MultiEdit into N labelled hunks", () => {
    const view = parseFileEdit("MultiEdit", {
      file_path: "/repo/multi.ts",
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "b", new_string: "B\nB2" },
      ],
    });
    expect(view.kind).toBe("multi");
    expect(view.hunks).toHaveLength(2);
    expect(view.hunks[0].label).toBe("edit 1 of 2");
    expect(view.hunks[1].label).toBe("edit 2 of 2");
    expect(view.addedLines).toBe(1);
  });

  it("parses NotebookEdit with cell label", () => {
    const view = parseFileEdit("NotebookEdit", {
      notebook_path: "/repo/n.ipynb",
      cell_id: "4",
      new_source: "print(1)",
      old_source: "",
    });
    expect(view.kind).toBe("notebook");
    expect(view.basename).toBe("n.ipynb");
    expect(view.hunks[0].label).toMatch(/cell/);
  });

  it("derives basename from path using last segment after / or \\", () => {
    const view = parseFileEdit("Edit", {
      file_path: "C:\\Users\\x\\foo.ts",
      old_string: "", new_string: "",
    });
    expect(view.basename).toBe("foo.ts");
  });
});
