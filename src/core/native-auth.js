"use strict";

const { shell, session: electronSession, BrowserWindow } = require("electron");
const http = require("http");
const path = require("path");

const APP_ROOT = path.join(__dirname, "..", "..");

/**
 * Native browser sign-in flow.
 *
 * Opens claude.ai/login in the user's default browser, starts a localhost
 * callback server, and waits for session cookies to be transferred back
 * via a bookmarklet the user runs on claude.ai.
 *
 * The bookmarklet does two things from the claude.ai origin:
 * 1. Fetches the usage API directly (same-origin, so httpOnly cookies are sent)
 * 2. Reads document.cookie (captures non-httpOnly cookies for Electron import)
 *
 * @param {object} callbacks
 * @param {function} callbacks.onSuccess  Called with usage data after login
 * @param {function} callbacks.onCancel   Called if the user cancels or times out
 * @returns {{ cancel: function }} Handle to cancel the flow
 */
function startNativeAuth(callbacks) {
  const { onSuccess, onCancel } = callbacks;
  let server = null;
  let statusWindow = null;
  let timeoutTimer = null;
  let cancelled = false;

  const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  function cleanup() {
    cancelled = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (server) {
      try { server.close(); } catch {}
      server = null;
    }
    if (statusWindow && !statusWindow.isDestroyed()) {
      statusWindow.destroy();
      statusWindow = null;
    }
  }

  // Start localhost server on a random port
  server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      // CORS preflight for requests from claude.ai
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "https://claude.ai",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/auth/session") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "https://claude.ai",
        });
        res.end(JSON.stringify({ ok: true }));

        if (cancelled) return;
        try {
          const payload = JSON.parse(body);
          // Import whatever non-httpOnly cookies we got (best effort)
          if (payload.cookies) {
            await importCookies(payload.cookies).catch((e) =>
              console.log("[native-auth] Cookie import partial:", e.message)
            );
          }
          cleanup();
          // Pass usage data directly if the bookmarklet fetched it
          onSuccess(payload.usage || null);
        } catch (e) {
          console.error("[native-auth] Failed to process session:", e.message);
        }
      });
      return;
    }

    if (req.method === "GET" && req.url === "/auth/success") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(buildSuccessPage());
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    console.log(`[native-auth] Callback server on port ${port}`);

    // Open claude.ai login in the default browser
    shell.openExternal("https://claude.ai/login");

    // Show status window with instructions
    statusWindow = createStatusWindow(port, () => {
      if (cancelled) return;
      cleanup();
      onCancel();
    });

    // Timeout after 5 minutes
    timeoutTimer = setTimeout(() => {
      if (!cancelled) {
        console.log("[native-auth] Timed out waiting for login");
        cleanup();
        onCancel();
      }
    }, TIMEOUT_MS);
  });

  server.on("error", (e) => {
    console.error("[native-auth] Server error:", e.message);
    cleanup();
    onCancel();
  });

  return {
    cancel: () => {
      if (cancelled) return;
      cleanup();
      onCancel();
    },
  };
}

/**
 * Parses a raw cookie string from document.cookie and imports each cookie
 * into Electron's default session for the claude.ai domain.
 * Note: httpOnly cookies cannot be read by document.cookie, so this only
 * captures a subset. The primary auth mechanism uses direct API fetch.
 */
async function importCookies(cookieString) {
  if (!cookieString) return;

  const pairs = cookieString.split(";").map((s) => s.trim()).filter(Boolean);
  const ses = electronSession.defaultSession;
  let count = 0;

  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 0) continue;
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (!name) continue;

    try {
      await ses.cookies.set({
        url: "https://claude.ai",
        name,
        value,
        domain: ".claude.ai",
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "lax",
      });
      count++;
    } catch (e) {
      console.log(`[native-auth] Skipped cookie "${name}":`, e.message);
    }
  }

  console.log(`[native-auth] Imported ${count}/${pairs.length} cookies`);
}

