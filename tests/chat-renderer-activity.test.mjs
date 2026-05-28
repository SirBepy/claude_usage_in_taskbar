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

describe("ChatRenderer — turn-steps pill", () => {
  it("summary counts all intermediate steps, not just tool calls", () => {
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

    const summary = container.querySelector(".turn-steps-summary");
    expect(summary).not.toBeNull();
    // Intermediate = tool_use + tool_result = 2 (final answer stays outside).
    expect(summary.textContent).toContain("2 steps");
  });
});
