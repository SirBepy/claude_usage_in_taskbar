// @vitest-environment jsdom
//
// Regression for the close-animation "flash-back": when a session row is
// closed it slides left, the rows below animate up, and then the closed row
// (or the slot it vacated) briefly snaps back before disappearing.
//
// Root cause: the exiting <li> uses translateX for the slide-out, so it keeps
// occupying vertical space. Two independent timers then race:
//   - the node's `animationend` cleanup removes it (~280ms), which reflows the
//     siblings UP instantly, and
//   - `applyReorder` runs the FLIP at +310ms using `beforeRects` captured while
//     the node STILL occupied space, yanking the siblings back DOWN for one
//     painted frame before animating them up.
// That stale invert frame is the visible flash. The fix makes `applyReorder`
// the sole owner of exit-node removal, so the removal + FLIP happen in one
// synchronized step and the early `animationend` no longer reflows siblings.
//
// Contract under test: an exiting row is NOT removed by its own `animationend`
// while a reconcile/applyReorder pass is responsible for it. It is removed by
// applyReorder, atomically with the sibling reorder.

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

  it("does not remove the exiting row on animationend (applyReorder owns removal)", () => {
    const listEl = makeList();

    // Initial paint: X, A, B (all enter; applyReorder runs synchronously).
    reconcileList(listEl, [row("X"), row("A"), row("B")], true);
    vi.runAllTimers();
    expect(ids(listEl)).toEqual(["X", "A", "B"]);

    // User closes X — slide-out begins immediately.
    markSessionExiting(listEl, "X");
    const xLi = listEl.querySelector('li[data-session-id="X"]');
    expect(xLi.classList.contains("row-exiting")).toBe(true);

    // Backend confirms X gone -> reconcile schedules applyReorder (+310ms).
    reconcileList(listEl, [row("A"), row("B")], true);

    // The slide-out animation finishes (~280ms) and fires animationend BEFORE
    // applyReorder runs. The exiting node must STILL be in the DOM here:
    // removing it now would reflow the siblings up and cause the flash.
    xLi.dispatchEvent(new window.Event("animationend"));
    expect(listEl.querySelector('li[data-session-id="X"]')).not.toBeNull();

    // applyReorder fires: it removes the exiting node and reorders, atomically.
    vi.advanceTimersByTime(400);
    expect(listEl.querySelector('li[data-session-id="X"]')).toBeNull();
    expect(ids(listEl)).toEqual(["A", "B"]);
  });

  it("removes the exiting row even if no reconcile follows (safety net)", () => {
    const listEl = makeList();
    reconcileList(listEl, [row("X"), row("A")], true);
    vi.runAllTimers();

    markSessionExiting(listEl, "X");
    expect(listEl.querySelector('li[data-session-id="X"]')).not.toBeNull();

    // No reconcile arrives. The safety timeout must still clean the node up.
    vi.advanceTimersByTime(3000);
    expect(listEl.querySelector('li[data-session-id="X"]')).toBeNull();
  });

  it("never reorders siblings into a stale layout: end state is correct after a close", () => {
    const listEl = makeList();
    reconcileList(listEl, [row("X"), row("A"), row("B"), row("C")], true);
    vi.runAllTimers();

    markSessionExiting(listEl, "X");
    reconcileList(listEl, [row("A"), row("B"), row("C")], true);
    vi.runAllTimers();

    expect(ids(listEl)).toEqual(["A", "B", "C"]);
    expect(listEl.querySelectorAll("li.row-exiting").length).toBe(0);
  });
});
