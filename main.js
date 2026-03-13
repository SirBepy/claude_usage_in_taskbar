"use strict";

const { app, BrowserWindow, Tray, Menu, ipcMain } = require("electron");
const path = require("path");
const http = require("http");

app.name = "Claude Usage Taskbar Tool";

// Disable hardware acceleration to save memory (prevents the GPU-process from spawning)
app.disableHardwareAcceleration();

// ── Hook server (Claude Code Stop hook → POST /refresh) ───────────────────────
const HOOK_SERVER_PORT = 27182;
const hookServer = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/refresh") {
    res.writeHead(204).end();
    refreshWithAnimation().catch(console.error);
  } else {
    res.writeHead(404).end();
  }
});
hookServer.listen(HOOK_SERVER_PORT, "127.0.0.1");

const { makeIcon, makeSpinFrame } = require("./src/icon");
const {
  parseSessionPct,
  parseWeeklyPct,
  buildTooltip,
} = require("./src/usage-parser");
const { fetchUsageFromPage } = require("./src/scraper");
const { clearClaudeCookies } = require("./src/session");
const { loadSettings, saveSettings } = require("./src/settings");
const {
  setupAutoUpdater,
  getUpdateState,
  quitAndInstall,
} = require("./src/updater");

// ── Single instance ───────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on("second-instance", () => {
  loginWindow?.focus();
});

// ── State ─────────────────────────────────────────────────────────────────────
let tray = null;
let loginWindow = null;
let pollTimer = null;
let spinTimer = null;
let usageData = null;
let loggedIn = false;
let settingsVisible = false;
let settingsWindow = null;
let settings = loadSettings();

const POLL_MS = 60 * 60 * 1000;

// ── Usage fetching ────────────────────────────────────────────────────────────
async function fetchUsage() {
  try {
    return await fetchUsageFromPage();
  } catch (e) {
    if (/HTTP 40[13]/.test(e.message)) {
      await handleAuthFailure();
      throw new Error("Session expired — showing login");
    }
    throw e;
  }
}

async function handleAuthFailure() {
  loggedIn = false;
  stopPolling();
  const loginInProgress = loginWindow && !loginWindow.isDestroyed();
  if (!loginInProgress) await clearClaudeCookies();
  showLoginWindow();
}

