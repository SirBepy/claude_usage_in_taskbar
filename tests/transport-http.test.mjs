import { describe, it, expect, beforeEach, vi } from "vitest";

// HttpTransport is the browser/phone transport: it maps frontend command names
// onto the daemon's remote-access REST/WS server (see src/shared/transport.ts).
// Node env has no DOM globals, so we stub the few it touches.

const {
  HttpTransport,
  getTransport,
  resetTransportForTests,
  RemoteUnavailableError,
  REMOTE_TOKEN_KEY,
} = await import("../src/shared/transport.ts");

let lastWs;
class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.close = vi.fn();
    lastWs = this;
  }
}

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  lastWs = undefined;
  globalThis.fetch = fetchMock;
  globalThis.WebSocket = MockWebSocket;
  globalThis.localStorage = makeLocalStorage();
  globalThis.location = { protocol: "https:", host: "pc.tail.ts.net" };
  globalThis.window = {};
  globalThis.localStorage.setItem(REMOTE_TOKEN_KEY, "tok123");
  resetTransportForTests();
});

/** Parsed JSON body of the Nth fetch call. */
function body(n = 0) {
  return JSON.parse(fetchMock.mock.calls[n][1].body);
}
function url(n = 0) {
  return fetchMock.mock.calls[n][0];
}
function headers(n = 0) {
  return fetchMock.mock.calls[n][1].headers;
}

describe("getTransport selection", () => {
  it("returns HttpTransport when window.__TAURI__ is absent", () => {
    expect(getTransport()).toBeInstanceOf(HttpTransport);
  });

  it("returns the Tauri transport (delegates to core.invoke) when __TAURI__ exists", async () => {
    const invoke = vi.fn().mockResolvedValue("ok");
    globalThis.window = { __TAURI__: { core: { invoke } } };
    resetTransportForTests();
    const res = await getTransport().call("some_command", { a: 1 });
    expect(invoke).toHaveBeenCalledWith("some_command", { a: 1 });
    expect(res).toBe("ok");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("HttpTransport.call mapping", () => {
  it("forwards list_instances to /api/rpc with null params and the bearer token", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [{ session_id: "s" }] });
    const out = await new HttpTransport().call("list_instances");
    expect(url()).toBe("/api/rpc");
    expect(body()).toEqual({ method: "list_instances", params: null });
    expect(headers().Authorization).toBe("Bearer tok123");
    expect(out).toEqual([{ session_id: "s" }]);
  });

  it("reshapes respond_permission (deny) to request_id/allow", async () => {
    await new HttpTransport().call("respond_permission", {
      id: "req-1",
      behavior: "deny",
      message: "nope",
    });
    expect(body()).toEqual({
      method: "respond_permission",
      params: { request_id: "req-1", allow: false, message: "nope" },
    });
  });

  it("reshapes respond_permission (allow) carrying updatedInput", async () => {
    await new HttpTransport().call("respond_permission", {
      id: "req-2",
      behavior: "allow",
      updatedInput: { command: "ls" },
    });
    expect(body().params).toEqual({
      request_id: "req-2",
      allow: true,
      updated_input: { command: "ls" },
    });
  });

  it("reshapes respond_question to request_id/answers", async () => {
    await new HttpTransport().call("respond_question", {
      id: "q-1",
      answers: { color: "blue" },
    });
    expect(body()).toEqual({
      method: "respond_question",
      params: { request_id: "q-1", answers: { color: "blue" } },
    });
  });

  it("send_message joins text blocks (dropping images) and hits the dedicated endpoint", async () => {
    const out = await new HttpTransport().call("send_message", {
      sessionId: "sess-9",
      cwd: "/x",
      blocks: [
        { type: "text", text: "hello" },
        { type: "image", mime: "image/png", data: "..." },
        { type: "text", text: "world" },
      ],
    });
    expect(url()).toBe("/api/sessions/sess-9/send");
    expect(body()).toEqual({ text: "hello\nworld" });
    expect(out).toBe("sess-9");
  });

  it("cancel_turn maps sessionId -> session_id", async () => {
    await new HttpTransport().call("cancel_turn", { sessionId: "sess-3" });
    expect(body()).toEqual({ method: "cancel_turn", params: { session_id: "sess-3" } });
  });

  it("throws RemoteUnavailableError for commands with no remote path", async () => {
    await expect(new HttpTransport().call("load_history_page", {})).rejects.toBeInstanceOf(
      RemoteUnavailableError,
    );
    await expect(new HttpTransport().call("get_settings")).rejects.toBeInstanceOf(
      RemoteUnavailableError,
    );
  });

  it("throws on a non-ok HTTP response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
    await expect(new HttpTransport().call("list_instances")).rejects.toThrow("403");
  });
});

describe("HttpTransport.listen", () => {
  it("opens an authed per-session WebSocket for chat:<id> and delivers parsed payloads", async () => {
    const received = [];
    const unlisten = await new HttpTransport().listen("chat:abc-123", (p) => received.push(p));
    expect(lastWs.url).toBe(
      "wss://pc.tail.ts.net/api/sessions/abc-123/stream?token=tok123",
    );
    lastWs.onmessage({ data: JSON.stringify({ type: "assistant_message" }) });
    lastWs.onmessage({ data: "not json" }); // ignored, no throw
    expect(received).toEqual([{ type: "assistant_message" }]);
    unlisten();
    expect(lastWs.close).toHaveBeenCalledTimes(1);
    unlisten(); // idempotent
    expect(lastWs.close).toHaveBeenCalledTimes(1);
  });

  it("no-ops (no WebSocket) for non per-session channels", async () => {
    const unlisten = await new HttpTransport().listen("instances-changed", () => {});
    expect(lastWs).toBeUndefined();
    expect(() => unlisten()).not.toThrow();
  });
});
