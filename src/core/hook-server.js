"use strict";

const http = require("http");
const path = require("path");
const { Notification } = require("electron");
const { execFile } = require("child_process");

const HOOK_SERVER_PORT = 27182;

function parseHookBody(req, cb) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    try { cb(JSON.parse(Buffer.concat(chunks).toString())); }
    catch { cb(null); }
  });
}

function focusVSCodeByTitle(projectName) {
  const safe = projectName.replace(/[^a-zA-Z0-9 _\-\.]/g, "");
  const script = [
    `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class W { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); }'`,
    `$p = Get-Process -Name Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${safe}*' } | Select-Object -First 1`,
    `if (-not $p) { $p = Get-Process -Name Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1 }`,
    `if ($p) { [W]::ShowWindow($p.MainWindowHandle, 9); [W]::SetForegroundWindow($p.MainWindowHandle) }`,
  ].join("; ");
  execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true }, () => {});
}

function focusByPidChain(chain, onFail) {
  const pids = (chain || []).filter((n) => Number.isInteger(n) && n > 0);
  if (!pids.length) { onFail && onFail(); return; }
  const script = [
    `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class W { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); }'`,
    `$ids = @(${pids.join(",")})`,
    `$found = $false`,
    `foreach ($id in $ids) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { if ([W]::IsIconic($p.MainWindowHandle)) { [W]::ShowWindow($p.MainWindowHandle, 9) } else { [W]::ShowWindow($p.MainWindowHandle, 5) }; [W]::SetForegroundWindow($p.MainWindowHandle); $found = $true; break } }`,
    `if (-not $found) { exit 2 }`,
  ].join("; ");
  execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true }, (err) => {
    if (err && onFail) onFail();
  });
}

function focusVSCodeByCwd(cwd, onFail) {
  execFile("cmd", ["/c", "code", "-r", cwd], { windowsHide: true }, (err) => {
    if (err && onFail) onFail();
  });
}

function focusFromOrigin(origin, cwd) {
  const o = origin || {};
  const fallback = () => { if (cwd) focusVSCodeByTitle(path.basename(cwd)); };

  if ((o.termProgram === "vscode" || o.vscodePipe) && cwd) {
    focusVSCodeByCwd(cwd, () => focusByPidChain(o.ppidChain, fallback));
    return;
  }
  if (Array.isArray(o.ppidChain) && o.ppidChain.length) {
    focusByPidChain(o.ppidChain, fallback);
    return;
  }
  fallback();
}

function showNotification(title, body, cwd, origin) {
  try {
    const n = new Notification({ title, body });
    n.on("click", () => focusFromOrigin(origin, cwd));
    n.show();
  } catch { /* app not ready */ }
}

function getProjectName(cwd, settings) {
  const base = path.basename(cwd);
  const aliases = settings.projectAliases || {};
  const alias = aliases[cwd];
  if (alias && typeof alias === "object") return alias.name || base;
  if (alias) return alias;
  return base;
}

function createHookServer(callbacks) {
  const { onRefresh, onNotify, onQuit, getSettings, parseTranscript, appendSession, loadTokenHistory, dashboardSend, fireNotification } = callbacks;

  async function recordTokenStats(payload) {
    if (!payload?.session_id || !payload?.transcript_path) return;
    const tokens = await parseTranscript(payload.transcript_path);
    const date = new Date().toISOString().slice(0, 10);
    appendSession({ sessionId: payload.session_id, cwd: payload.cwd, date, ...tokens });
    dashboardSend("token-history-updated", loadTokenHistory());
  }

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/refresh") {
      res.writeHead(204).end();
      parseHookBody(req, (payload) => {
        if (payload && payload.cwd) {
          showNotification("Claude finished", path.basename(payload.cwd), payload.cwd, payload.origin);
        }
        const s = getSettings();
        const name = payload?.cwd ? getProjectName(payload.cwd, s) : "";
        fireNotification("workFinished", { name });
        recordTokenStats(payload).catch(console.error);
      });
      onRefresh();
    } else if (req.method === "POST" && req.url === "/notify") {
      res.writeHead(204).end();
      parseHookBody(req, (payload) => {
        if (payload && payload.cwd) {
          showNotification("Claude is waiting for your input", path.basename(payload.cwd), payload.cwd, payload.origin);
        }
        const s = getSettings();
        const name = payload?.cwd ? getProjectName(payload.cwd, s) : "";
        fireNotification("questionAsked", { name });
      });
    } else if (req.method === "POST" && req.url === "/quit") {
      res.writeHead(204).end();
      onQuit();
    } else {
      res.writeHead(404).end();
    }
  });

  server.listen(HOOK_SERVER_PORT, "127.0.0.1");
  return server;
}

module.exports = { createHookServer, HOOK_SERVER_PORT };
