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
      try {
        win.destroy();
      } catch {}
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

    try {
      win.webContents.debugger.attach("1.3");
    } catch (e) {
      console.error("[scraper] debugger.attach failed:", e.message);
      settle(() => reject(e));
      return;
    }

    // Use the Fetch domain (not Network) so the response is paused before the
    // page consumes it — this guarantees Fetch.getResponseBody always succeeds.
    // .catch() is required: when settle() destroys the window, any in-flight
    // CDP commands reject with "target closed", which would be unhandled otherwise.
    win.webContents.debugger
      .sendCommand("Fetch.enable", {
        patterns: [
          {
            urlPattern: "*/api/organizations/*/usage",
            requestStage: "Response",
          },
        ],
      })
      .catch((e) => {
        console.error("[scraper] Fetch.enable failed:", e.message);
      });

    win.webContents.debugger.on("message", async (_, method, params) => {
      if (settled) return;
      if (method !== "Fetch.requestPaused") return;

      const url = params.request.url;
      const status = params.responseStatusCode;
      console.log(`[scraper] ${status} ${url}`);

      // Always continue the request so the page doesn't hang, regardless of outcome.
      const continueRequest = () =>
        win.webContents.debugger
          .sendCommand("Fetch.continueRequest", {
            requestId: params.requestId,
          })
          .catch(() => {});

      if (status === 401 || status === 403) {
        await continueRequest();
        settle(() => reject(new Error(`HTTP ${status}`)));
        return;
      }

      if (status === 200) {
        try {
          const { body, base64Encoded } =
            await win.webContents.debugger.sendCommand(
              "Fetch.getResponseBody",
              { requestId: params.requestId },
            );
          await continueRequest();
          const text = base64Encoded
            ? Buffer.from(body, "base64").toString()
            : body;
          const parsed = JSON.parse(text);
          settle(() => resolve(parsed));
        } catch (e) {
          console.error("[scraper] getResponseBody failed:", e.message);
          await continueRequest();
          settle(() => reject(e));
        }
      } else {
        await continueRequest();
      }
    });

    win.loadURL("https://claude.ai/settings/usage");
  });
}

module.exports = { fetchUsageFromPage };
