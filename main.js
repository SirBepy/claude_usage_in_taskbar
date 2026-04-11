"use strict";

const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, shell } = require("electron");
const path = require("path");
const { execFile } = require("child_process");

app.name = "Claude Usage Taskbar Tool";
if (process.platform === "win32") app.setAppUserModelId("Claude Usage Taskbar Tool");

// Disable hardware acceleration to save memory (prevents the GPU-process from spawning)
app.disableHardwareAcceleration();

const {
  parseSessionPct,
  parseWeeklyPct,
} = require("./src/core/usage-parser");
const { fetchUsageFromPage } = require("./src/core/scraper");
const { recordSnapshot, loadHistory, pruneHistory } = require("./src/core/history");
const { clearClaudeCookies } = require("./src/core/session");
const { loadSettings, saveSettings } = require("./src/core/settings");
const { loadTokenHistory, appendSession, backfillAllTranscripts, repairTimestamps, getActiveSessions } = require("./src/core/token-stats");
const { parseTranscript } = require("./src/core/transcript-parser");
const {
  setupAutoUpdater,
  getUpdateState,
  quitAndInstall,
  downloadUpdate,
} = require("./src/core/updater");
const { createHookServer } = require("./src/core/hook-server");
const {
  createTray,
  updateTray,
  buildContextMenu,
  clearTempDisplay,
  hasThresholdCrossed,
  setSpinImage,
} = require("./src/core/tray");
const { showLoginWindow: showLoginWindowImpl, showDashboardWindow: showDashboardWindowImpl } = require("./src/core/windows");

const { SyncClient } = require("./src/core/sync");
const { clipboard } = require("electron");

// ── Log Buffer ────────────────────────────────────────────────────────────────
const logBuffer = [];
const MAX_LOGS = 200;
const originalLog = console.log;
const originalError = console.error;

function addToBuffer(type, args) {
  const timestamp = new Date().toISOString();
  const message = args
    .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg)))
    .join(" ");
  logBuffer.push(`[${timestamp}] [${type}] ${message}`);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
}

console.log = (...args) => {
  originalLog.apply(console, args);
  addToBuffer("INFO", args);
};

console.error = (...args) => {
  originalError.apply(console, args);
  addToBuffer("ERROR", args);
};

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
let dashboardWindow = null;

let settings = loadSettings();
const syncClient = new SyncClient({
  getSettings: () => settings,
  loadHistory,
  loadTokenHistory,
});

// ── Audio ─────────────────────────────────────────────────────────────────────
let audioWindow = null;
let audioQueue = [];

function createAudioWindow() {
  audioWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "src", "renderer", "audio-preload.js"),
      nodeIntegration: false,
      contextIsolation: false,
      sandbox: false,
    },
  });
  audioWindow.loadFile(path.join(__dirname, "src", "renderer", "audio-player.html"));
  audioWindow.webContents.once("did-finish-load", () => {
    for (const f of audioQueue) audioWindow.webContents.send("play-sound", f);
    audioQueue = [];
  });
  audioWindow.on("closed", () => { audioWindow = null; });
}

function playSound(soundFile) {
  if (!soundFile) return;
  const soundPath = "file:///" + path.join(__dirname, "src", "assets", "sounds", soundFile).replace(/\\/g, "/");
  if (!audioWindow || audioWindow.isDestroyed()) {
    createAudioWindow();
    audioQueue.push(soundPath);
  } else if (audioWindow.webContents.isLoading()) {
    audioQueue.push(soundPath);
  } else {
    audioWindow.webContents.send("play-sound", soundPath);
  }
}

const POLL_MS = 10 * 60 * 1000;

// ── Hook server ──────────────────────────────────────────────────────────────
const hookServer = createHookServer({
  onRefresh: () => refreshWithAnimation(true).catch(console.error),
  onNotify: () => {},
  onQuit: () => app.quit(),
  getSettings: () => settings,
  parseTranscript,
  appendSession,
  loadTokenHistory,
  dashboardSend: (channel, data) => dashboardWindow?.webContents.send(channel, data),
  playSound,
});

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

async function refresh(fromHook = false) {
  const prevSession = parseSessionPct(usageData);
  const prevWeekly = parseWeeklyPct(usageData);
  try {
    usageData = await fetchUsage();
    loggedIn = true;

    const newSession = parseSessionPct(usageData);
    const newWeekly = parseWeeklyPct(usageData);
    const sfx = settings.sounds || {};

    if (fromHook && sfx.workFinished?.enabled) {
      playSound(sfx.workFinished.file);
    }
    if (sfx.thresholdCrossed?.enabled) {
      const thresholds = settings.colorThresholds;
      if (
        hasThresholdCrossed(prevSession, newSession, thresholds) ||
        hasThresholdCrossed(prevWeekly, newWeekly, thresholds)
      ) {
        playSound(sfx.thresholdCrossed.file);
      }
    }

    updateTray(usageData);
    recordSnapshot(usageData);
    dashboardWindow?.webContents.send("history-updated", loadHistory());

    // Push to sync server in background (non-blocking)
    syncClient.push().catch((e) => console.error("[sync] Background push failed:", e.message));
  } catch (e) {
    console.error("Refresh failed:", e.message);
  }
}

