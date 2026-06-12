// @vitest-environment jsdom
//
// Regression for the 2026-06-12 incident surface: the daemon crash-looped on a
// hostage port and the Chats sidebar showed "Setting up..." forever with no
// hint anything was wrong. When `state.daemonSetupStalled` is set (sessions.ts
// arms a stall timer while the daemon stays unconnected), the empty-state row
// must swap from the spinner to a visible warning, and swap back on connect.

import { describe, it, expect, vi, beforeEach } from "vitest";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
if (!globalThis.CSS) globalThis.CSS = window.CSS ?? { escape: (s) => s };

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => ({})) }));

const { renderSidebar } = await import("../src/views/sessions/sidebar.ts");
const { state } = await import("../src/views/sessions/state.ts");

function makeList() {
  const ul = document.createElement("ul");
  ul.id = "sessions-list";
  ul.className = "sessions-list";
  document.body.appendChild(ul);
  return ul;
}

describe("daemon setup stall surface in the sidebar", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
    state.sessions = [];
    state.parkedDrafts = [];
    state.questionSessions = new Set();
    state.filter = "";
    state.selectedId = null;
    state.pendingNewSession = null;
    state.daemonConnected = null;
    state.daemonSetupStalled = false;
  });

  it("shows the spinner row while the daemon is still connecting", () => {
    const el = makeList();
    renderSidebar(el);
    vi.runAllTimers();
    const row = el.querySelector("li.sessions-setup-row");
    expect(row).not.toBeNull();
    expect(row.textContent).toContain("Setting up");
    expect(el.querySelector(".sessions-setup-stalled")).toBeNull();
  });

  it("swaps to the warning row once the stall flag is set", () => {
    const el = makeList();
    renderSidebar(el);
    vi.runAllTimers();

    state.daemonSetupStalled = true;
    renderSidebar(el);
    vi.runAllTimers();

    const stalled = el.querySelector("li.sessions-setup-stalled");
    expect(stalled).not.toBeNull();
    expect(stalled.textContent).toContain("Daemon unreachable");
    expect(el.textContent).not.toContain("Setting up");
  });

  it("swaps to the normal empty row once the daemon connects", () => {
    const el = makeList();
    state.daemonSetupStalled = true;
    renderSidebar(el);
    vi.runAllTimers();
    expect(el.querySelector(".sessions-setup-stalled")).not.toBeNull();

    state.daemonSetupStalled = false;
    state.daemonConnected = true;
    renderSidebar(el);
    vi.runAllTimers();

    expect(el.querySelector(".sessions-setup-stalled")).toBeNull();
    expect(el.textContent).toContain("No active sessions");
  });

  it("re-rendering never piles up duplicate empty-state rows", () => {
    // The incident screenshot: two "Setting up..." rows AND "No active
    // sessions" coexisting. Empty-state rows had no reconcile identity
    // (keyOf returned ""), so every re-render appended a fresh copy.
    const el = makeList();
    renderSidebar(el);
    renderSidebar(el);
    renderSidebar(el);
    vi.runAllTimers();
    expect(el.querySelectorAll("li.sessions-setup-row").length).toBe(1);

    // Flip through stalled and connected; old rows must exit, not linger.
    state.daemonSetupStalled = true;
    renderSidebar(el);
    state.daemonSetupStalled = false;
    state.daemonConnected = true;
    renderSidebar(el);
    vi.runAllTimers();
    expect(el.querySelectorAll("li.sessions-empty-row").length).toBe(1);
    expect(el.textContent).toContain("No active sessions");
  });

  it("never shows the warning when sessions exist (entries non-empty)", () => {
    const el = makeList();
    state.daemonSetupStalled = true;
    state.sessions = [
      {
        session_id: "s1",
        pid: 0,
        cwd: "C:/proj",
        project_id: "p",
        kind: "interactive",
        is_remote: false,
        started_at: "2026-06-12T00:00:00Z",
        transcript_path: null,
        bridge_session_id: null,
        name: null,
        ended_at: null,
        end_reason: null,
        busy: false,
        model: "",
        effort: "",
        awaiting: null,
      },
    ];
    renderSidebar(el);
    vi.runAllTimers();
    expect(el.querySelector(".sessions-setup-stalled")).toBeNull();
    expect(el.querySelector('li[data-session-id="s1"]')).not.toBeNull();
  });
});
