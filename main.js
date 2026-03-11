"use strict";

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  screen: electronScreen,
} = require("electron");
const path = require("path");

const { iconForPct } = require("./src/icon");
const { parseSessionPct, buildTooltip } = require("./src/usage-parser");
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
let popupWindow = null;
let pickerWindow = null;
let pollTimer = null;
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
    broadcastUsage();
  } catch (e) {
    console.error("Refresh failed:", e.message);
  }
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function updateTray() {
  if (!tray) return;
  tray.setImage(iconForPct(parseSessionPct(usageData)));
  tray.setToolTip(buildTooltip(usageData));
}

function createTray() {
  tray = new Tray(iconForPct(null));
  tray.setToolTip("Claude Usage — Initializing...");

  tray.on("click", async () => {
    await refresh();
    openPopup();
  });

  tray.on("right-click", () => {
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: "Show Usage", click: openPopup },
        { label: "Refresh", click: () => refresh() },
        { type: "separator" },
        { label: "Log Out", click: logout },
        { type: "separator" },
        { label: "Quit", click: () => app.quit() },
      ]),
    );
  });
}

// ── Popup window ──────────────────────────────────────────────────────────────
function getPopupPosition() {
  const { x: tx, y: ty, width: tw } = tray.getBounds();
  const W = 320, H = 240;
  const display = electronScreen.getDisplayNearestPoint({ x: tx, y: ty });
  const { x: wx, y: wy, width: ww, height: wh } = display.workArea;

  let x = Math.round(tx + tw / 2 - W / 2);
  let y = Math.round(ty - H - 8);
  x = Math.max(wx, Math.min(x, wx + ww - W));
  y = Math.max(wy, Math.min(y, wy + wh - H));
  return { x, y, width: W, height: H };
}

function openPopup() {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.focus();
    return;
  }

  popupWindow = new BrowserWindow({
    ...getPopupPosition(),
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  popupWindow.loadFile("popup.html");
  popupWindow.on("blur", () => popupWindow?.close());
  popupWindow.on("closed", () => { popupWindow = null; });
}

function broadcastUsage() {
  if (popupWindow && !popupWindow.isDestroyed())
    popupWindow.webContents.send("usage-update", usageData);
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
    broadcastUsage();
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
  popupWindow?.close();
  await clearClaudeCookies();
  updateTray();
  showLoginWindow();
}

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle("get-usage", () => usageData);
ipcMain.handle("refresh", async () => {
  await refresh();
  return usageData;
});
ipcMain.on("close-popup", () => popupWindow?.close());

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
