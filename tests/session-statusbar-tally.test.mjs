// @vitest-environment jsdom
//
// The cumulative tool-tally row renders one chip per tool type (Read x4,
// Edited x6, ...) and each chip opens its OWN drill-down popover listing that
// tool's distinct targets. This drives the real SessionStatusbar so a
// regression in the row build or the popover DOM is caught. Tauri `invoke` is
// mocked (jsdom has no backend), so the thumbnail/open-in-editor side effects
// are asserted at the call level only.

import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMock = { impl: async () => null };
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn((cmd, args) => ipcMock.impl(cmd, args)),
}));

const { SessionStatusbar } = await import("../src/views/sessions/session-statusbar.ts");

function mount(fields = []) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const sb = new SessionStatusbar(el, null, fields, { sessionId: "sess-1" });
  return { el, sb };
}

function item(over) {
  return { label: "", kind: "file", path: undefined, filename: undefined, count: 1, ...over };
}

function sampleTally() {
  return {
    byType: [
      { tool: "Read", count: 4, items: [
        item({ label: "a.ts", kind: "file", path: "/proj/src/a.ts", count: 1 }),
        item({ label: "b.ts", kind: "file", path: "/proj/src/b.ts", count: 2 }),
        item({ label: "shot.png", kind: "image", path: "/proj/shot.png", filename: "shot.png", count: 1 }),
      ] },
      { tool: "Grep", count: 3, items: [
        item({ label: "foo.*bar", kind: "text", count: 3 }),
      ] },
      { tool: "Edit", count: 6, items: [item({ label: "c.ts", kind: "file", path: "/proj/src/c.ts", count: 6 })] },
      { tool: "Bash", count: 5, items: [item({ label: "List files", kind: "text", count: 5 })] },
    ],
  };
}

function openChip(el, tool) {
  el.querySelector(`.sb-tally-chip[data-tool="${tool}"]`).dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

beforeEach(() => {
  ipcMock.impl = async () => null;
  document.body.innerHTML = "";
});

describe("tool-tally row", () => {
  it("renders one chip per tool type with friendly labels, counts and data-tool", () => {
    const { el, sb } = mount();
    sb.updateToolTally(sampleTally());
    const chips = [...el.querySelectorAll(".sb-tally-chip")].map((c) => c.textContent);
    expect(chips).toEqual(["Read x4", "Grep x3", "Edited x6", "Ran x5"]);
    const tools = [...el.querySelectorAll(".sb-tally-chip")].map((c) => c.dataset.tool);
    expect(tools).toEqual(["Read", "Grep", "Edit", "Bash"]);
  });

  it("hides the row when byType is empty", () => {
    const { el, sb } = mount();
    sb.updateToolTally(sampleTally());
    expect(el.querySelector(".sb-tally-row")).not.toBeNull();
    sb.updateToolTally({ byType: [] });
    expect(el.querySelector(".sb-tally-row")).toBeNull();
  });

  it("opens a per-tool popover listing that tool's files and images", () => {
    const { el, sb } = mount();
    sb.updateToolTally(sampleTally());
    openChip(el, "Read");
    const pop = document.body.querySelector(".sb-tally-popover");
    expect(pop).not.toBeNull();
    // No tabs in the per-tool popover.
    expect(pop.querySelector(".sb-tally-tab")).toBeNull();
    const files = [...pop.querySelectorAll(".sb-tally-file .sb-tally-name")].map((n) => n.textContent);
    expect(files).toEqual(["a.ts", "b.ts"]);
    const media = [...pop.querySelectorAll(".sb-tally-media .sb-tally-name")].map((n) => n.textContent);
    expect(media).toEqual(["shot.png"]);
  });

  it("lists text targets (Grep patterns) for a text tool", () => {
    const { el, sb } = mount();
    sb.updateToolTally(sampleTally());
    openChip(el, "Grep");
    const pop = document.body.querySelector(".sb-tally-popover");
    const texts = [...pop.querySelectorAll(".sb-tally-text .sb-tally-name")].map((n) => n.textContent);
    expect(texts).toEqual(["foo.*bar"]);
  });

  it("toggles a chip's popover closed on second click and swaps between chips", () => {
    const { el, sb } = mount();
    sb.updateToolTally(sampleTally());
    openChip(el, "Read");
    expect(document.body.querySelector(".sb-tally-popover")).not.toBeNull();
    openChip(el, "Read");
    expect(document.body.querySelector(".sb-tally-popover")).toBeNull();
    openChip(el, "Grep");
    const texts = [...document.body.querySelectorAll(".sb-tally-text .sb-tally-name")].map((n) => n.textContent);
    expect(texts).toEqual(["foo.*bar"]);
  });

  it("calls open_in_editor with the file path on a file row click", () => {
    const calls = [];
    ipcMock.impl = async (cmd, args) => { calls.push([cmd, args]); return null; };
    const { el, sb } = mount();
    sb.updateToolTally(sampleTally());
    openChip(el, "Read");
    document.body.querySelector(".sb-tally-file").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(calls).toContainEqual(["open_in_editor", { path: "/proj/src/a.ts" }]);
  });
});