function createStatusWindow(port, onClosed) {
  const win = new BrowserWindow({
    width: 500,
    height: 420,
    title: "Sign in to Claude",
    icon: path.join(APP_ROOT, "src", "assets", "icon.png"),
    resizable: false,
    maximizable: false,
    minimizable: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.setMenuBarVisibility(false);

  const html = buildStatusPage(port);
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  win.on("closed", () => {
    onClosed();
  });

  return win;
}

function buildStatusPage(port) {
  // The bookmarklet fetches usage data from claude.ai's API (same-origin,
  // httpOnly cookies included) and sends both the data and document.cookie
  // to our localhost callback server.
  const bookmarkletCode = `javascript:void((async function(){try{var r=await fetch('/api/organizations',{credentials:'same-origin'});var orgs=await r.json();var orgId=orgs[0]&&orgs[0].uuid;var usage=null;if(orgId){var u=await fetch('/api/organizations/'+orgId+'/usage',{credentials:'same-origin'});usage=await u.json()}await fetch('http://127.0.0.1:${port}/auth/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cookies:document.cookie,usage:usage})});window.location='http://127.0.0.1:${port}/auth/success'}catch(e){alert('Failed: '+e.message)}})())`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    background: #1a1a2e;
    color: #e0e0e0;
    padding: 32px 28px;
    user-select: none;
    -webkit-user-select: none;
  }
  h1 { font-size: 1.2rem; font-weight: 600; margin-bottom: 24px; color: #fff; }
  .step {
    display: flex;
    gap: 12px;
    margin-bottom: 18px;
    align-items: flex-start;
  }
  .step-num {
    background: #4a90e2;
    color: #fff;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 0.85rem;
    flex-shrink: 0;
  }
  .step-text {
    padding-top: 3px;
    line-height: 1.5;
    font-size: 0.9rem;
  }
  .bookmarklet-area {
    background: #2a2a4a;
    border-radius: 10px;
    padding: 16px 20px;
    margin: 20px 0 16px;
    text-align: center;
  }
  .bookmarklet-link {
    display: inline-block;
    background: #4a90e2;
    color: #fff;
    padding: 10px 24px;
    border-radius: 8px;
    text-decoration: none;
    font-weight: 600;
    font-size: 0.95rem;
    cursor: grab;
  }
  .bookmarklet-link:hover { background: #5a9ff2; }
  .hint {
    font-size: 0.78rem;
    color: #888;
    margin-top: 10px;
    line-height: 1.4;
  }
  .alt-section {
    border-top: 1px solid #333;
    margin-top: 20px;
    padding-top: 16px;
  }
  .alt-title {
    font-size: 0.8rem;
    color: #888;
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .copy-btn {
    background: #333;
    color: #e0e0e0;
    border: 1px solid #555;
    padding: 8px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.85rem;
    font-family: inherit;
  }
  .copy-btn:hover { background: #444; }
  .copy-btn.copied { background: #27ae60; border-color: #27ae60; color: #fff; }
</style>
</head>
<body>
  <h1>Sign in to Claude</h1>

  <div class="step">
    <div class="step-num">1</div>
    <div class="step-text">Log in to <strong>claude.ai</strong> in your browser (should have opened automatically)</div>
  </div>

  <div class="step">
    <div class="step-num">2</div>
    <div class="step-text">After logging in, drag the button below to your <strong>bookmarks bar</strong></div>
  </div>

  <div class="bookmarklet-area">
    <a class="bookmarklet-link" href="${bookmarkletCode.replace(/"/g, '&quot;')}">Connect to Claude Usage</a>
    <div class="hint">Drag this to your bookmarks bar, then click it while on claude.ai</div>
  </div>

  <div class="step">
    <div class="step-num">3</div>
    <div class="step-text">Click the bookmarklet while on <strong>claude.ai</strong> to transfer your session</div>
  </div>

  <div class="alt-section">
    <div class="alt-title">Alternative: paste in browser console</div>
    <button class="copy-btn" id="copyBtn" onclick="copyScript()">Copy Script</button>
    <div class="hint" style="margin-top: 8px;">
      Press F12 on claude.ai, go to Console tab, paste and press Enter
    </div>
  </div>

  <script>
    const script = \`(async()=>{try{var r=await fetch('/api/organizations',{credentials:'same-origin'});var orgs=await r.json();var orgId=orgs[0]&&orgs[0].uuid;var usage=null;if(orgId){var u=await fetch('/api/organizations/'+orgId+'/usage',{credentials:'same-origin'});usage=await u.json()}await fetch('http://127.0.0.1:${port}/auth/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cookies:document.cookie,usage:usage})});location='http://127.0.0.1:${port}/auth/success'}catch(e){alert('Failed: '+e.message)}})()\`;

    function copyScript() {
      navigator.clipboard.writeText(script).then(() => {
        const btn = document.getElementById('copyBtn');
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'Copy Script';
          btn.classList.remove('copied');
        }, 2000);
      });
    }
  </script>
</body>
</html>`;
}

function buildSuccessPage() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {
    font-family: 'Segoe UI', system-ui, sans-serif;
    background: #1a1a2e;
    color: #e0e0e0;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    margin: 0;
    text-align: center;
  }
  .container { max-width: 400px; padding: 40px; }
  .check { font-size: 4rem; margin-bottom: 16px; }
  h1 { font-size: 1.3rem; font-weight: 600; margin-bottom: 8px; color: #27ae60; }
  p { color: #999; font-size: 0.9rem; }
</style>
</head>
<body>
  <div class="container">
    <div class="check">&#10003;</div>
    <h1>Connected!</h1>
    <p>Session transferred to Claude Usage. You can close this tab.</p>
  </div>
</body>
</html>`;
}

module.exports = { startNativeAuth };
