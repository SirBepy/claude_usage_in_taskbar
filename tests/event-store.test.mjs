import { describe, it, expect, beforeEach, vi } from "vitest";
import { userEvent, assistantEvent } from "./helpers/chat-events.mjs";

const invokeMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

beforeEach(() => {
  invokeMock.mockReset();
  globalThis.window = globalThis.window || {};
  globalThis.window.__TAURI__ = undefined;
});

const { sessionEvents } = await import("../src/shared/chat/event-store.ts");

describe("SessionEventStore pagination", () => {
  it("loadInitial caches and is idempotent", async () => {
    invokeMock.mockResolvedValueOnce({
      events: [userEvent("u1", 1), assistantEvent("a1", 2)],
      oldest_seq: 0,
      newest_seq: 1,
      has_more: false,
    });
    const sid = "sess-cache-1";
    const first = await sessionEvents.loadInitial(sid);
    expect(first).toHaveLength(2);
    const second = await sessionEvents.loadInitial(sid);
    expect(second).toBe(first);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("loadOlder prepends and updates oldestSeq", async () => {
    invokeMock
      .mockResolvedValueOnce({
        events: [userEvent("u3", 3), assistantEvent("a3", 4)],
        oldest_seq: 4,
        newest_seq: 5,
        has_more: true,
      })
      .mockResolvedValueOnce({
        events: [userEvent("u1", 1), assistantEvent("a1", 2)],
        oldest_seq: 0,
        newest_seq: 3,
        has_more: false,
      });
    const sid = "sess-prepend-1";
    await sessionEvents.loadInitial(sid);
    const older = await sessionEvents.loadOlder(sid);
    expect(older).not.toBeNull();
    expect(older).toHaveLength(2);
    const all = sessionEvents.events(sid);
    expect(all).toHaveLength(4);
    expect(all[0].content[0].text).toBe("u1");
    expect(all[3].content[0].text).toBe("a3");
  });

  it("loadOlder is single-flight under concurrent calls", async () => {
    let resolveInitial = () => {};
    invokeMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInitial = resolve;
      })
    );
    const sid = "sess-single-1";
    const initialPromise = sessionEvents.loadInitial(sid);
    resolveInitial({
      events: [userEvent("u3", 3)],
      oldest_seq: 3,
      newest_seq: 3,
      has_more: true,
    });
    await initialPromise;

    let resolveOlder = () => {};
    invokeMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOlder = resolve;
      })
    );
    const a = sessionEvents.loadOlder(sid);
    const b = sessionEvents.loadOlder(sid);
    resolveOlder({
      events: [userEvent("u1", 1)],
      oldest_seq: 0,
      newest_seq: 2,
      has_more: false,
    });
    const [aRes, bRes] = await Promise.all([a, b]);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(aRes).not.toBeNull();
    expect(bRes).toBeNull();
  });

  it("loadInitial drops pre-fetch synthetic/live events the JSONL page covers (ai_todo 65 reload dup)", async () => {
    const sid = "sess-reload-dup";
    // Optimistic echoes shown during the live turn carry real Date.now() ms;
    // the old timestamp filter let them survive on top of the JSONL copy.
    sessionEvents.pushSynthetic(sid, userEvent("hello", Date.now()));
    sessionEvents.pushSynthetic(sid, assistantEvent("hi there", Date.now()));
    // Authoritative JSONL page contains the same turn (ISO->0 timestamps).
    invokeMock.mockResolvedValueOnce({
      events: [userEvent("hello", 0), assistantEvent("hi there", 0)],
      oldest_seq: 0,
      newest_seq: 1,
      has_more: false,
    });
    const events = await sessionEvents.loadInitial(sid);
    expect(events).toHaveLength(2);
    expect(events.filter((e) => e.type === "user_message")).toHaveLength(1);
    expect(events.filter((e) => e.type === "assistant_message")).toHaveLength(1);
  });

  it("loadInitial keeps live events that stream in during the fetch", async () => {
    const sid = "sess-reload-during";
    sessionEvents.pushSynthetic(sid, userEvent("u1", Date.now())); // covered by page
    // The mock body runs after loadInitial snapshots the pre-fetch buffer, so a
    // push here simulates an event streaming in DURING the fetch (not yet in
    // the page) - it must survive the merge.
    invokeMock.mockImplementationOnce(async () => {
      sessionEvents.pushSynthetic(sid, assistantEvent("live-during", Date.now()));
      return { events: [userEvent("u1", 0)], oldest_seq: 0, newest_seq: 0, has_more: false };
    });
    const events = await sessionEvents.loadInitial(sid);
    expect(events.map((e) => e.content[0].text)).toEqual(["u1", "live-during"]);
  });

  it("loadOlder returns null when hasMore is false", async () => {
    invokeMock.mockResolvedValueOnce({
      events: [userEvent("u1", 1)],
      oldest_seq: 0,
      newest_seq: 0,
      has_more: false,
    });
    const sid = "sess-no-more-1";
    await sessionEvents.loadInitial(sid);
    const older = await sessionEvents.loadOlder(sid);
    expect(older).toBeNull();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
