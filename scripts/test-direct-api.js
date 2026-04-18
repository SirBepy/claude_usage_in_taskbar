"use strict";

/**
 * Test whether claude.ai's usage API accepts plain fetch() with captured
 * session cookies (no headless browser). If this works, we can drop Electron's
 * hidden BrowserWindow + CDP scrape.
 *
 * Usage:
 *   1. Log in to claude.ai in your browser.
 *   2. Open DevTools -> Network tab.
 *   3. Navigate to claude.ai/settings/usage.
 *   4. Find the request to /api/organizations/<uuid>/usage.
 *   5. Right-click -> Copy -> Copy as cURL (bash).
 *   6. Paste the full curl command as a single-line string into COOKIE_HEADER
 *      and HEADERS below, OR just paste the whole cURL into the CURL const
 *      and run `node scripts/test-direct-api.js --curl`.
 *
 * Node 18+ required (global fetch).
 */

const fs = require("node:fs");
const path = require("node:path");

// ---- CONFIG: fill one of these in ------------------------------------------

// Option A: paste the entire `curl '...'` command here (bash form).
// Multiline OK. We'll parse -H headers and -b / --cookie out of it.
const CURL = ``;

// Option B: paste just the Cookie header value here (everything after "cookie: ")
// and optionally add extra headers you saw in the request.
const COOKIE_HEADER = ``;
const EXTRA_HEADERS = {
  // "user-agent": "Mozilla/5.0 ...",
  // "anthropic-client-sha": "...",
  // "anthropic-client-version": "...",
};

// ----------------------------------------------------------------------------

function parseCurl(curl) {
  // Grabs -H 'name: value' / --header 'name: value' and -b / --cookie values.
  const headers = {};
  let cookie = "";
  let url = "";

  const urlMatch = curl.match(/curl\s+(?:-[A-Za-z]+\s+\S+\s+)*['"]?(https?:\/\/[^\s'"]+)['"]?/);
  if (urlMatch) url = urlMatch[1];

  const headerRe = /(?:-H|--header)\s+(['"])([\s\S]*?)\1/g;
  let m;
  while ((m = headerRe.exec(curl))) {
    const raw = m[2];
    const colon = raw.indexOf(":");
    if (colon < 0) continue;
    const name = raw.slice(0, colon).trim().toLowerCase();
    const value = raw.slice(colon + 1).trim();
    if (name === "cookie") cookie = value;
    else headers[name] = value;
  }

  const cookieRe = /(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/g;
  while ((m = cookieRe.exec(curl))) {
    cookie = m[2];
  }

  return { url, headers, cookie };
}

function redact(s, keep = 8) {
  if (!s) return "";
  if (s.length <= keep * 2) return s.slice(0, keep) + "…";
  return s.slice(0, keep) + "…" + s.slice(-keep);
}

function cookieNames(cookieStr) {
  return cookieStr
    .split(";")
    .map((p) => p.trim().split("=")[0])
    .filter(Boolean);
}

async function main() {
  let cookie = COOKIE_HEADER;
  let headers = { ...EXTRA_HEADERS };
  let urlFromCurl = "";

  if (CURL.trim()) {
    const parsed = parseCurl(CURL);
    cookie = parsed.cookie || cookie;
    headers = { ...parsed.headers, ...headers };
    urlFromCurl = parsed.url;
  }

  if (!cookie) {
    console.error(
      "No cookies provided. Paste a cURL command into CURL or set COOKIE_HEADER.\n" +
        "See the usage comment at the top of this file.",
    );
    process.exit(2);
  }

  const allHeaders = {
    accept: "application/json",
    "accept-language": "en-US,en;q=0.9",
    referer: "https://claude.ai/settings/usage",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    ...headers,
    cookie,
  };

  console.log("=== Cookies present ===");
  console.log(cookieNames(cookie).join(", "));
  console.log("=== Header count ===", Object.keys(allHeaders).length);
  console.log("=== cookie preview ===", redact(cookie, 12));
  console.log();

  // Step 1: get org list
  console.log("→ GET /api/organizations");
  const r1 = await fetch("https://claude.ai/api/organizations", { headers: allHeaders });
  console.log("   status", r1.status);
  const body1 = await r1.text();
  if (!r1.ok) {
    console.log("   body:", body1.slice(0, 400));
    process.exit(1);
  }
  let orgs;
  try {
    orgs = JSON.parse(body1);
  } catch {
    console.log("   body (not JSON):", body1.slice(0, 400));
    process.exit(1);
  }
  const orgId = orgs?.[0]?.uuid;
  console.log("   org uuid:", orgId || "(none)");
  if (!orgId) process.exit(1);

  // Step 2: get usage
  const usageUrl = `https://claude.ai/api/organizations/${orgId}/usage`;
  console.log("\n→ GET", usageUrl);
  const r2 = await fetch(usageUrl, { headers: allHeaders });
  console.log("   status", r2.status);
  const body2 = await r2.text();
  if (!r2.ok) {
    console.log("   body:", body2.slice(0, 800));
    process.exit(1);
  }

  let usage;
  try {
    usage = JSON.parse(body2);
  } catch {
    console.log("   body (not JSON):", body2.slice(0, 800));
    process.exit(1);
  }

  console.log("\n=== SUCCESS ===");
  console.log(JSON.stringify(usage, null, 2));

  // Drop a copy to disk so we can inspect later without re-running
  const outPath = path.join(__dirname, "..", ".direct-api-test-output.json");
  fs.writeFileSync(outPath, JSON.stringify({ orgId, usage, status: r2.status }, null, 2));
  console.log("\nSaved to", outPath);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
