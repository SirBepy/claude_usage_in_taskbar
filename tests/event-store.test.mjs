import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

beforeEach(() => {
  invokeMock.mockReset();
  globalThis.window = globalThis.window || {};
  globalThis.window.__TAURI__ = undefined;
});

const { sessionEvents } = await import("../src/shared/chat/event-store.ts");

function userEvent(text, ts = 0) {
  return { type: "user_message", content: [{ type: "text", text }], timestamp: ts };
}
function assistantEvent(text, ts = 0) {
  return { type: "assistant_message", content: [{ type: "text", text }], streaming: false, timestamp: ts };
}

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
