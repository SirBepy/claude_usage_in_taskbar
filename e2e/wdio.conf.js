// WebdriverIO config for the Tauri UI smoke layer (ai_todo 67, "both layers").
//
// Windows/Linux only - tauri-driver has no macOS (WKWebView) support. Drives the
// already-built DEBUG binary, so run `cargo build` (or `cargo tauri dev` once)
// first. Run with: npm run test:e2e
//
// Scope: boot the app shell + render the Sessions view with the daemon
// connected. The daemon is spawned here with CC_DAEMON_NO_AUTOSTART so it does
// NOT launch real automation channels (which would pile up duplicate Claude
// desktop bridges every run).

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const debugDir = path.resolve(repoRoot, "src-tauri", "target", "debug");
const application = path.join(debugDir, "claude-usage-tauri.exe");
const daemonBin = path.join(debugDir, "cc-companion-daemon.exe");
const tauriDriverBin = path.resolve(os.homedir(), ".cargo", "bin", "tauri-driver.exe");
const edgeDriver = path.resolve(__dirname, "drivers", "msedgedriver.exe");
const daemonLock = path.join(os.homedir(), "AppData", "Roaming", "claude-usage-tauri", "daemon.lock");
// The debug app binary loads Tauri's devUrl (http://localhost:1420), not the
// bundled dist/. So the harness runs the vite dev server itself rather than
// requiring a slow `cargo tauri build`. Spawn vite's JS directly to skip the
// `predev` kill-stale hook (which would kill our daemon).
const viteBin = path.resolve(repoRoot, "node_modules", "vite", "bin", "vite.js");
const DEV_URL = "http://localhost:1420";

let tauriDriver;
let daemon;
let vite;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await sleep(300);
    }
  }
  throw new Error(`vite dev server not up at ${url} within ${timeoutMs}ms`);
}

export const config = {
  runner: "local",
  host: "127.0.0.1",
  port: 4444,
  // Free smoke by default. The billed chat test (reload-dup) is opt-in via
  // `npm run test:e2e:chat` (passes --spec), so the default run spawns no
  // `claude` turn.
  specs: [
    path.join(__dirname, "specs", "smoke.e2e.js"),
    path.join(__dirname, "specs", "daemon-lifecycle.e2e.js"),
  ],
  maxInstances: 1,
  capabilities: [{ "tauri:options": { application } }],
  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 120000 },
  logLevel: "warn",

  // Spawn the daemon before the app launches so the Sessions view renders from
  // its snapshot. No-autostart keeps it from spawning real automation channels.
  onPrepare: async () => {
    // 1. Vite dev server (the debug app loads it via devUrl).
    vite = spawn(process.execPath, [viteBin, "--port", "1420", "--strictPort"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    await waitForServer(DEV_URL, 30000);

    // 2. Daemon (no-autostart so it doesn't spawn real automation channels).
    try {
      if (fs.existsSync(daemonLock)) fs.rmSync(daemonLock);
    } catch (e) {
      console.warn("could not clear daemon lock:", e.message);
    }
    daemon = spawn(daemonBin, [], {
      stdio: "ignore",
      env: { ...process.env, CC_DAEMON_NO_AUTOSTART: "1" },
    });
    // Give the daemon a moment to bind its named pipe before the app connects.
    await sleep(1200);
  },
  onComplete: () => {
    if (daemon) daemon.kill();
    if (vite) vite.kill();
  },

  // tauri-driver is the WebDriver intermediary; it launches the app and proxies
  // to msedgedriver (must version-match the installed Edge/WebView2).
  beforeSession: () => {
    tauriDriver = spawn(tauriDriverBin, ["--native-driver", edgeDriver], {
      stdio: [null, process.stdout, process.stderr],
    });
  },
  afterSession: () => {
    if (tauriDriver) tauriDriver.kill();
  },
};
