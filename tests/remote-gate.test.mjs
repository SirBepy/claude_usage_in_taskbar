import { describe, it, expect, beforeEach, vi } from "vitest";

// remote-gate.ts exports ensureRemoteToken() which:
//   - returns true  when window.__TAURI__ is present (Tauri webview)
//   - returns true  when localStorage[REMOTE_TOKEN_KEY] is non-empty
//   - returns false when no token is present AND renders the gate form

// We stub localStorage and document minimally since this runs in node-env.

function makeLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

// Minimal document stub: captures appended children without real DOM.
function makeDocument() {
  const children = [];
  return {
    _children: children,
    createElement: (tag) => {
      const el = {
        tag,
        style: { cssText: "" },
        id: "",
        type: "",
        placeholder: "",
        autocomplete: "",
        spellcheck: false,
        textContent: "",
        _children: [],
        _listeners: {},
        addEventListener: (ev, fn) => {
          el._listeners[ev] = fn;
        },
        appendChild: (child) => el._children.push(child),
        append: (...items) => items.forEach((i) => el._children.push(i)),
        focus: () => {},
        click: () => {},
        value: "",
      };
      return el;
    },
    body: {
      _children: children,
      appendChild: (child) => children.push(child),
    },
  };
}

const REMOTE_TOKEN_KEY = "rc_token";

beforeEach(() => {
  // Reset module cache so each test gets a fresh import.
  vi.resetModules();
});

describe("ensureRemoteToken - Tauri webview (NO-OP path)", () => {
  it("returns true immediately when window.__TAURI__ is present", async () => {
    globalThis.window = { __TAURI__: { core: {} } };
    globalThis.localStorage = makeLocalStorage(); // no token
    globalThis.document = makeDocument();

    const { ensureRemoteToken } = await import("../src/shared/remote-gate.ts");
    expect(ensureRemoteToken()).toBe(true);
    // Gate form must NOT have been added.
    expect(globalThis.document._children).toHaveLength(0);
  });
});

describe("ensureRemoteToken - browser with token present", () => {
  it("returns true when localStorage has a non-empty token", async () => {
    globalThis.window = {}; // no __TAURI__
    globalThis.localStorage = makeLocalStorage({ [REMOTE_TOKEN_KEY]: "my-secret-token" });
    globalThis.document = makeDocument();

    const { ensureRemoteToken } = await import("../src/shared/remote-gate.ts");
    expect(ensureRemoteToken()).toBe(true);
    expect(globalThis.document._children).toHaveLength(0);
  });

  it("returns true when token is present even if it contains spaces (trimmed)", async () => {
    globalThis.window = {};
    globalThis.localStorage = makeLocalStorage({ [REMOTE_TOKEN_KEY]: "  tok  " });
    globalThis.document = makeDocument();

    const { ensureRemoteToken } = await import("../src/shared/remote-gate.ts");
    expect(ensureRemoteToken()).toBe(true);
  });
});

describe("ensureRemoteToken - browser with NO token", () => {
  it("returns false when localStorage has no token", async () => {
    globalThis.window = {};
    globalThis.localStorage = makeLocalStorage(); // empty
    globalThis.document = makeDocument();
    // stub setTimeout so the focus() call doesn't hang in node
    globalThis.setTimeout = (fn, _ms) => { try { fn(); } catch {} return 0; };

    const { ensureRemoteToken } = await import("../src/shared/remote-gate.ts");
    const result = ensureRemoteToken();
    expect(result).toBe(false);
  });

  it("appends the gate overlay to document.body when no token", async () => {
    globalThis.window = {};
    globalThis.localStorage = makeLocalStorage();
    const doc = makeDocument();
    globalThis.document = doc;
    globalThis.setTimeout = (fn, _ms) => { try { fn(); } catch {} return 0; };

    const { ensureRemoteToken } = await import("../src/shared/remote-gate.ts");
    ensureRemoteToken();

    expect(doc._children).toHaveLength(1);
    expect(doc._children[0].id).toBe("rc-token-gate");
  });

  it("does not throw even when localStorage is unavailable", async () => {
    globalThis.window = {};
    // Simulate a broken localStorage that throws on getItem.
    globalThis.localStorage = {
      getItem: () => { throw new Error("storage disabled"); },
      setItem: () => {},
      removeItem: () => {},
    };
    globalThis.document = makeDocument();
    globalThis.setTimeout = () => 0;

    const { ensureRemoteToken } = await import("../src/shared/remote-gate.ts");
    // When storage is broken, gate treats it as safe-to-proceed (returns true).
    expect(() => ensureRemoteToken()).not.toThrow();
    expect(ensureRemoteToken()).toBe(true);
  });
});

describe("HttpTransport get_settings safe default", () => {
  it("returns null for get_settings instead of throwing RemoteUnavailableError", async () => {
    globalThis.window = {};
    globalThis.localStorage = makeLocalStorage({ [REMOTE_TOKEN_KEY]: "tok" });

    const { HttpTransport } = await import("../src/shared/transport.ts");
    const t = new HttpTransport();
    // Should resolve to null, not reject.
    const result = await t.call("get_settings");
    expect(result).toBeNull();
  });
  // get_history is no longer a safe-default stub: it forwards to the daemon's
  // rpc (usage history from the shared db). That forwarding is covered in
  // tests/transport-http.test.mjs with a mocked fetch.
});
