// Dev-only diagnostic: surfaces uncaught errors, unhandled promise
// rejections, and Tauri invoke outcomes directly on the dashboard. Saves
// needing devtools for the common "dashboard silently stuck on Loading..."
// failure mode during the Tauri port.

(function () {
  function paint(prefix, msg) {
    try {
      const host = document.querySelector("#stats-content") || document.body;
      // Remove the stock "Loading..." once we have anything to report.
      const placeholder = host.querySelector(".no-data");
      if (placeholder && placeholder.textContent.trim() === "Loading...") {
        placeholder.remove();
      }
      const line = document.createElement("pre");
      line.style.cssText = "white-space: pre-wrap; color:#ff6b6b; font-size:11px; margin:2px 8px; font-family:ui-monospace,monospace;";
      line.textContent = `[${prefix}] ${msg}`;
      host.appendChild(line);
    } catch { /* diagnostics must never throw */ }
  }

  window.__DEBUG_PAINT__ = paint;

  window.addEventListener("error", (e) => {
    paint("ERR", `${e.message}\n  at ${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    paint("REJ", (r && (r.stack || r.message)) || String(r));
  });

  // Run as soon as the DOM is parsed so we can inspect __TAURI__ BEFORE
  // electron-api-shim.js runs its IIFE.
  window.addEventListener("DOMContentLoaded", () => {
    const t = window.__TAURI__;
    if (!t) {
      paint("BOOT", "window.__TAURI__ is undefined. Check app.withGlobalTauri in tauri.conf.json.");
      return;
    }
    const keys = Object.keys(t);
    if (!t.core || typeof t.core.invoke !== "function") {
      paint("BOOT", `__TAURI__ present but .core.invoke missing. keys=[${keys.join(",")}]`);
      return;
    }
    paint("BOOT", `__TAURI__ OK. keys=[${keys.join(",")}]`);

    // Wrap invoke so we can see which commands fail — a silent rejection is
    // the most common cause of "Loading..." sticking.
    const original = t.core.invoke;
    t.core.invoke = async function (cmd, args) {
      try {
        const result = await original.call(t.core, cmd, args);
        paint("IPC", `${cmd} -> ok`);
        return result;
      } catch (e) {
        paint("IPC", `${cmd} -> FAIL: ${(e && (e.stack || e.message)) || String(e)}`);
        throw e;
      }
    };
  });
})();
