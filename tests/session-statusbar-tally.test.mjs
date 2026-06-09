// @vitest-environment jsdom
//
// The cumulative tool-tally row renders one chip per tool type (Read x4,
// Edited x6, ...) and opens a Files|Media popover on click. This drives the
// real SessionStatusbar so a regression in the row build or the popover tab
// DOM is caught. Tauri `invoke` is mocked (jsdom has no backend), so the
// thumbnail/open-in-editor side effects are asserted at the call level only.

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

function sampleTally() {
  return {
    byType: [
      { tool: "Read", count: 4 },
      { tool: "Grep", count: 3 },
      { tool: "Edit", count: 6 },
      { tool: "Bash", count: 5 },
    ],
    files: [
      { path: "/proj/src/a.ts", count: 1 },
      { path: "/proj/src/b.ts", count: 2 },
    ],
    images: [
      { path: "/proj/shot.png", filename: "shot.png", count: 1 },
    ],
  };
}

beforeEach(() => {
  ipcMock.impl = async () => null;
  document.body.innerHTML = "";
});

describe("tool-tally row", () => {
  it("renders one chip per tool type with friendly labels and counts", () => {
    const { el, sb } = mount();
    sb.updateToolTally(sampleTally());
    const chips = [...el.querySelectorAll(".sb-tally-chip")].map((c) => c.textContent);
    expect(chips).toEqual(["Read x4", "Grep x3", "Edited x6", "Ran x5"]);
  });

  it("hides the row when byType is empty", () => {
    const { el, sb } = mount();
    sb.updateToolTally(sampleTally());
    expect(el.querySelector(".sb-tally-row")).not.toBeNull();
    sb.updateToolTally({ byType: [], files: [], images: [] });
    expect(el.querySelector(".sb-tally-row")).toBeNull();
  });

  it("opens the Files|Media popover on row click, defaulting to Files", () => {
    const { el, sb } = mount();
    sb.updateToolTally(sampleTally());
    el.querySelector(".sb-tally-row").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const pop = document.body.querySelector(".sb-tally-popover");
    expect(pop).not.toBeNull();
    const tabs = [...pop.querySelectorAll(".sb-tally-tab")].map((t) => t.dataset.tab);
    expect(tabs).toEqual(["files", "media"]);
    expect(pop.querySelector('.sb-tally-tab[data-tab="files"]').className).toContain("active");
    const files = [...pop.querySelectorAll(".sb-tally-file .sb-tally-name")].map((n) => n.textContent);
    expect(files).toEqual(["a.ts", "b.ts"]);
  });

  it("switches to the Media tab and lists images", () => {
    const { el, sb } = mount();
    sb.updateToolTally(sampleTally());
    el.querySelector(".sb-tally-row").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const mediaBtn = document.body.querySelector('.sb-tally-tab[data-tab="media"]');
    mediaBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const pop = document.body.querySelector(".sb-tally-popover");
    const names = [...pop.querySelectorAll(".sb-tally-media .sb-tally-name")].map((n) => n.textContent);
    expect(names).toEqual(["shot.png"]);
  });

  it("shows empty-state copy when there are no files / images", () => {
    const { el, sb } = mount();
    sb.updateToolTally({ byType: [{ tool: "Bash", count: 1 }], files: [], images: [] });
    el.querySelector(".sb-tally-row").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const pop = document.body.querySelector(".sb-tally-popover");
    expect(pop.querySelector(".sb-tally-empty").textContent).toBe("No files");
    pop.querySelector('.sb-tally-tab[data-tab="media"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.body.querySelector(".sb-tally-popover .sb-tally-empty").textContent).toBe("No images");
  });

  it("calls open_in_editor with the file path on a Files row click", () => {
    const calls = [];
    ipcMock.impl = async (cmd, args) => { calls.push([cmd, args]); return null; };
    const { el, sb } = mount();
    sb.updateToolTally(sampleTally());
    el.querySelector(".sb-tally-row").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.body.querySelector(".sb-tally-file").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(calls).toContainEqual(["open_in_editor", { path: "/proj/src/a.ts" }]);
  });
});
