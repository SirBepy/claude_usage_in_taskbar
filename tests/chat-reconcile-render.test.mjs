// Integration regression for the recurring "chat marked done but the message
// never shows" bug. Drives the real ChatRenderer + event store through a full
// open: a turn that the lossy daemon->app notifier dropped is absent from the
// rendered transcript, then reconcileLatest (run on every session open) re-reads
// the authoritative JSONL tail and paints it. Asserts the recovered message
// reaches both r.messages AND the DOM - not just the store.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, assistantEvent } from "./helpers/chat-events.mjs";

const invokeMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { sessionEvents } = await import("../src/shared/chat/event-store.ts");

function makeBus() {
  const listeners = new Map();
  return {
    event: {
      async listen(channel, cb) {
        let arr = listeners.get(channel);
        if (!arr) { arr = []; listeners.set(channel, arr); }
        arr.push(cb);
        return () => {
          const a = listeners.get(channel);
          if (a) a.splice(a.indexOf(cb), 1);
        };
      },
    },
    emit(channel, payload) {
      const arr = listeners.get(channel) || [];
      for (const cb of [...arr]) cb({ payload });
    },
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
});

function assistantTexts(r) {
  return r.messages
    .filter((m) => m.kind === "assistant")
    .map((m) => (m.content ?? []).map((b) => b.text ?? "").join(""));
}

describe("reconcile recovers a dropped turn into the rendered chat", () => {
  it("a turn missing from the cache appears after reconcileLatest, in r.messages and the DOM", async () => {
    const sid = `sess-recon-${Math.random()}`;
    const bus = makeBus();
    globalThis.window.__TAURI__ = bus;

    // First open: the transcript page has only the first turn.
    invokeMock.mockResolvedValueOnce({
      events: [userEvent("hi", 0), assistantEvent("first answer", 0)],
      oldest_seq: 0,
      newest_seq: 1,
      has_more: false,
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);
    await r.attach(sid);
    await r.loadFromStore();

    // A second turn (hi again -> "the dropped answer") completed while this chat
    // was backgrounded, but its assistant frame was dropped by the lossy notifier
    // and never reached the store. The authoritative transcript HAS it.
    invokeMock.mockResolvedValueOnce({
      events: [
        userEvent("hi", 0),
        assistantEvent("first answer", 0),
        userEvent("hi again", 0),
        assistantEvent("the dropped answer", 0),
      ],
      oldest_seq: 0,
      newest_seq: 3,
      has_more: false,
    });

    // Before reconcile: the dropped answer is NOT in the rendered transcript.
    expect(assistantTexts(r)).toEqual(["first answer"]);

    // selectSession fires this on every open.
    await sessionEvents.reconcileLatest(sid);

    // After reconcile: recovered into the message model AND painted to the DOM.
    expect(assistantTexts(r)).toEqual(["first answer", "the dropped answer"]);
    expect(container.textContent).toContain("the dropped answer");
  });

  it("reconcile is a no-op (no re-render) when the cache already has the latest turn", async () => {
    const sid = `sess-recon-noop-${Math.random()}`;
    const bus = makeBus();
    globalThis.window.__TAURI__ = bus;

    invokeMock.mockResolvedValueOnce({
      events: [userEvent("hi", 0), assistantEvent("only answer", 0)],
      oldest_seq: 0,
      newest_seq: 1,
      has_more: false,
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);
    await r.attach(sid);
    await r.loadFromStore();

    // Transcript matches the cache exactly.
    invokeMock.mockResolvedValueOnce({
      events: [userEvent("hi", 0), assistantEvent("only answer", 0)],
      oldest_seq: 0,
      newest_seq: 1,
      has_more: false,
    });
    await sessionEvents.reconcileLatest(sid);

    // Still exactly one assistant message - no duplicate.
    expect(assistantTexts(r)).toEqual(["only answer"]);
  });
});
