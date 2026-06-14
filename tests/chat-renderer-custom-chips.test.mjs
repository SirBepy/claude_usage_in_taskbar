// Custom chip-panel views inside the chat: Read / "File Changes" aggregate one
// row per file with a count, Skills lists skills used, Questions pairs each
// AskUserQuestion question with the answer given. Plus the primary-color
// "currently working" pulse on the chip of an in-flight tool call.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const invokeMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");

beforeEach(() => {
  invokeMock.mockReset();
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.window.__TAURI__ = undefined;
});

function toolResultEvent(id, text = "ok") {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text }, is_error: false, timestamp: 0 };
}

function makeRenderer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  r.handleEvent(userEvent("go")); // open a turn so tool rows fold into its strip
  return { r, container };
}

describe("custom chip-panel views", () => {
  it("Read chip aggregates one row per file with a repeat-count badge", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("Read", { file_path: "/a/x.ts" }, "r1"));
    r.handleEvent(toolResultEvent("r1"));
    r.handleEvent(toolUseEvent("Read", { file_path: "/a/x.ts" }, "r2"));
    r.handleEvent(toolResultEvent("r2"));
    r.handleEvent(toolUseEvent("Read", { file_path: "/a/y.ts" }, "r3"));
    r.handleEvent(toolResultEvent("r3"));

    const chip = container.querySelector('.tool-chip[data-tool="Read"]');
    expect(chip).not.toBeNull();
    expect(chip.querySelector(".tool-chip-count").textContent).toBe("x3");

    const rows = container.querySelectorAll(".tool-file-row");
    expect(rows.length).toBe(2);
    expect(rows[0].dataset.path).toBe("/a/x.ts");
    expect(rows[0].querySelector(".tool-file-name").textContent).toBe("x.ts");
    expect(rows[0].querySelector(".tool-file-count").textContent).toBe("2×");
    // A single read shows no badge.
    expect(rows[1].querySelector(".tool-file-count")).toBeNull();
    r.detach();
  });

  it("combines Edit + Write into one 'File Changes' chip, aggregated per file", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("Edit", { file_path: "/a/z.rs", old_string: "a", new_string: "b" }, "e1"));
    r.handleEvent(toolUseEvent("Write", { file_path: "/a/new.md", content: "hi" }, "w1"));
    r.handleEvent(toolUseEvent("Edit", { file_path: "/a/z.rs", old_string: "b", new_string: "c" }, "e2"));

    const chip = container.querySelector('.tool-chip[data-tool="Edit"]');
    expect(chip).not.toBeNull();
    expect(chip.querySelector(".tool-chip-label").textContent).toBe("File Changes");
    expect(chip.querySelector(".tool-chip-count").textContent).toBe("x3");
    // Write did NOT create its own chip.
    expect(container.querySelector('.tool-chip[data-tool="Write"]')).toBeNull();

    const rows = container.querySelectorAll(".tool-file-row");
    expect(rows.length).toBe(2);
    expect(rows[0].dataset.path).toBe("/a/z.rs");
    expect(rows[0].querySelector(".tool-file-count").textContent).toBe("2 changes");
    expect(rows[1].querySelector(".tool-file-count").textContent).toBe("1 change");
    r.detach();
  });

  it("Skills chip lists each skill used", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("Skill", { skill: "commit" }, "s1"));
    r.handleEvent(toolUseEvent("Skill", { skill: "rate-it" }, "s2"));

    const chip = container.querySelector('.tool-chip[data-tool="Skill"]');
    expect(chip).not.toBeNull();
    expect(chip.querySelector(".tool-chip-label").textContent).toBe("Skills");

    const rows = [...container.querySelectorAll(".tool-skill-row .tool-skill-name")].map((e) => e.textContent);
    expect(rows).toEqual(["commit", "rate-it"]);
    r.detach();
  });

  it("Questions chip pairs each question with the answer given", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("AskUserQuestion", { questions: [{ question: "Pick one?", header: "Choice" }] }, "q1"));
    r.handleEvent(toolResultEvent("q1", "User answered the question(s):\nQ: Pick one?\nA: Option A"));

    const chip = container.querySelector('.tool-chip[data-tool="AskUserQuestion"]');
    expect(chip).not.toBeNull();
    expect(chip.querySelector(".tool-chip-label").textContent).toBe("Questions");

    const qa = container.querySelector(".tool-qa");
    expect(qa.querySelector(".tool-qa-header").textContent).toBe("Choice");
    expect(qa.querySelector(".tool-qa-q").textContent).toBe("Pick one?");
    expect(qa.querySelector(".tool-qa-a").textContent).toContain("Option A");
    r.detach();
  });

  it("shows 'awaiting answer' for an unanswered question", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("AskUserQuestion", { questions: [{ question: "Still thinking?" }] }, "q1"));
    const qa = container.querySelector(".tool-qa");
    expect(qa.querySelector(".tool-qa-a--pending")).not.toBeNull();
    expect(qa.querySelector(".tool-qa-a").textContent).toContain("awaiting answer");
    r.detach();
  });
});

describe("currently-working chip highlight", () => {
  it("pulses the in-flight tool's chip until its result arrives", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("Read", { file_path: "/a/x.ts" }, "r1"));
    const chip = container.querySelector('.tool-chip[data-tool="Read"]');
    expect(chip.classList.contains("tool-chip--running")).toBe(true);

    r.handleEvent(toolResultEvent("r1"));
    expect(chip.classList.contains("tool-chip--running")).toBe(false);
    r.detach();
  });

  it("clears the pulse when the turn closes even if no result arrived", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("Bash", { command: "sleep 999" }, "b1"));
    const chip = container.querySelector('.tool-chip[data-tool="Bash"]');
    expect(chip.classList.contains("tool-chip--running")).toBe(true);

    r.handleEvent(userEvent("next")); // new turn closes the prior one
    expect(chip.classList.contains("tool-chip--running")).toBe(false);
    r.detach();
  });
});
