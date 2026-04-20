// Regression test for the Electron → Tauri history shape mismatch that
// caused "cannot read properties of undefined (reading 'split')" in the real
// app. The renderer (dashboard.js, chart.js) reads the LEGACY Electron
// fields: { hour, session_pct, weekly_pct, session_resets_at,
// weekly_resets_at }. The Rust backend returns the NEW shape:
// { captured_at, five_hour:{utilization,resets_at}, seven_day:{...} }.
// electron-api-shim.js must translate between them.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const shimSrc = readFileSync(
  join(__dirname, "..", "dist", "electron-api-shim.js"),
  "utf8"
);

function makeSandboxWithHistory(snapshots) {
  const sandbox = {
    console,
    navigator: { clipboard: { writeText: async () => {} } },
    window: {
      __TAURI__: {
        core: {
          invoke: async (cmd) => {
            if (cmd === "get_history") return snapshots;
            return null;
          },
        },
        event: { listen: async () => () => {} },
        app: { getVersion: async () => "0.1.0-test" },
        shell: { open: () => {} },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(shimSrc, sandbox);
  return sandbox;
}

describe("getUsageHistory shape translation", () => {
  it("maps UsageSnapshot fields to the legacy renderer shape", async () => {
    const tauriShape = [
      {
        captured_at: "2026-04-19T15:30:00Z",
        five_hour: { utilization: 37.4, resets_at: "2026-04-19T20:00:00Z" },
        seven_day: { utilization: 12.0, resets_at: "2026-04-23T23:00:00Z" },
        extra_usage: null,
      },
    ];
    const { window } = makeSandboxWithHistory(tauriShape);
    const h = await window.electronAPI.getUsageHistory();

    expect(Array.isArray(h)).toBe(true);
    expect(h).toHaveLength(1);
    const r = h[0];

    // The renderer calls r.hour.split("T") — must be a string matching the
    // hourToMs() parse format "YYYY-MM-DDTHH" or "YYYY-MM-DDTHH:MM".
    expect(typeof r.hour).toBe("string");
    expect(r.hour).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}(:\d{2})?$/);

    expect(r.session_pct).toBe(37); // Math.round(37.4)
    expect(r.weekly_pct).toBe(12);
    expect(r.session_resets_at).toBe("2026-04-19T20:00:00Z");
    expect(r.weekly_resets_at).toBe("2026-04-23T23:00:00Z");
  });

  it("filters out malformed snapshots instead of propagating undefined fields", async () => {
    const tauriShape = [
      null,
      { captured_at: "2026-04-19T15:00:00Z" /* missing five_hour */ },
      {
        captured_at: "2026-04-19T16:00:00Z",
        five_hour: { utilization: 1, resets_at: "x" },
        seven_day: { utilization: 1, resets_at: "y" },
      },
    ];
    const { window } = makeSandboxWithHistory(tauriShape);
    const h = await window.electronAPI.getUsageHistory();
    expect(h).toHaveLength(1);
    expect(h[0].session_pct).toBe(1);
  });

  it("handles empty backend history", async () => {
    const { window } = makeSandboxWithHistory([]);
    const h = await window.electronAPI.getUsageHistory();
    expect(h).toEqual([]);
  });
});
