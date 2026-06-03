// @vitest-environment jsdom
//
// Regression for the close-animation "flash-back": when a session row is
// closed it slides left, the rows below animate up, and then the closed row
// (or the slot it vacated) briefly snaps back before disappearing.
//
// OLD root cause (FLIP design): the exiting <li> used translateX for the
// slide-out, so it kept occupying vertical space. Removing it on `animationend`
// reflowed siblings up, then a deferred FLIP built from stale rects yanked them
// back down for one painted frame — the flash.
//
// NEW design (this contract): the exiting row is taken OUT of layout flow
// (position:absolute) the instant it starts exiting. Siblings reflow up
// immediately and a single, undeferred FLIP slides them. Because the exiting
// row no longer occupies a slot, removing it on `animationend` can't reflow
// anything — the flash-back is structurally impossible, and there is no
// deferral / single-flight scheduler / applyReorder-owns-removal coupling.
//
// Contract under test:
//   - an exiting row is pinned position:absolute (out of flow) on close, and
//   - it is removed on its own `animationend`, OR by a safety timer if no
//     animationend ever fires.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Route rAF through (faked) setTimeout so vi fake timers drive the FLIP.
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
// jsdom exposes CSS on window but not globalThis; sidebar-anim uses CSS.escape.
if (!globalThis.CSS) globalThis.CSS = window.CSS ?? { escape: (s) => s };

const { reconcileList, markSessionExiting } = await import("../src/views/sessions/sidebar-anim.ts");

function row(id) {
  return { key: `s:${id}`, html: `<li data-session-id="${id}"><span>${id}</span></li>` };
}

function ids(listEl) {
  return [...listEl.querySelectorAll("li[data-session-id]")].map((li) => li.dataset.sessionId);
}

function makeList() {
  const ul = document.createElement("ul");
  ul.className = "sessions-list";
  document.body.appendChild(ul);
  return ul;
}

describe("sidebar close animation", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  it("pins the exiting row out of flow and removes it on animationend", () => {
    const listEl = makeList();

    // Initial paint: X, A, B (all enter; the reorder runs synchronously).
    reconcileList(listEl, [row("X"), row("A"), row("B")], true);
    vi.runAllTimers();
    expect(ids(listEl)).toEqual(["X", "A", "B"]);

    // User closes X — slide-out begins immediately and X leaves layout flow.
    markSessionExiting(listEl, "X");
    const xLi = listEl.querySelector('li[data-session-id="X"]');
    expect(xLi.classList.contains("row-exiting")).toBe(true);
    expect(xLi.style.position).toBe("absolute");

    // Backend confirms X gone -> reconcile reorders survivors synchronously.
    reconcileList(listEl, [row("A"), row("B")], true);

    // The slide-out finishes and fires animationend. Because X is out of flow,
    // removing it here cannot reflow the survivors — so removal is correct now
    // (the opposite of the old FLIP contract, where this would flash).
    xLi.dispatchEvent(new window.Event("animationend"));
    expect(listEl.querySelector('li[data-session-id="X"]')).toBeNull();
    expect(ids(listEl)).toEqual(["A", "B"]);
  });

  it("removes the exiting row even if no animationend fires (safety net)", () => {
    const listEl = makeList();
    reconcileList(listEl, [row("X"), row("A")], true);
    vi.runAllTimers();

    markSessionExiting(listEl, "X");
    expect(listEl.querySelector('li[data-session-id="X"]')).not.toBeNull();

    // No animationend, no reconcile. The safety timeout must still clean up.
    vi.advanceTimersByTime(3000);
    expect(listEl.querySelector('li[data-session-id="X"]')).toBeNull();
  });

  it("never reorders siblings into a stale layout: end state is correct after a close", () => {
    const listEl = makeList();
    reconcileList(listEl, [row("X"), row("A"), row("B"), row("C")], true);
    vi.runAllTimers();

    markSessionExiting(listEl, "X");
    reconcileList(listEl, [row("A"), row("B"), row("C")], true);
    // Let the slide-out + safety timer resolve so the exiting node is gone.
    vi.runAllTimers();

    expect(ids(listEl)).toEqual(["A", "B", "C"]);
    expect(listEl.querySelectorAll("li.row-exiting").length).toBe(0);
  });
});

// A new chat (the pending draft row) opened WHILE a just-closed row is still
// sliding out must appear immediately — never starved waiting for the close to
// settle. With the out-of-flow design there is no deferral: new rows insert
// synchronously in the same reconcile, so even a burst of instances-changed
// reconciles can't hide the new draft.
describe("new chat opened during a close", () => {
  const pending = () => ({ key: "pending", html: `<li data-pending="1" class="pending">draft</li>` });
  const allIds = (el) =>
    [...el.querySelectorAll("li")].map((li) => li.dataset.sessionId ?? (li.dataset.pending ? "PENDING" : "?"));

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  it("inserts the pending row immediately despite a reconcile burst", () => {
    const listEl = makeList();
    reconcileList(listEl, [row("X")], true);
    vi.runAllTimers();

    // Close X, then immediately open a new chat (X still exiting).
    markSessionExiting(listEl, "X");
    reconcileList(listEl, [pending()], true);

    // The new row is visible right away — no "type to reveal", no deferral.
    expect(allIds(listEl)).toContain("PENDING");

    // Storm of instances-changed reconciles under the old settle window: the
    // pending row stays visible throughout.
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(100);
      reconcileList(listEl, [pending()], true);
      expect(allIds(listEl)).toContain("PENDING");
    }

    // The closed row is gone once its slide-out / safety timer resolves.
    vi.runAllTimers();
    expect(listEl.querySelector('li[data-session-id="X"]')).toBeNull();
  });

  // Each draft must carry a DISTINCT key (sidebar keys drafts by placeholderId,
  // not a constant "pending"). A shared key let a discarded draft's exit
  // suppression leak onto the next draft, hiding it until the key changed.
  // Drafts here use distinct `p:<id>` keys to mirror that contract.
  const draft = (id) => ({ key: `p:${id}`, html: `<li class="pending" data-pending="1" data-placeholder-id="${id}">draft</li>` });

  it("shows a new draft opened right after discarding the previous one", () => {
    const listEl = makeList();

    // Open draft #1.
    reconcileList(listEl, [draft("P1")], true);
    vi.runAllTimers();
    expect(allIds(listEl)).toContain("PENDING");

    // Discard draft #1 (it begins exiting), then immediately open draft #2.
    reconcileList(listEl, [], true);
    reconcileList(listEl, [draft("P2")], true);
    vi.runAllTimers();

    // Draft #2 must be visible — not suppressed by draft #1's exit.
    expect(allIds(listEl)).toContain("PENDING");
    expect(listEl.querySelector('li[data-placeholder-id="P2"]')).not.toBeNull();
  });
});
