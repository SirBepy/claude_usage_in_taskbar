// isQuestionAnswered is exported from question-ui.ts specifically so it has
// exactly one implementation shared by the floating card's own Next/Review
// gating AND permission-modal/index.ts's live-progress sync into the chat
// transcript (2026-07-16) - two call sites computing "answered" differently
// would drift, e.g. the chat transcript showing a question as done that the
// card itself still blocks Next on.

import { describe, it, expect } from "vitest";
import { isQuestionAnswered, computeAnswer } from "../src/views/sessions/permission-modal/question-ui.ts";

describe("isQuestionAnswered", () => {
  it("a question with no options is always answered (free-text-only, optional)", () => {
    expect(isQuestionAnswered({ question: "Notes?" }, "", undefined)).toBe(true);
  });

  it("free text alone answers ANY question type, regardless of selection", () => {
    const q = { question: "Pick", options: [{ label: "A" }] };
    expect(isQuestionAnswered(q, "typed", undefined)).toBe(true);
    expect(isQuestionAnswered(q, "  ", undefined)).toBe(false); // whitespace-only doesn't count
  });

  it("single-select requires a string selection", () => {
    const q = { question: "Pick", options: [{ label: "A" }, { label: "B" }] };
    expect(isQuestionAnswered(q, "", undefined)).toBe(false);
    expect(isQuestionAnswered(q, "", "A")).toBe(true);
  });

  it("multiSelect requires a NON-EMPTY Set - zero selections is NOT answered", () => {
    const q = { question: "Pick", multiSelect: true, options: [{ label: "A" }, { label: "B" }] };
    expect(isQuestionAnswered(q, "", new Set())).toBe(false);
    expect(isQuestionAnswered(q, "", undefined)).toBe(false);
    expect(isQuestionAnswered(q, "", new Set(["A"]))).toBe(true);
    expect(isQuestionAnswered(q, "", new Set(["None of the above"]))).toBe(true);
  });
});

describe("computeAnswer", () => {
  const single = { question: "Pick", options: [{ label: "A" }, { label: "B" }] };
  const multi = { question: "Pick", multiSelect: true, options: [{ label: "A" }, { label: "B" }] };

  it("single-select: pick alone returns the label", () => {
    expect(computeAnswer(single, "", "A")).toBe("A");
  });

  it("single-select: typed alone returns the typed text", () => {
    expect(computeAnswer(single, "custom", undefined)).toBe("custom");
  });

  it("single-select: pick + typed combine instead of the pick being discarded", () => {
    expect(computeAnswer(single, "why though", "A")).toEqual(["A", "why though"]);
  });

  it("single-select: whitespace-only typed text doesn't count as a combine", () => {
    expect(computeAnswer(single, "   ", "A")).toBe("A");
  });

  it("multiSelect: checked boxes + typed text combine into one array", () => {
    expect(computeAnswer(multi, "also this", new Set(["A"]))).toEqual(["A", "also this"]);
  });

  it("nothing picked or typed is null", () => {
    expect(computeAnswer(single, "", undefined)).toBe(null);
  });
});
