import { describe, it, expect } from "vitest";
import { renderBlocks, renderMessage } from "../src/shared/chat/chat-transforms.ts";

describe("renderBlocks — file token handling", () => {
  it("converts a standalone <file:path::name> token to an attachment-chip", () => {
    const html = renderBlocks([{ type: "text", text: "<file:/data/uuid.pdf::report.pdf>" }]);
    expect(html).not.toContain("&lt;file:");
    expect(html).toContain("attachment-chip");
    expect(html).toContain('data-attachment-path="/data/uuid.pdf"');
    expect(html).toContain("report.pdf");
  });

  it("preserves text before and after a file token", () => {
    const html = renderBlocks([{ type: "text", text: "here is a file <file:/data/img.png::photo.png> and some text after" }]);
    expect(html).toContain("here is a file");
    expect(html).toContain("and some text after");
    expect(html).toContain("attachment-chip");
  });

  it("handles a file token without a display name", () => {
    const html = renderBlocks([{ type: "text", text: "<file:/data/uuid.png>" }]);
    expect(html).toContain("attachment-chip");
    expect(html).toContain("uuid.png");
  });

  it("handles multiple file tokens in one block", () => {
    const html = renderBlocks([
      { type: "text", text: "<file:/a.pdf::a.pdf> and <file:/b.txt::b.txt>" },
    ]);
    const matches = (html.match(/attachment-chip/g) ?? []).length;
    expect(matches).toBe(2);
  });

  it("does not affect text blocks without file tokens", () => {
    const html = renderBlocks([{ type: "text", text: "just regular text" }]);
    expect(html).not.toContain("attachment-chip");
    expect(html).toContain("just regular text");
  });

  it("handles Windows absolute paths with drive letter colon", () => {
    const html = renderBlocks([{ type: "text", text: "<file:C:\\Users\\data\\uuid.pdf::report.pdf>" }]);
    expect(html).toContain("attachment-chip");
    expect(html).toContain('data-attachment-path="C:\\Users\\data\\uuid.pdf"');
    expect(html).toContain("report.pdf");
  });
});

describe("renderMessage — tool_use branches to edit-window for file mutations", () => {
  it("renders Edit tool_use as <details class='edit-window'>", () => {
    const html = renderMessage({
      kind: "tool_use",
      tool: "Edit",
      input: { file_path: "/a/b/foo.ts", old_string: "a", new_string: "b" },
      id: "x",
      ts: 0,
    });
    expect(html).toContain("edit-window");
    expect(html).toContain("foo.ts");
    expect(html).not.toContain("<pre>{");
  });

  it("renders Write tool_use as edit-window", () => {
    const html = renderMessage({
      kind: "tool_use",
      tool: "Write",
      input: { file_path: "/x.ts", content: "hi" },
      id: "x",
      ts: 0,
    });
    expect(html).toContain("edit-window");
    expect(html).toContain("data-kind=\"write\"");
  });

  it("falls back to generic <pre> rendering for non-file tools", () => {
    const html = renderMessage({
      kind: "tool_use",
      tool: "Bash",
      input: { command: "ls" },
      id: "x",
      ts: 0,
    });
    expect(html).not.toContain("edit-window");
    expect(html).toContain("<pre>");
    expect(html).toContain("Bash");
  });

  it("falls back to generic for Edit with malformed input", () => {
    const html = renderMessage({
      kind: "tool_use",
      tool: "Edit",
      input: null,
      id: "x",
      ts: 0,
    });
    expect(html).not.toContain("edit-window");
    expect(html).toContain("<pre>");
  });
});
