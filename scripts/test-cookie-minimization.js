"use strict";

/**
 * Three tests in one:
 *
 *   1. EXPIRIES: print each captured cookie's TTL so we know when it dies
 *      without having to wait for it.
 *   2. MINIMIZATION: try the usage API with progressively smaller cookie
 *      subsets to find the minimum required set. Instant.
 *   3. WATCHDOG (--watch): re-poll the API every N minutes to catch real-world
 *      expiry. Only needed if you want to verify long-term stability.
 *
 * Requires a fresh login first. Run:
 *   node scripts/test-direct-api-mvp.js           (creates .captured-cookies.json)
 * then:
 *   node scripts/test-cookie-minimization.js      (minimization + expiries)
 *   node scripts/test-cookie-minimization.js --watch  (add a 1-hour watchdog)
 *
 * If .captured-cookies.json is missing, this script will spawn Chrome itself
 * and capture them (same flow as the MVP).
 */

const { spawn } = require("node:child_process");
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ROOT = path.join(__dirname, "..");
const COOKIE_CACHE = path.join(ROOT, ".captured-cookies.json");

const PORT = 9222;
const DEBUG_ENDPOINT = `http://127.0.0.1:${PORT}`;

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
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/chromium"],
};

const HEADERS_BASE = {
  accept: "application/json",
  "accept-language": "en-US,en;q=0.9",
  referer: "https://claude.ai/settings/usage",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- CDP client -----------------------------------------------------------
function cdpCall(wsUrl, method, params = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = Math.floor(Math.random() * 1e9);
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      reject(new Error(`CDP ${method} timeout`));
    }, timeoutMs);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id, method, params })));
    ws.addEventListener("message", (ev) => {
      if (done) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== id) return;
      done = true;
      clearTimeout(t);
      try { ws.close(); } catch {}
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    });
    ws.addEventListener("error", () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      reject(new Error("CDP ws error"));
    });
  });
}

function findBrowser() {
  return (CHROME_PATHS[process.platform] || []).find((p) => p && existsSync(p));
}

async function captureCookiesFresh() {
  const bin = findBrowser();
  if (!bin) throw new Error("No Chrome/Edge found");
  const profile = mkdtempSync(path.join(os.tmpdir(), "claude-api-min-"));
  console.log("Browser:", bin);
  console.log("Profile:", profile);

  const child = spawn(
    bin,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "https://claude.ai/login",
    ],
    { stdio: "ignore" },
  );

  const cleanup = async () => {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        try { process.kill(child.pid); } catch {}
      }
    } catch {}
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  };

  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${DEBUG_ENDPOINT}/json/version`);
        if (r.ok) break;
      } catch {}
      await sleep(400);
    }

    console.log("\n>>> Log in to claude.ai. Detection is automatic. <<<\n");
    const loginDeadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < loginDeadline) {
      const ver = await (await fetch(`${DEBUG_ENDPOINT}/json/version`)).json();
      try {
        const res = await cdpCall(ver.webSocketDebuggerUrl, "Storage.getCookies", {});
        const hasSession = (res.cookies || []).some(
          (c) => /claude\.ai$/.test(c.domain) && c.name === "sessionKey",
        );
        if (hasSession) {
          const cookies = res.cookies.filter(
            (c) => /claude\.ai$/.test(c.domain) || c.domain === "claude.ai",
          );
          return cookies;
        }
      } catch {}
      await sleep(1500);
    }
    throw new Error("Login timeout");
  } finally {
    await cleanup();
  }
}

// ---- Shared test --------------------------------------------------------
async function tryApi(cookies) {
  const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const headers = { ...HEADERS_BASE, cookie: header };

  const r1 = await fetch("https://claude.ai/api/organizations", {
    headers,
    redirect: "manual",
  });
  if (!r1.ok) return { ok: false, step: "orgs", status: r1.status };
  const orgs = await r1.json();
  const orgId = orgs?.[0]?.uuid;
  if (!orgId) return { ok: false, step: "no-org" };

  const r2 = await fetch(
    `https://claude.ai/api/organizations/${orgId}/usage`,
    { headers, redirect: "manual" },
  );
  if (!r2.ok) return { ok: false, step: "usage", status: r2.status };
  const usage = await r2.json();
  return { ok: true, orgId, usage };
}

