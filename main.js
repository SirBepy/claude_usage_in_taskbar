"use strict";

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
} = require("electron");
const path = require("path");

const { makeIcon, makeSpinFrame } = require("./src/icon");
const { parseSessionPct, parseWeeklyPct, buildTooltip } = require("./src/usage-parser");
const { fetchUsageFromPage } = require("./src/scraper");
const { clearClaudeCookies } = require("./src/session");
const { listChromeProfiles, importChromeProfile } = require("./src/chrome-import");

// ── Single instance ───────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on("second-instance", () => {
  (loginWindow ?? pickerWindow)?.focus();
});

// ── State ─────────────────────────────────────────────────────────────────────
let tray = null;
let loginWindow = null;
let pickerWindow = null;
let pollTimer = null;
let spinTimer = null;
let usageData = null;

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
    updateTray();
  } catch (e) {
    console.error("Refresh failed:", e.message);
  }
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function updateTray() {
  if (!tray) return;
  tray.setImage(makeIcon(parseSessionPct(usageData), parseWeeklyPct(usageData)));
  tray.setToolTip(buildTooltip(usageData));
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
    tray?.setImage(makeSpinFrame(frame++, weeklyPct));
  }, 50);

  try {
    await refresh();
  } finally {
    clearInterval(spinTimer);
    spinTimer = null;
    updateTray(); // snap to real data
  }
}

function createTray() {
  tray = new Tray(makeIcon(null, null));
  tray.setToolTip("Claude Usage — Initializing...");

  tray.on("click", () => refreshWithAnimation());

  tray.on("right-click", () => {
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: "Refresh", click: () => refreshWithAnimation() },
        { type: "separator" },
        { label: "Log Out", click: logout },
        { type: "separator" },
        { label: "Quit", click: () => app.quit() },
      ]),
    );
  });
}

// ── Login window ──────────────────────────────────────────────────────────────
function showLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }

  loginWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    title: "Sign in to Claude",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  loginWindow.loadURL("https://claude.ai/login");

  // Allow Google OAuth popups to open inside Electron.
  loginWindow.webContents.setWindowOpenHandler(({ url }) => ({
    action: "allow",
    overrideBrowserWindowOptions: {
      parent: loginWindow,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    },
  }));

  loginWindow.webContents.on("did-navigate", (_, url) => {
    const isAuthPage = /\/(login|auth|sso|sign-?in)/i.test(url);
    if (url.includes("claude.ai") && !isAuthPage) {
      setTimeout(tryAutoDetectLogin, 1500);
    }
  });

  loginWindow.on("closed", () => { loginWindow = null; });
}

async function tryAutoDetectLogin() {
  try {
    usageData = await fetchUsageFromPage();
    updateTray();
    loginWindow?.close();
    startPolling();
  } catch {
    // keep waiting — user may still be completing login
  }
}

// ── Profile picker window ─────────────────────────────────────────────────────
function showProfilePicker() {
  if (pickerWindow && !pickerWindow.isDestroyed()) {
    pickerWindow.focus();
    return;
  }

  pickerWindow = new BrowserWindow({
    width: 400,
    height: 460,
    resizable: false,
    title: "Sign in to Claude",
    webPreferences: {
      preload: path.join(__dirname, "profile-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  pickerWindow.loadFile("profile-picker.html");
  pickerWindow.on("closed", () => { pickerWindow = null; });
}

// ── Logout ────────────────────────────────────────────────────────────────────
async function logout() {
  stopPolling();
  usageData = null;
  await clearClaudeCookies();
  updateTray();
  showLoginWindow();
}

// ── IPC (profile picker only) ─────────────────────────────────────────────────
ipcMain.handle("get-chrome-profiles", () => listChromeProfiles());

ipcMain.handle("import-chrome-profile", async (_, dir) => {
  try {
    const count = await importChromeProfile(dir);
    if (count === 0)
      return { success: false, message: "No Claude session found in this profile. Try signing in fresh." };

    pickerWindow?.close();
    await refresh();
    startPolling();
    return { success: true, count };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

ipcMain.on("profile-picker:fresh-login", () => {
  pickerWindow?.close();
  showLoginWindow();
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock.hide();
  app.setAppUserModelId("com.aiusage.toolbar");

  createTray();

  // Try to resume an existing session from a previous run.
  try {
    usageData = await fetchUsageFromPage();
    updateTray();
    startPolling();
    return;
  } catch {
    // No valid session — fall through.
  }

  // Clear stale cookies, then offer Chrome import or fresh login.
  await clearClaudeCookies();
  const profiles = listChromeProfiles();
  if (profiles.length > 0) {
    showProfilePicker();
  } else {
    showLoginWindow();
  }
});

app.on("window-all-closed", () => { /* keep running in tray */ });
app.on("before-quit", () => {
  stopPolling();
  tray?.destroy();
});
