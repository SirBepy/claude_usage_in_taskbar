import { describe, it, expect, vi } from "vitest";
import { wireInitialFetches } from "../src/shared/initial-render-gate.ts";

// Let queued .then/.catch/.finally microtasks settle.
const flush = () => new Promise((r) => setTimeout(r, 0));

function baseDeps(overrides = {}) {
  return {
    fetchUsage: () => Promise.resolve([]),
    fetchTokens: () => Promise.resolve([]),
    fetchSettings: () => Promise.resolve(null),
    onUsage: () => {},
    onTokens: () => {},
    onSettings: () => {},
    onReady: () => {},
    ...overrides,
  };
}

describe("wireInitialFetches render gate", () => {
  it("fires onReady once all three fetches resolve", async () => {
    const onReady = vi.fn();
    wireInitialFetches(baseDeps({ onReady }));
    await flush();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  // The white-screen-on-startup regression: a cold-boot token-history RPC
  // failure (daemon not up yet) must NOT wedge the gate. Pre-fix, the token
  // fetch had no .catch, so its slot was never marked and onReady never fired,
  // leaving a permanent blank window.
  it("still fires onReady when the token-history fetch REJECTS", async () => {
    const onReady = vi.fn();
    const onTokens = vi.fn();
    wireInitialFetches(
      baseDeps({
        fetchTokens: () => Promise.reject(new Error("daemon not up")),
        onTokens,
        onReady,
      }),
    );
    await flush();
    expect(onReady).toHaveBeenCalledTimes(1);
    // The failed fetch's data callback must not run.
    expect(onTokens).not.toHaveBeenCalled();
  });

  it("opens the gate even if every fetch rejects", async () => {
    const onReady = vi.fn();
    wireInitialFetches(
      baseDeps({
        fetchUsage: () => Promise.reject(new Error("x")),
        fetchTokens: () => Promise.reject(new Error("y")),
        fetchSettings: () => Promise.reject(new Error("z")),
        onReady,
      }),
    );
    await flush();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("does not fire onReady until the slowest fetch settles", async () => {
    const onReady = vi.fn();
    let resolveSettings;
    wireInitialFetches(
      baseDeps({
        fetchSettings: () => new Promise((r) => { resolveSettings = r; }),
        onReady,
      }),
    );
    await flush();
    expect(onReady).not.toHaveBeenCalled(); // settings still pending
    resolveSettings(null);
    await flush();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("runs each success data callback with the fetched value", async () => {
    const onUsage = vi.fn();
    const onTokens = vi.fn();
    const onSettings = vi.fn();
    const usage = [{ a: 1 }];
    const tokens = [{ t: 2 }];
    const settings = { theme: "void" };
    wireInitialFetches(
      baseDeps({
        fetchUsage: () => Promise.resolve(usage),
        fetchTokens: () => Promise.resolve(tokens),
        fetchSettings: () => Promise.resolve(settings),
        onUsage,
        onTokens,
        onSettings,
      }),
    );
    await flush();
    expect(onUsage).toHaveBeenCalledWith(usage);
    expect(onTokens).toHaveBeenCalledWith(tokens);
    expect(onSettings).toHaveBeenCalledWith(settings);
  });
});
