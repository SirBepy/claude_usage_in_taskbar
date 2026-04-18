"use strict";

/**
 * MVP: prove (or disprove) that claude.ai's usage API works from plain Node
 * fetch with cookies captured from a real browser session - no Electron,
 * no headless browser at scrape time.
 *
 * Flow:
 *   1. Find installed Chrome/Edge.
 *   2. Spawn it with --remote-debugging-port and a fresh profile dir.
 *   3. User logs in to claude.ai in that window.
 *   4. We poll CDP until a logged-in claude.ai tab appears.
 *   5. We pull ALL cookies (incl. httpOnly) via CDP Storage.getCookies.
 *   6. We close Chrome.
 *   7. From Node, we call /api/organizations and /api/organizations/<id>/usage
 *      with those cookies and print the result.
 *
 * Requires Node 22+ (global WebSocket) and Chrome or Edge installed.
 * Run: node scripts/test-direct-api-mvp.js
 */

const { spawn } = require("node:child_process");
const { existsSync, mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = 9222;
const DEBUG_ENDPOINT = `http://127.0.0.1:${PORT}`;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const CHROME_PATHS = {
  win32: [
    path.join(process.env["ProgramFiles"] || "", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env["LOCALAPPDATA"] || "", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
    path.join(process.env["ProgramFiles"] || "", "Microsoft/Edge/Application/msedge.exe"),
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/microsoft-edge",
  ],
};

function findBrowser() {
  const list = CHROME_PATHS[process.platform] || [];
  return list.find((p) => p && existsSync(p));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- Minimal CDP client over global WebSocket -----------------------------
function cdpCall(wsUrl, method, params = {}, timeoutMs = 10000) {
  if (typeof WebSocket === "undefined") {
    return Promise.reject(
      new Error("Node 22+ required (global WebSocket not found)."),
    );
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = Math.floor(Math.random() * 1e9);
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      reject(new Error(`CDP ${method} timed out`));
    }, timeoutMs);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id, method, params }));
    });

    ws.addEventListener("message", (ev) => {
      if (done) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== id) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    });

    ws.addEventListener("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`CDP ws error: ${e?.message || e?.type || "unknown"}`));
    });
  });
}

// ---- Chrome lifecycle -----------------------------------------------------
async function waitForDebugger() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${DEBUG_ENDPOINT}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(400);
  }
  throw new Error("Chrome debugger never came up on port " + PORT);
}

async function waitForLogin() {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let lastUrl = "";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${DEBUG_ENDPOINT}/json`);
      if (r.ok) {
        const tabs = await r.json();
        for (const t of tabs) {
          if (t.type !== "page") continue;
          const u = t.url || "";
          if (!/^https:\/\/(?:www\.)?claude\.ai\//.test(u)) continue;
          if (/\/(login|oauth|auth|signup)/.test(u)) { lastUrl = u; continue; }
          if (u !== lastUrl) {
            console.log(`   (saw claude.ai tab: ${u.slice(0, 80)})`);
            lastUrl = u;
          }
          // Confirm login by checking the cookies for a sessionKey
          const ver = await (await fetch(`${DEBUG_ENDPOINT}/json/version`)).json();
          try {
            const res = await cdpCall(ver.webSocketDebuggerUrl, "Storage.getCookies", {});
            const hasSession = (res.cookies || []).some(
              (c) => /claude\.ai$/.test(c.domain) && /session/i.test(c.name),
            );
            if (hasSession) return;
          } catch {}
        }
      }
    } catch {}
    await sleep(1500);
  }
  throw new Error("Timed out waiting for claude.ai login");
}

async function getClaudeCookies() {
  const ver = await (await fetch(`${DEBUG_ENDPOINT}/json/version`)).json();
  const res = await cdpCall(ver.webSocketDebuggerUrl, "Storage.getCookies", {});
  return (res.cookies || []).filter((c) => /claude\.ai$/.test(c.domain) || c.domain === "claude.ai");
}

function cookiesToHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function redact(s, keep = 8) {
  if (!s) return "";
  if (s.length <= keep * 2) return s.slice(0, 6) + "…";
  return s.slice(0, keep) + "…(" + s.length + "ch)…" + s.slice(-keep);
}

// ---- The actual API test --------------------------------------------------
async function testDirectApi(cookieHeader) {
  const headers = {
    cookie: cookieHeader,
    accept: "application/json",
    "accept-language": "en-US,en;q=0.9",
    referer: "https://claude.ai/settings/usage",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  };

  console.log("\n→ GET /api/organizations");
  const r1 = await fetch("https://claude.ai/api/organizations", { headers, redirect: "manual" });
  console.log("   status", r1.status);
  const body1 = await r1.text();
  if (r1.status >= 300 && r1.status < 400) {
    console.log("   location:", r1.headers.get("location"));
  }
  if (!r1.ok) {
    console.log("   body:", body1.slice(0, 600));
    return { ok: false, step: "organizations", status: r1.status, body: body1 };
  }
  let orgs;
  try { orgs = JSON.parse(body1); } catch { return { ok: false, step: "organizations-json", body: body1 }; }
  const orgId = orgs?.[0]?.uuid;
  if (!orgId) return { ok: false, step: "no-org-uuid", body: orgs };
  console.log("   org uuid:", orgId);

  const usageUrl = `https://claude.ai/api/organizations/${orgId}/usage`;
  console.log(`\n→ GET ${usageUrl}`);
  const r2 = await fetch(usageUrl, { headers, redirect: "manual" });
  console.log("   status", r2.status);
  const body2 = await r2.text();
  if (!r2.ok) {
    console.log("   body:", body2.slice(0, 800));
    return { ok: false, step: "usage", status: r2.status, body: body2 };
  }
  let usage;
  try { usage = JSON.parse(body2); } catch { return { ok: false, step: "usage-json", body: body2 }; }
  return { ok: true, orgId, usage };
}

