// isQuestionAnswered is exported from question-ui.ts specifically so it has
// exactly one implementation shared by the floating card's own Next/Review
// gating AND permission-modal/index.ts's live-progress sync into the chat
// transcript (2026-07-16) - two call sites computing "answered" differently
// would drift, e.g. the chat transcript showing a question as done that the
// card itself still blocks Next on.

import { describe, it, expect } from "vitest";
import { isQuestionAnswered } from "../src/views/sessions/permission-modal/question-ui.ts";

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