function fmtExpiry(c) {
  if (c.session) return "session (dies when browser closes)";
  if (!c.expires || c.expires < 0) return "session";
  const ms = c.expires * 1000 - Date.now();
  if (ms <= 0) return "EXPIRED";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hrs = mins / 60;
  if (hrs < 48) return `${hrs.toFixed(1)} hr`;
  const days = hrs / 24;
  return `${days.toFixed(1)} days`;
}

// ---- Main ---------------------------------------------------------------
async function main() {
  const wantWatch = process.argv.includes("--watch");

  let cookies;
  if (existsSync(COOKIE_CACHE)) {
    cookies = JSON.parse(readFileSync(COOKIE_CACHE, "utf8"));
    console.log(`Loaded ${cookies.length} cookies from cache: ${COOKIE_CACHE}`);
  } else {
    console.log("No cookie cache - spawning browser to capture fresh.");
    cookies = await captureCookiesFresh();
    writeFileSync(COOKIE_CACHE, JSON.stringify(cookies, null, 2));
    console.log(`Saved ${cookies.length} cookies to ${COOKIE_CACHE}`);
  }

  // --- TEST 1: print expiries ----------------------------------------------
  console.log("\n================ COOKIE TTL REPORT ================");
  for (const c of cookies) {
    const name = c.name.padEnd(32);
    const http = c.httpOnly ? "httpOnly" : "        ";
    console.log(`  ${name} ${http}  ttl=${fmtExpiry(c)}`);
  }

  // --- TEST 2: baseline -----------------------------------------------------
  console.log("\n================ BASELINE (all cookies) ================");
  const baseline = await tryApi(cookies);
  if (!baseline.ok) {
    console.log("Baseline FAILED - session probably expired. Delete .captured-cookies.json and rerun.");
    console.log(baseline);
    process.exit(1);
  }
  console.log("  OK  five_hour.utilization =", baseline.usage.five_hour?.utilization);

  // --- TEST 3: minimization - each single cookie alone ---------------------
  console.log("\n================ EACH COOKIE ALONE ================");
  const aloneResults = [];
  for (const c of cookies) {
    const r = await tryApi([c]);
    aloneResults.push({ name: c.name, ...r });
    const icon = r.ok ? "✅" : "❌";
    const detail = r.ok ? "works alone" : `failed at ${r.step} (${r.status || "?"})`;
    console.log(`  ${icon} ${c.name.padEnd(32)} ${detail}`);
  }

  // --- TEST 4: drop each cookie individually (keep the rest) ----------------
  console.log("\n================ DROP ONE AT A TIME ================");
  const requiredByDrop = [];
  for (const c of cookies) {
    const subset = cookies.filter((x) => x.name !== c.name);
    const r = await tryApi(subset);
    const required = !r.ok;
    if (required) requiredByDrop.push(c.name);
    const icon = r.ok ? "  " : "🔑";
    const detail = r.ok ? "still works without it" : `REQUIRED (without it: ${r.step} ${r.status || "?"})`;
    console.log(`  ${icon} drop ${c.name.padEnd(28)} → ${detail}`);
  }

  console.log("\n================ SUMMARY ================");
  const singletonWinners = aloneResults.filter((r) => r.ok).map((r) => r.name);
  console.log("Cookies that work ALONE:", singletonWinners.length ? singletonWinners.join(", ") : "(none)");
  console.log("Cookies that appear STRICTLY REQUIRED (drop-one test):",
    requiredByDrop.length ? requiredByDrop.join(", ") : "(none)");

  // --- TEST 5 (optional): watchdog -----------------------------------------
  if (wantWatch) {
    const INTERVAL_MIN = 10;
    const TOTAL_MIN = 60;
    const iters = Math.floor(TOTAL_MIN / INTERVAL_MIN);
    console.log(`\n================ WATCHDOG (${iters}× every ${INTERVAL_MIN} min) ================`);
    for (let i = 0; i < iters; i++) {
      const when = new Date().toISOString();
      const r = await tryApi(cookies);
      if (r.ok) {
        console.log(`  [${when}] ✅ still works, five_hour=${r.usage.five_hour?.utilization}`);
      } else {
        console.log(`  [${when}] ❌ FAILED at ${r.step} status=${r.status} - cookies rotated!`);
        break;
      }
      if (i < iters - 1) await sleep(INTERVAL_MIN * 60 * 1000);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