// ── Polling ───────────────────────────────────────────────────────────────────
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => refresh().catch(console.error), POLL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function refresh() {
  try {
    usageData = await fetchUsage();
    loggedIn = true;
    updateTray();
  } catch (e) {
    console.error("Refresh failed:", e.message);
  }
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function updateTray() {
  if (!tray) return;
  tray.setImage(
    makeIcon(parseSessionPct(usageData), parseWeeklyPct(usageData), settings),
  );
  tray.setToolTip(buildTooltip(usageData, settings));
}

/**
 * Animates the outer ring as a spinning blue arc while a refresh is in flight.
 * The inner ring stays at the last known weekly value.
 * Stops automatically once the refresh promise settles.
 */
async function refreshWithAnimation() {
  if (spinTimer) return; // already refreshing

  let frame = 0;
  const weeklyPct = parseWeeklyPct(usageData);

  spinTimer = setInterval(() => {
    tray?.setImage(makeSpinFrame(frame++, weeklyPct, settings));
  }, 50);

  try {
    await refresh();
  } finally {
    clearInterval(spinTimer);
    spinTimer = null;
    updateTray(); // snap to real data
  }
}

function buildContextMenu() {
  const { state, version } = getUpdateState();

  const template = [
    { label: "Refresh", click: () => refreshWithAnimation() },
    { type: "separator" },
    {
      label: "Settings",
      click: showSettingsWindow,
    },
    { type: "separator" },
    loggedIn
      ? { label: "Log Out", click: logout }
      : { label: "Log In", click: showLoginWindow },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ];

  if (state === "downloaded") {
    template.unshift(
      { label: `Restart to update to v${version}`, click: quitAndInstall },
      { type: "separator" },
    );
  } else if (state === "available") {
    template.unshift(
      { label: `Downloading update v${version}…`, enabled: false },
      { type: "separator" },
    );
  }

  return Menu.buildFromTemplate(template);
}

function createTray() {
  tray = new Tray(makeIcon(null, null, settings));
  tray.setToolTip("Claude Usage — Initializing...");

  tray.on("click", () =>
    loggedIn ? refreshWithAnimation() : showLoginWindow(),
  );

  tray.on("right-click", () => {
    tray.popUpContextMenu(buildContextMenu());
  });
}

// ── Login window ──────────────────────────────────────────────────────────────
function showLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.show();
    loginWindow.focus();
    return;
  }

  loginWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    title: "Sign in to Claude",
    icon: path.join(__dirname, "src", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  loginWindow.setMenuBarVisibility(false);

  loginWindow.loadURL("https://claude.ai/login");

  // Allow Google OAuth popups to open inside Electron.
  loginWindow.webContents.setWindowOpenHandler(({ url }) => ({
    action: "allow",
    overrideBrowserWindowOptions: {
      parent: loginWindow,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    },
  }));

  // Detect login via both full navigations (did-navigate) and SPA route changes
  // (did-navigate-in-page / pushState). Claude.ai uses client-side routing, so
  // after Google OAuth the page pushes to /new without a full reload.
  let verifying = false;

  function onNavigate(url) {
    if (verifying) return;
    const isAuthPage = /\/(login|auth|sso|sign-?in)/i.test(url);
    if (!url.includes("claude.ai") || isAuthPage) return;

    // Claude navigated to a real page — user is logged in.
    // Hide immediately so they never see Claude's UI here.
    verifying = true;
    loginWindow?.hide();

    setTimeout(async () => {
      try {
        usageData = await fetchUsageFromPage();
        loggedIn = true;
        updateTray();
        loginWindow?.close();
        startPolling();
      } catch {
        // Session not ready — show login again.
        verifying = false;
        if (loginWindow && !loginWindow.isDestroyed()) {
          loginWindow.loadURL("https://claude.ai/login");
          loginWindow.show();
        }
      }
    }, 1500);
  }

  loginWindow.webContents.on("did-navigate", (_, url) => onNavigate(url));
  loginWindow.webContents.on("did-navigate-in-page", (_, url) =>
    onNavigate(url),
  );

  loginWindow.on("closed", () => {
    loginWindow = null;
  });
}

// ── Settings window ───────────────────────────────────────────────────────────
function showSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 400,
    height: 650,
    title: "Settings",
    icon: path.join(__dirname, "src", "icon.png"),
    resizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile("settings.html");

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle("get-settings", () => settings);
ipcMain.on("save-settings", (_, newSettings) => {
  settings = newSettings;
  saveSettings(settings);
  updateTray(); // in case icon style changed
});
ipcMain.handle("get-update-state", () => getUpdateState());
ipcMain.on("install-update", () => quitAndInstall());
ipcMain.handle("get-app-version", () => app.getVersion());

// ── Logout ────────────────────────────────────────────────────────────────────
async function logout() {
  loggedIn = false;
  stopPolling();
  usageData = null;
  await clearClaudeCookies();
  updateTray();
  showLoginWindow();
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock.hide();
  app.setAppUserModelId("Claude Usage Taskbar Tool");

  createTray();
  setupAutoUpdater(() => {
    /* menu is built fresh on each right-click */
  });

  // Try to resume an existing session from a previous run.
  try {
    usageData = await fetchUsageFromPage();
    loggedIn = true;
    updateTray();
    startPolling();
    return;
  } catch {
    // No valid session — fall through to login.
  }

  await clearClaudeCookies();
  showLoginWindow();
});

app.on("window-all-closed", () => {
  /* keep running in tray */
});
app.on("before-quit", () => {
  stopPolling();
  tray?.destroy();
});
