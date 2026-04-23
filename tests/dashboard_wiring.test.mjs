// Regression tests for the dashboard runtime wiring.
//
// These are pure static-analysis tests over `dist/` — they do NOT run the
// app. They guard against the three categories of bugs we just fixed:
//
//   1. HTML meta CSP silently blocking Tauri IPC (dashboard stuck on
//      "Loading..." because invoke() can't reach http://ipc.localhost).
//   2. electron-api-shim.js stubs returning the wrong SHAPE (e.g.
//      backfillTranscripts returning {processed:0} and leaving the renderer
//      to interpolate `undefined skipped`).
//   3. settings.js not being loaded from dashboard.html, leaving the Version
//      label, launch-at-login, auto-update and Copy-Debug-Logs unwired.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "src");

const html = readFileSync(join(distDir, "index.html"), "utf8");

describe("dashboard.html CSP", () => {
  const cspMatch = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i
  );
  it("has a Content-Security-Policy meta tag", () => {
    expect(cspMatch).not.toBeNull();
  });

  const csp = cspMatch ? cspMatch[1] : "";
  const connectSrcMatch = csp.match(/connect-src\s+([^;]+)/);

  it("declares a connect-src directive (so default-src does not silently block IPC)", () => {
    expect(connectSrcMatch).not.toBeNull();
  });

  it("permits Tauri 2 IPC endpoints", () => {
    const sources = connectSrcMatch ? connectSrcMatch[1] : "";
    // Tauri 2 on Windows routes invoke() to http://ipc.localhost; macOS uses
    // the `ipc:` scheme. Both must be reachable.
    expect(sources).toMatch(/ipc:/);
    expect(sources).toMatch(/http:\/\/ipc\.localhost/);
  });
});

describe("dashboard.html script load order", () => {
  // Extract <script src="..."> occurrences in document order.
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);

  it("loads electron-api-shim.js before anything that uses window.electronAPI", () => {
    const shimIdx = scripts.indexOf("electron-api-shim.js");
    const dashIdx = scripts.indexOf("dashboard.js");
    expect(shimIdx).toBeGreaterThanOrEqual(0);
    expect(dashIdx).toBeGreaterThan(shimIdx);
  });

  it("loads settings.js so the Version / Copy-Logs / launch-at-login wiring runs", () => {
    // settings.js attaches listeners at top-level and via window.onload.
    // Without it, 'Version: ...' stays as the placeholder and the Copy Debug
    // Logs button has no click handler.
    expect(scripts).toContain("modules/settings.js");
  });
});

describe("electron-api-shim.js stub shapes", () => {
  // Load the shim inside a vm sandbox that fakes the Tauri globals. The IIFE
  // populates `sandbox.window.electronAPI`; we pull stubs off that.
  const shimSrc = readFileSync(join(distDir, "electron-api-shim.js"), "utf8");
  const invokeCalls = [];
  const sandbox = {
    console,
    navigator: { clipboard: { writeText: async () => {} } },
    window: {
      __TAURI__: {
        core: { invoke: async (cmd, args) => { invokeCalls.push({ cmd, args }); return null; } },
        event: { listen: async () => () => {} },
        app: { getVersion: async () => "0.1.0-test" },
        shell: { open: () => {} },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(shimSrc, sandbox);
  const api = sandbox.window.electronAPI;

  it("exposes electronAPI after IIFE runs", () => {
    expect(api).toBeTruthy();
    expect(typeof api.getUsageHistory).toBe("function");
  });

  it("backfillTranscripts invokes backfill_transcripts and returns processed/skipped", async () => {
    // Swap the invoke mock to return a real-shaped BackfillResult. Each
    // vm.runInContext re-runs the shim IIFE inside the same sandbox, which
    // rebuilds window.electronAPI against the current invoke implementation.
    sandbox.window.__TAURI__.core.invoke = async (cmd) => {
      invokeCalls.push({ cmd });
      if (cmd === "backfill_transcripts")
        return { processed: 3, skipped: 7, subProcessed: 1, subSkipped: 0 };
      return null;
    };
    invokeCalls.length = 0;
    vm.runInContext(shimSrc, sandbox);
    const api2 = sandbox.window.electronAPI;
    const r = await api2.backfillTranscripts();
    expect(invokeCalls.some((c) => c.cmd === "backfill_transcripts")).toBe(true);
    expect(r).toMatchObject({ processed: 3, skipped: 7 });
    // `${result.skipped}` must NOT interpolate to "undefined".
    expect(String(r.skipped)).not.toBe("undefined");
  });

  it("getTokenHistory and getActiveSessions return arrays so spread/iteration works", async () => {
    expect(Array.isArray(await api.getTokenHistory())).toBe(true);
    expect(Array.isArray(await api.getActiveSessions())).toBe(true);
  });

  it("syncListDevices returns array (dashboard calls .map on it)", async () => {
    expect(Array.isArray(await api.syncListDevices())).toBe(true);
  });

  it("openInExplorer invokes open_in_explorer with the path argument", async () => {
    const seen = [];
    sandbox.window.__TAURI__.core.invoke = async (cmd, args) => { seen.push({ cmd, args }); return null; };
    vm.runInContext(shimSrc, sandbox);
    await sandbox.window.electronAPI.openInExplorer("C:/proj");
    expect(seen).toContainEqual({ cmd: "open_in_explorer", args: { path: "C:/proj" } });
  });

  it("openInVSCode invokes open_in_vscode with the path argument", async () => {
    const seen = [];
    sandbox.window.__TAURI__.core.invoke = async (cmd, args) => { seen.push({ cmd, args }); return null; };
    vm.runInContext(shimSrc, sandbox);
    await sandbox.window.electronAPI.openInVSCode("C:/proj");
    expect(seen).toContainEqual({ cmd: "open_in_vscode", args: { path: "C:/proj" } });
  });

  it("checkPathsExist forwards paths to check_paths_exist and returns the map (prevents false 'dead folder' warnings)", async () => {
    const seen = [];
    sandbox.window.__TAURI__.core.invoke = async (cmd, args) => {
      seen.push({ cmd, args });
      if (cmd === "check_paths_exist") {
        return Object.fromEntries((args?.paths || []).map((p) => [p, p.includes("real")]));
      }
      return null;
    };
    vm.runInContext(shimSrc, sandbox);
    const api2 = sandbox.window.electronAPI;
    const r = await api2.checkPathsExist(["C:/real", "C:/fake"]);
    expect(r).toEqual({ "C:/real": true, "C:/fake": false });
    const call = seen.find((c) => c.cmd === "check_paths_exist");
    expect(call).toBeTruthy();
    expect(call.args).toEqual({ paths: ["C:/real", "C:/fake"] });
  });

  it("copyLogs invokes read_log_file and writes to clipboard", async () => {
    let clipboardText = null;
    sandbox.navigator.clipboard.writeText = async (t) => { clipboardText = t; };
    sandbox.window.__TAURI__.core.invoke = async (cmd) => {
      if (cmd === "read_log_file") return "hello logs";
      return null;
    };

    // Re-run the shim to pick up the new invoke mock (IIFE captures `invoke` by ref at import time).
    vm.runInContext(shimSrc, sandbox);
    const api2 = sandbox.window.electronAPI;
    await api2.copyLogs();
    expect(clipboardText).toBe("hello logs");
  });
});