// ── Tray ──────────────────────────────────────────────────────────────────────
async function refreshWithAnimation(fromHook = false) {
  if (spinTimer) return;

  let frame = 0;
  const weeklyPct = parseWeeklyPct(usageData);

  spinTimer = setInterval(() => {
    setSpinImage(frame++, weeklyPct);
  }, 50);

  try {
    await refresh(fromHook);
  } finally {
    clearInterval(spinTimer);
    spinTimer = null;
    updateTray(usageData);
  }
}

// ── Windows ──────────────────────────────────────────────────────────────────
function showLoginWindow() {
  showLoginWindowImpl({
    getLoginWindow: () => loginWindow,
    setLoginWindow: (w) => { loginWindow = w; },
    onLoginSuccess: (data) => {
      usageData = data;
      loggedIn = true;
      updateTray(usageData);
      recordSnapshot(usageData);
      startPolling();
    },
    onClosed: () => {},
  });
}

function showDashboardWindow() {
  showDashboardWindowImpl({
    getDashboardWindow: () => dashboardWindow,
    setDashboardWindow: (w) => { dashboardWindow = w; },
    onClosed: () => {},
  });
}

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle("get-usage-history", () => loadHistory());
ipcMain.handle("get-settings", () => settings);
ipcMain.on("save-settings", (_, newSettings) => {
  settings = newSettings;
  saveSettings(settings);
  clearTempDisplay();
  updateTray(usageData);
});
ipcMain.on("logout", async () => {
  await logout();
});
ipcMain.handle("get-update-state", () => getUpdateState());
ipcMain.on("install-update", () => quitAndInstall());
ipcMain.on("download-update", () => downloadUpdate());
ipcMain.on("check-for-updates", () => {
  setupAutoUpdater();
});
ipcMain.on("copy-logs", () => {
  clipboard.writeText(logBuffer.join("\n"));
});
ipcMain.handle("get-app-version", () => app.getVersion());
ipcMain.handle("get-platform", () => process.platform);
ipcMain.on("open-external", (_, url) => shell.openExternal(url));
ipcMain.handle("get-token-history", () => loadTokenHistory());
ipcMain.handle("get-active-sessions", () => getActiveSessions());
ipcMain.handle("backfill-transcripts", () => backfillAllTranscripts());
ipcMain.on("open-in-explorer", (_, folderPath) => shell.openPath(folderPath));
ipcMain.on("open-in-vscode", (_, folderPath) => {
  const cmd = process.platform === "win32" ? "code.cmd" : "code";
  execFile(cmd, [folderPath], { windowsHide: true }, () => {});
});

// ── Sync IPC ─────────────────────────────────────────────────────────────────
ipcMain.handle("sync-register", async (_, serverUrl, deviceName) => {
  return syncClient.register(serverUrl, deviceName);
});
ipcMain.handle("sync-link", async (_, serverUrl, linkCode, deviceName) => {
  return syncClient.link(serverUrl, linkCode, deviceName);
});
ipcMain.handle("sync-generate-link-code", async () => {
  return syncClient.generateLinkCode();
});
ipcMain.handle("sync-list-devices", async () => {
  return syncClient.listDevices();
});
ipcMain.handle("sync-pull", async () => {
  return syncClient.pull();
});
ipcMain.handle("sync-push", async () => {
  await syncClient.push();
  return { ok: true };
});

// ── Logout ─────────────────────────────────────────────────���──────────────────
async function logout() {
  loggedIn = false;
  stopPolling();
  usageData = null;
  await clearClaudeCookies();
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.close();
  }
  updateTray(usageData);
  showLoginWindow();
}

// ── Protocol handler ─────────────────────────────────────────────────────────
app.setAsDefaultProtocolClient("aiusage");

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock.hide();
  pruneHistory();
  repairTimestamps();

  tray = createTray({
    getSettings: () => settings,
    isLoggedIn: () => loggedIn,
    onLeftClick: () => showLoginWindow(),
    onRightClick: () => {
      tray.popUpContextMenu(buildContextMenu({
        loggedIn,
        loggingIn: nativeAuthHandle != null,
        getUpdateState,
        showLoginWindow,
        showDashboardWindow,
        refreshWithAnimation,
        quitAndInstall,
        downloadUpdate,
        quit: () => app.quit(),
      }));
    },
  });

  createAudioWindow();
  setupAutoUpdater(() => {
    const state = getUpdateState();
    console.log("Updater state changed via callback:", state);
    dashboardWindow?.webContents.send("update-state-changed", state);
  });

  // Try to resume an existing session from a previous run.
  try {
    usageData = await fetchUsageFromPage();
    loggedIn = true;
    updateTray(usageData);
    recordSnapshot(usageData);
    dashboardWindow?.webContents.send("history-updated", loadHistory());
    startPolling();
    return;
  } catch {
    // No valid session — fall through to login.
  }

  // If started with --hidden (e.g. via Login Items), don't pop up the login window.
  // The user can still log in by clicking the tray icon later.
  if (process.argv.includes("--hidden")) {
    console.log("Started in hidden mode. Skipping initial login window.");
    updateTray(usageData);
    return;
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
  hookServer.close();
  audioWindow?.destroy();
});
