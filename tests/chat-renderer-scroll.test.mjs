// Scroll-preservation: a live update only yanks the view to the bottom when the
// user was already at (or within ~64px of) the bottom. If they scrolled UP to
// read history, their position is preserved.
//
// jsdom has no layout, so scrollHeight/scrollTop/clientHeight are all 0. We fake
// them via Object.defineProperty to exercise both the at-bottom and scrolled-up
// branches of ChatRenderer.isNearBottom().

import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { assistantEvent } from "./helpers/chat-events.mjs";

if (!globalThis.window) {
  globalThis.window = {};
}

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");

beforeEach(() => {
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

/**
 * Returns a div whose scroll metrics are faked. `scrollTop` is a real
 * read/write slot so we can observe whether the renderer wrote to it.
 */
function makeScrollContainer({ scrollHeight, clientHeight, scrollTop }) {
  const el = document.createElement("div");
  let _scrollTop = scrollTop;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => _scrollTop,
    set: (v) => { _scrollTop = v; },
  });
  return el;
}

describe("ChatRenderer — scroll preservation on live update", () => {
  it("auto-scrolls to bottom when the user was already at the bottom", () => {
    // distance = 1000 - 1000 - 0 = 0 <= 64 → at bottom
    const el = makeScrollContainer({ scrollHeight: 1000, clientHeight: 0, scrollTop: 1000 });
    const r = new ChatRenderer(el);
    r.handleEvent(assistantEvent("live reply"));
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  it("auto-scrolls when within the ~64px threshold of the bottom", () => {
    // distance = 1000 - 950 - 0 = 50 <= 64 → near bottom
    const el = makeScrollContainer({ scrollHeight: 1000, clientHeight: 0, scrollTop: 950 });
    const r = new ChatRenderer(el);
    r.handleEvent(assistantEvent("live reply"));
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  it("preserves scroll position when the user scrolled up to read history", () => {
    // distance = 1000 - 200 - 0 = 800 > 64 → scrolled up
    const el = makeScrollContainer({ scrollHeight: 1000, clientHeight: 0, scrollTop: 200 });
    const r = new ChatRenderer(el);
    r.handleEvent(assistantEvent("live reply"));
    expect(el.scrollTop).toBe(200);
  });

  it("does not scroll when skipScroll is set, even if at bottom", () => {
    const el = makeScrollContainer({ scrollHeight: 1000, clientHeight: 0, scrollTop: 1000 });
    const r = new ChatRenderer(el);
    el.scrollTop = 500; // pretend somewhere else; skipScroll must leave it alone
    r.handleEvent(assistantEvent("live reply"), { skipScroll: true });
    expect(el.scrollTop).toBe(500);
  });
});
