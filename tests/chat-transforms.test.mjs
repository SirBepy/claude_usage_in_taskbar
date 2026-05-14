import { describe, it, expect } from "vitest";
import { renderBlocks } from "../src/shared/chat/chat-transforms.ts";

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
