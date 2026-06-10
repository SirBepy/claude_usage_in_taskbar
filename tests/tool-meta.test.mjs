import { describe, it, expect } from "vitest";
import { toolSummary, classifyTarget, tallyDetail, IMAGE_EXTS } from "../src/shared/chat/tool-meta.ts";

describe("toolSummary — target + icon", () => {
  it("Read → basename target, ph-file", () => {
    const s = toolSummary("Read", { file_path: "/a/b/foo.ts" });
    expect(s).toEqual({ icon: "ph-file", tool: "Read", target: "foo.ts" });
  });

  it("Edit → basename target, ph-pencil-simple", () => {
    const s = toolSummary("Edit", { file_path: "/x/y/bar.rs" });
    expect(s.icon).toBe("ph-pencil-simple");
    expect(s.tool).toBe("Edit");
    expect(s.target).toBe("bar.rs");
  });

  it("Grep → pattern target, ph-magnifying-glass", () => {
    const s = toolSummary("Grep", { pattern: "foo.*bar" });
    expect(s).toEqual({ icon: "ph-magnifying-glass", tool: "Grep", target: "foo.*bar" });
  });

  it("Bash → description target, ph-terminal-window", () => {
    const s = toolSummary("Bash", { description: "List files", command: "ls -la" });
    expect(s).toEqual({ icon: "ph-terminal-window", tool: "Bash", target: "List files" });
  });

  it("Bash without description falls back to first 48 chars of command", () => {
    const cmd = "x".repeat(100);
    const s = toolSummary("Bash", { command: cmd });
    expect(s.target).toBe("x".repeat(48));
  });

  it("Agent → 'starting subagent' target, ph-robot (ignores prompt/description)", () => {
    const s = toolSummary("Agent", { description: "do a thing", prompt: "y".repeat(5000) });
    expect(s).toEqual({ icon: "ph-robot", tool: "Agent", target: "starting subagent" });
  });

  it("Task → 'starting subagent' target, ph-robot", () => {
    const s = toolSummary("Task", { prompt: "huge prompt" });
    expect(s).toEqual({ icon: "ph-robot", tool: "Task", target: "starting subagent" });
  });

  it("caps a >100-char Bash description at 100 chars + ellipsis", () => {
    const desc = "d".repeat(150);
    const s = toolSummary("Bash", { description: desc });
    expect(s.target).toBe("d".repeat(100) + "…");
    expect(s.target.length).toBe(101);
  });

  it("unknown tool → empty target, ph-wrench", () => {
    expect(toolSummary("Frobnicate", { whatever: 1 })).toEqual({ icon: "ph-wrench", tool: "Frobnicate", target: "" });
  });

  it("is defensive against null/non-object input", () => {
    expect(toolSummary("Read", null)).toEqual({ icon: "ph-file", tool: "Read", target: "" });
    expect(toolSummary("Grep", "nope")).toEqual({ icon: "ph-magnifying-glass", tool: "Grep", target: "" });
  });
});

describe("classifyTarget — file vs image vs none", () => {
  it("classifies a non-image Read target as file", () => {
    expect(classifyTarget("Read", { file_path: "/a/y.ts" })).toEqual({ kind: "file", path: "/a/y.ts" });
  });

  it("classifies an image-extension Read target as image", () => {
    expect(classifyTarget("Read", { file_path: "/a/x.PNG" })).toEqual({ kind: "image", path: "/a/x.PNG" });
  });

  it("classifies Edit/Write as file", () => {
    expect(classifyTarget("Edit", { file_path: "/a/z.rs" })).toEqual({ kind: "file", path: "/a/z.rs" });
    expect(classifyTarget("Write", { file_path: "/a/w.md" })).toEqual({ kind: "file", path: "/a/w.md" });
  });

  it("classifies NotebookEdit via notebook_path", () => {
    expect(classifyTarget("NotebookEdit", { notebook_path: "/a/n.ipynb" })).toEqual({ kind: "file", path: "/a/n.ipynb" });
  });

  it("classifies non-file tools as none", () => {
    expect(classifyTarget("Bash", { command: "ls" })).toEqual({ kind: "none" });
    expect(classifyTarget("Grep", { pattern: "x" })).toEqual({ kind: "none" });
  });

  it("returns none when the path is missing", () => {
    expect(classifyTarget("Read", {})).toEqual({ kind: "none" });
    expect(classifyTarget("Edit", null)).toEqual({ kind: "none" });
  });

  it("treats every IMAGE_EXTS entry as an image", () => {
    for (const ext of IMAGE_EXTS) {
      expect(classifyTarget("Read", { file_path: `/a/pic${ext}` }).kind).toBe("image");
    }
  });
});

describe("tallyDetail — per-chip drill-down item", () => {
  it("Read of a code file → file item keyed by path, basename label", () => {
    expect(tallyDetail("Read", { file_path: "/a/b/foo.ts" })).toEqual({
      key: "/a/b/foo.ts", kind: "file", path: "/a/b/foo.ts", label: "foo.ts",
    });
  });

  it("Read of an image → image item with filename", () => {
    expect(tallyDetail("Read", { file_path: "/a/shot.PNG" })).toEqual({
      key: "/a/shot.PNG", kind: "image", path: "/a/shot.PNG", filename: "shot.PNG", label: "shot.PNG",
    });
  });

  it("Grep / Glob → text item keyed distinctly by pattern", () => {
    expect(tallyDetail("Grep", { pattern: "foo.*" })).toEqual({ key: "grep:foo.*", kind: "text", label: "foo.*" });
    expect(tallyDetail("Glob", { pattern: "**/*.ts" })).toEqual({ key: "glob:**/*.ts", kind: "text", label: "**/*.ts" });
  });

  it("Bash → text item, description preferred over command", () => {
    expect(tallyDetail("Bash", { description: "List", command: "ls" })).toEqual({ key: "cmd:List", kind: "text", label: "List" });
    expect(tallyDetail("Bash", { command: "ls -la" })).toEqual({ key: "cmd:ls -la", kind: "text", label: "ls -la" });
  });

  it("returns null for tools / inputs with nothing to list", () => {
    expect(tallyDetail("Agent", { prompt: "x" })).toBeNull();
    expect(tallyDetail("Read", {})).toBeNull();
    expect(tallyDetail("Grep", { pattern: "" })).toBeNull();
    expect(tallyDetail("Frobnicate", { a: 1 })).toBeNull();
  });
});
