import { describe, it, expect } from "vitest";
import { buildDiffRows, normalizeEol } from "../src/shared/chat/diff-rows.ts";

describe("normalizeEol", () => {
  it("flattens CRLF to LF", () => {
    expect(normalizeEol("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  it("leaves lone LF untouched", () => {
    expect(normalizeEol("a\nb")).toBe("a\nb");
  });
});

describe("buildDiffRows", () => {
  it("maps a single-line replacement to ctx/del/add/ctx", () => {
    const rows = buildDiffRows("a\nb\nc", "a\nX\nc");
    expect(rows.map((r) => r.kind)).toEqual(["ctx", "del", "add", "ctx"]);
    expect(rows.map((r) => r.text)).toEqual(["a", "b", "X", "c"]);
  });

  it("indexes srcLine into the correct side", () => {
    const rows = buildDiffRows("a\nb\nc", "a\nX\nc");
    // ctx + add index the NEW side; del indexes the OLD side.
    expect(rows[0]).toMatchObject({ kind: "ctx", srcLine: 0 });
    expect(rows[1]).toMatchObject({ kind: "del", srcLine: 1 });
    expect(rows[2]).toMatchObject({ kind: "add", srcLine: 1 });
    expect(rows[3]).toMatchObject({ kind: "ctx", srcLine: 2 });
  });

  it("renders a Write (empty old side) as pure adds", () => {
    const rows = buildDiffRows("", "line1\nline2");
    expect(rows.map((r) => r.kind)).toEqual(["add", "add"]);
    expect(rows.map((r) => r.srcLine)).toEqual([0, 1]);
  });

  it("treats identical sides as pure context", () => {
    const rows = buildDiffRows("a\nb", "a\nb");
    expect(rows.map((r) => r.kind)).toEqual(["ctx", "ctx"]);
  });

  it("does not flag a line as changed only because EOF newline differs", () => {
    const rows = buildDiffRows("x", "x\ny");
    expect(rows.map((r) => r.kind)).toEqual(["ctx", "add"]);
    expect(rows[1].text).toBe("y");
  });

  it("never emits a phantom row for a trailing newline", () => {
    const rows = buildDiffRows("a\nb\n", "a\nb\nc\n");
    expect(rows.map((r) => r.text)).toEqual(["a", "b", "c"]);
  });

  it("bails to null when the diff exceeds maxEditLength", () => {
    const oldText = Array.from({ length: 2500 }, (_, i) => `old line ${i}`).join("\n");
    const newText = Array.from({ length: 2500 }, (_, i) => `new line ${i}`).join("\n");
    expect(buildDiffRows(oldText, newText)).toBeNull();
  });
});
