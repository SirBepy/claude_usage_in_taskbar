"use strict";

const { BrowserWindow } = require("electron");

/**
 * Fetches usage data by loading https://claude.ai/settings/usage in a hidden
 * window and intercepting the /api/organizations/.../usage network response
 * via the Chrome DevTools Protocol. The page handles auth automatically using
 * the current Electron session cookies — no manual auth headers needed.
 *
 * Resolves with the parsed usage JSON, or rejects with:
 *   - Error("HTTP 401") / Error("HTTP 403") on auth failure
 *   - Error("Timed out ...") if the page doesn't respond within 20 s
 */
function fetchUsageFromPage() {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    let settled = false;
    function settle(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { win.destroy(); } catch {}
      fn();
    }

    const timer = setTimeout(
      () => settle(() => reject(new Error("Timed out loading usage page"))),
      20000,
    );

    // Log every navigation so we can see the full redirect chain.
    win.webContents.on("did-navigate", (_, url) => {
      console.log(`[scraper] did-navigate → ${url}`);
      if (/\/(login|auth|sso)/i.test(url)) {
        console.log("[scraper] detected auth redirect — session invalid");
        settle(() => reject(new Error("HTTP 401")));
      }
    });

    win.webContents.on("did-navigate-in-page", (_, url) => {
      console.log(`[scraper] did-navigate-in-page → ${url}`);
    });

    try {
      win.webContents.debugger.attach("1.3");
    } catch (e) {
      console.error("[scraper] debugger.attach failed:", e.message);
      settle(() => reject(e));
      return;
    }

    // .catch() is required — when settle() destroys the window, any in-flight
    // CDP commands reject with "target closed"; without a handler that becomes
    // an UnhandledPromiseRejectionWarning.
    win.webContents.debugger.sendCommand("Network.enable").catch(e => {
      console.error("[scraper] Network.enable failed:", e.message);
    });

    win.webContents.debugger.on("message", async (_, method, params) => {
      // Log every network response to see what the page loads.
      if (method === "Network.responseReceived") {
        console.log(`[scraper] network ${params.response.status} ${params.response.url}`);
      }

      if (settled) return;
      if (method !== "Network.responseReceived") return;

      const url = params.response.url;
      if (!url.includes("/api/organizations/") || !url.includes("/usage")) return;

      const status = params.response.status;
      console.log(`[scraper] >>> matched usage endpoint: ${status} ${url}`);

      if (status === 401 || status === 403) {
        settle(() => reject(new Error(`HTTP ${status}`)));
        return;
      }

      if (status === 200) {
        try {
          const { body } = await win.webContents.debugger.sendCommand(
            "Network.getResponseBody",
            { requestId: params.requestId },
          );
          const parsed = JSON.parse(body);
          console.log("[scraper] usage response:\n" + JSON.stringify(parsed, null, 2));
          settle(() => resolve(parsed));
        } catch (e) {
          console.error("[scraper] getResponseBody failed:", e.message);
          settle(() => reject(e));
        }
      }
    });

    win.loadURL("https://claude.ai/settings/usage");
  });
}

module.exports = { fetchUsageFromPage };
