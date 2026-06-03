import { describe, it, expect } from "vitest";
import { renderBlocks, renderMessage, cleanUserBlocks, base64ToUtf8, detectStatusToken } from "../src/shared/chat/chat-transforms.ts";

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

describe("renderBlocks — pasted-log chip", () => {
  const body = "Hello 世界\nsecond line\nthird line";

  it("collapses a <pasted-log> wrapper into a chip, not raw text", () => {
    const html = renderBlocks([{ type: "text", text: `<pasted-log name="pasted_log.txt">\n${body}\n</pasted-log>` }]);
    expect(html).toContain("pasted-log-chip");
    expect(html).toContain("pasted_log.txt");
    // the body must NOT render as visible text
    expect(html).not.toContain("second line");
    expect(html).not.toContain("世界");
  });

  it("stashes the full body (base64, utf8-safe) for the lightbox", () => {
    const html = renderBlocks([{ type: "text", text: `<pasted-log name="pasted_log.txt">\n${body}\n</pasted-log>` }]);
    const m = html.match(/data-pasted-text="([^"]*)"/);
    expect(m).toBeTruthy();
    expect(base64ToUtf8(m[1])).toBe(body);
  });

  it("renders typed text around the chip normally", () => {
    const html = renderBlocks([{ type: "text", text: `look at this\n\n<pasted-log name="pasted_log.txt">\n${body}\n</pasted-log>` }]);
    expect(html).toContain("look at this");
    expect(html).toContain("pasted-log-chip");
  });
});

describe("status marker", () => {
  it("strips the status marker from rendered text", () => {
    const html = renderBlocks([{ type: "text", text: "All done here.\n<cc-status:done>" }]);
    expect(html).not.toContain("cc-status");
    expect(html).toContain("All done here");
  });
  it("detectStatusToken reads the last marker", () => {
    expect(detectStatusToken("blah <cc-status:question>")).toBe("question");
    expect(detectStatusToken("nope")).toBe(null);
  });
});

describe("title marker — XML form", () => {
  it("strips XML-form <cc-title>...</cc-title> from rendered text", () => {
    const html = renderBlocks([{ type: "text", text: "Hello world\n<cc-title>Casual greeting exchange</cc-title>\n<cc-status:done>" }]);
    expect(html).not.toContain("cc-title");
    expect(html).toContain("Hello world");
  });
  it("strips XML-form title without status marker", () => {
    const html = renderBlocks([{ type: "text", text: "Some response\n<cc-title>Chat About Foo</cc-title>" }]);
    expect(html).not.toContain("cc-title");
    expect(html).toContain("Some response");
  });
  it("strips partial XML-form tail during streaming", () => {
    const html = renderBlocks([{ type: "text", text: "text\n<cc-title>partial content still streaming" }]);
    expect(html).not.toContain("cc-title");
    expect(html).toContain("text");
  });
});

describe("cleanUserBlocks — strips background-task notifications", () => {
  it("drops a user message containing only a task-notification block", () => {
    const out = cleanUserBlocks([{ type: "text", text: "<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n<summary>did the thing</summary>\n</task-notification>" }]);
    expect(out).toEqual([]);
  });

  it("strips task-notification but preserves surrounding user text", () => {
    const out = cleanUserBlocks([{ type: "text", text: "hey before\n<task-notification><status>done</status></task-notification>\nhey after" }]);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("hey before");
    expect(out[0].text).toContain("hey after");
    expect(out[0].text).not.toContain("task-notification");
    expect(out[0].text).not.toContain("status");
  });
});
