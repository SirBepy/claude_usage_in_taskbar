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

describe("buildDiffRows - word-level emphasis", () => {
  it("marks only the changed word in a replaced line pair", () => {
    const rows = buildDiffRows("const a = 1;", "const b = 1;");
    const del = rows.find((r) => r.kind === "del");
    const add = rows.find((r) => r.kind === "add");
    expect(del.emph).toEqual([[6, 7]]);
    expect(add.emph).toEqual([[6, 7]]);
  });

  it("pairs line i of the del run with line i of the add run", () => {
    const rows = buildDiffRows("foo(1)\nbar(2)", "foo(9)\nbar(8)");
    const dels = rows.filter((r) => r.kind === "del");
    const adds = rows.filter((r) => r.kind === "add");
    expect(dels[0].emph).toEqual([[4, 5]]);
    expect(adds[0].emph).toEqual([[4, 5]]);
    expect(dels[1].emph).toEqual([[4, 5]]);
    expect(adds[1].emph).toEqual([[4, 5]]);
  });

  it("skips emphasis when the paired lines share nothing", () => {
    const rows = buildDiffRows("alpha beta", "gamma delta");
    expect(rows.find((r) => r.kind === "del").emph).toBeUndefined();
    expect(rows.find((r) => r.kind === "add").emph).toBeUndefined();
  });

  it("leaves context rows and unpaired adds unemphasised", () => {
    const rows = buildDiffRows("keep\nold", "keep\nold\nnew");
    expect(rows.every((r) => r.kind !== "ctx" || r.emph === undefined)).toBe(true);
    // "new" is a pure insertion (no del run before it) - no emph.
    expect(rows.find((r) => r.text === "new").emph).toBeUndefined();
  });

  it("skips emphasis for runs longer than 20 lines", () => {
    const oldText = Array.from({ length: 25 }, (_, i) => `line ${i} old`).join("\n");
    const newText = Array.from({ length: 25 }, (_, i) => `line ${i} new`).join("\n");
    const rows = buildDiffRows(oldText, newText);
    expect(rows.every((r) => r.emph === undefined)).toBe(true);
  });
});
