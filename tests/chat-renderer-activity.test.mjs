// Tests for the thinking-bar activity feed + turn-steps pill.
//
// Feature 1: the last real tool action stays PINNED through the streaming reply
// and turn end (no clear-to-verb mid-turn); it resets only on the next
// user_message. Observed via the onActivityUpdate callback (fires on change).
//
// Feature 2: the collapsed turn-steps <details> summary counts ALL intermediate
// messages between the user message and the final answer (not just tool calls).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, streamingEvent, finalEvent } from "./helpers/chat-events.mjs";

const invokeMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) {
  globalThis.window = {};
}

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

function toolUse(toolName, input, id) {
  return { type: "tool_use", tool_name: toolName, input, id };
}

function turnUsage() {
  return {
    type: "turn_usage",
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_cost_usd: 0,
    has_thinking: false,
    model: "m",
    timestamp: 0,
  };
}

describe("ChatRenderer — activity pinning", () => {
  it("keeps the last tool action pinned through the streaming reply (no clear)", () => {
    const r = new ChatRenderer(document.createElement("div"));
    const seen = [];
    r.onActivityUpdate = (a) => seen.push(a);

    r.handleEvent(userEvent("go"), { silent: true });
    r.handleEvent(toolUse("Read", { file_path: "/foo/bar.ts" }, "t1"), { silent: true });
    r.handleEvent(streamingEvent("here is the answer…"), { silent: true });
    r.handleEvent(finalEvent("done"), { silent: true });
    r.handleEvent(turnUsage(), { silent: true });

    // The action emitted is the last meaningful value; streaming/final/turn_usage
    // must not push a null afterwards.
    expect(seen).toContain("Reading bar.ts");
    expect(seen[seen.length - 1]).toBe("Reading bar.ts");
  });

  it("resets the pinned action to null on the next user_message", () => {
    const r = new ChatRenderer(document.createElement("div"));
    const seen = [];
    r.onActivityUpdate = (a) => seen.push(a);

    r.handleEvent(userEvent("go"), { silent: true });
    r.handleEvent(toolUse("Write", { file_path: "/foo/baz.ts" }, "t1"), { silent: true });
    r.handleEvent(finalEvent("done"), { silent: true });
    r.handleEvent(turnUsage(), { silent: true });
    r.handleEvent(userEvent("again"), { silent: true });

    expect(seen[seen.length - 1]).toBeNull();
  });
});

describe("ChatRenderer — per-type tool groups", () => {
  it("folds a turn's tool call into a per-type group counting tool_use only", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);

    r.handleEvent({ type: "session_started", session_id: "x", model: "m", cwd: "/", timestamp: 0 });
    r.handleEvent(userEvent("do it"));
    r.handleEvent(toolUse("Bash", { command: "ls" }, "t1"));
    r.handleEvent({ type: "tool_result", tool_use_id: "t1", output: "file.txt", is_error: false });
    r.handleEvent(streamingEvent("running…"));
    r.handleEvent(finalEvent("done"));
    r.handleEvent(turnUsage());

    expect(container.querySelector(".turn-steps")).toBeNull();
    const group = container.querySelector('.tool-group[data-tool="Bash"]');
    expect(group).not.toBeNull();
    // tool_use counts, tool_result does not.
    expect(group.querySelector(".tool-group-count").textContent).toBe("x1");
    // Both the tool_use row and its result live inside the group.
    expect(group.querySelectorAll(".tool-row").length).toBe(2);
    // The final answer stays outside the group.
    expect(group.contains(container.querySelector(".msg.assistant"))).toBe(false);
  });

  it("folds repeated calls of the same type into one growing count, live", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);

    r.handleEvent({ type: "session_started", session_id: "x", model: "m", cwd: "/", timestamp: 0 });
    r.handleEvent(userEvent("search"));
    r.handleEvent(toolUse("Grep", { pattern: "a" }, "g1"));
    let group = container.querySelector('.tool-group[data-tool="Grep"]');
    expect(group.querySelector(".tool-group-count").textContent).toBe("x1");
    r.handleEvent(toolUse("Grep", { pattern: "b" }, "g2"));
    r.handleEvent(toolUse("Grep", { pattern: "c" }, "g3"));
    group = container.querySelector('.tool-group[data-tool="Grep"]');
    // One group, count grew to 3.
    expect(container.querySelectorAll('.tool-group[data-tool="Grep"]').length).toBe(1);
    expect(group.querySelector(".tool-group-count").textContent).toBe("x3");
  });

  it("keeps distinct tool types in separate groups", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);

    r.handleEvent({ type: "session_started", session_id: "x", model: "m", cwd: "/", timestamp: 0 });
    r.handleEvent(userEvent("go"));
    r.handleEvent(toolUse("Grep", { pattern: "a" }, "g1"));
    r.handleEvent(toolUse("Read", { file_path: "/a/x.ts" }, "r1"));
    r.handleEvent(toolUse("Grep", { pattern: "b" }, "g2"));

    expect(container.querySelector('.tool-group[data-tool="Grep"] .tool-group-count').textContent).toBe("x2");
    expect(container.querySelector('.tool-group[data-tool="Read"] .tool-group-count').textContent).toBe("x1");
  });

  it("does NOT fold rich edit cards into a group", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);

    r.handleEvent({ type: "session_started", session_id: "x", model: "m", cwd: "/", timestamp: 0 });
    r.handleEvent(userEvent("edit"));
    r.handleEvent(toolUse("Edit", { file_path: "/a/x.ts", old_string: "a", new_string: "b" }, "e1"));

    expect(container.querySelector('.tool-group[data-tool="Edit"]')).toBeNull();
    expect(container.querySelector(".tool-use--file")).not.toBeNull();
  });
});