// ---- Main ------------------------------------------------------------------
async function main() {
  const bin = findBrowser();
  if (!bin) {
    console.error("Could not find Chrome or Edge. Install one and retry.");
    process.exit(2);
  }
  console.log("Browser:", bin);

  const profileDir = mkdtempSync(path.join(os.tmpdir(), "claude-api-mvp-"));
  console.log("Fresh profile:", profileDir);

  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=PrivacySandboxSettings4",
    "https://claude.ai/login",
  ];

  const child = spawn(bin, args, { stdio: "ignore", windowsHide: false });
  child.on("error", (e) => {
    console.error("Failed to spawn browser:", e.message);
    process.exit(1);
  });

  let cleanupDone = false;
  async function cleanup() {
    if (cleanupDone) return;
    cleanupDone = true;
    console.log("\nClosing browser...");
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        try { process.kill(child.pid); } catch {}
      }
    } catch {}
    await sleep(800);
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }

  process.on("SIGINT", async () => { await cleanup(); process.exit(130); });

  try {
    console.log("\nWaiting for Chrome debugger...");
    const ver = await waitForDebugger();
    console.log("   connected:", ver.Browser);

    console.log("\n>>> Log in to claude.ai in the window that just opened. <<<");
    console.log("    (This script will detect the session automatically.)\n");
    await waitForLogin();
    console.log("Login detected.");

    const cookies = await getClaudeCookies();
    console.log(`\nCookies captured for claude.ai: ${cookies.length}`);
    for (const c of cookies) {
      console.log(`   ${c.name}  httpOnly=${c.httpOnly}  secure=${c.secure}  val=${redact(c.value)}`);
    }

    const cookieHeader = cookiesToHeader(cookies);

    // Shut the browser down BEFORE we test, so we prove the API works
    // without any browser running at all.
    await cleanup();

    const result = await testDirectApi(cookieHeader);
    const outPath = path.join(__dirname, "..", ".direct-api-test-output.json");
    writeFileSync(outPath, JSON.stringify(result, null, 2));

    console.log("\n=============================================");
    if (result.ok) {
      console.log("✅ DIRECT API WORKS — headless browser not needed.");
      console.log("---------------------------------------------");
      console.log("five_hour :", result.usage.five_hour);
      console.log("seven_day :", result.usage.seven_day);
      console.log("extra_usage:", result.usage.extra_usage);
    } else {
      console.log("❌ DIRECT API FAILED at step:", result.step);
      console.log("   status:", result.status);
    }
    console.log("=============================================");
    console.log("Full result saved to", outPath);
  } catch (e) {
    console.error("\nFAILED:", e.message);
    await cleanup();
    process.exit(1);
  }
}

main();
