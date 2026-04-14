"use strict";

const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, shell } = require("electron");
const path = require("path");
const { execFile } = require("child_process");
const piper = require("./src/core/piper");

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
// Unified serial queue: entries are { kind: "file", path } | { kind: "speech", text, voiceName }
let audioWindow = null;
let audioQueue = [];
let audioBusy = false;
let audioWatchdog = null;
const AUDIO_GAP_MS = 250;
const AUDIO_WATCHDOG_MS = 15000;

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
  audioWindow.webContents.once("did-finish-load", () => { processAudioQueue(); });
  audioWindow.on("closed", () => { audioWindow = null; audioBusy = false; });
}

function processAudioQueue() {
  if (audioBusy) return;
  if (!audioQueue.length) return;
  if (!audioWindow || audioWindow.isDestroyed()) { createAudioWindow(); return; }
  if (audioWindow.webContents.isLoading()) return;

  const entry = audioQueue.shift();
  audioBusy = true;
  if (entry.kind === "file") {
    audioWindow.webContents.send("play-sound", entry.path);
  } else if (entry.kind === "speech") {
    audioWindow.webContents.send("speak-text", { text: entry.text, voiceName: entry.voiceName || null });
  } else {
    audioBusy = false;
    processAudioQueue();
    return;
  }
  audioWatchdog = setTimeout(() => {
    console.warn("[audio] watchdog fired — advancing queue");
    onAudioFinished();
  }, AUDIO_WATCHDOG_MS);
}

function onAudioFinished() {
  if (audioWatchdog) { clearTimeout(audioWatchdog); audioWatchdog = null; }
  audioBusy = false;
  setTimeout(processAudioQueue, AUDIO_GAP_MS);
}

ipcMain.on("sound-finished", () => onAudioFinished());

function enqueueAudio(entry) {
  audioQueue.push(entry);
  if (!audioWindow || audioWindow.isDestroyed()) { createAudioWindow(); return; }
  processAudioQueue();
}

function playSound(soundFile) {
  if (!soundFile) return;
  const soundPath = "file:///" + path.join(__dirname, "src", "assets", "sounds", soundFile).replace(/\\/g, "/");
  enqueueAudio({ kind: "file", path: soundPath });
}

function playWavAbsolute(absPath) {
  if (!absPath) return;
  const soundPath = "file:///" + absPath.replace(/\\/g, "/");
  enqueueAudio({ kind: "file", path: soundPath });
}

async function speakText(text, voiceName) {
  if (!text) return;
  if (voiceName && piper.isPiperInstalled() && piper.isVoiceInstalled(voiceName)) {
    try {
      const wav = await piper.speak(text, voiceName);
      playWavAbsolute(wav);
      return;
    } catch (e) {
      console.error("[piper] speak failed, falling back:", e.message);
    }
  }
  enqueueAudio({ kind: "speech", text, voiceName: null });
}

function fireNotification(type, ctx = {}) {
  const cfg = settings.notifications?.[type];
  if (!cfg?.enabled) return;
  if (cfg.mode === "voice") {
    const text = (cfg.template || "")
      .replace(/\{name\}/g, ctx.name || "")
      .replace(/\{percent\}/g, ctx.percent != null ? `${ctx.percent}%` : "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) speakText(text, cfg.voiceName || null);
  } else if (cfg.soundFile) {
    playSound(cfg.soundFile);
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
  fireNotification,
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

    const thresholds = settings.colorThresholds;
    const crossed = (
      hasThresholdCrossed(prevSession, newSession, thresholds) ||
      hasThresholdCrossed(prevWeekly, newWeekly, thresholds)
    );
    if (crossed) {
      const pct = Math.round(Math.max(newSession, newWeekly));
      fireNotification("thresholdCrossed", { percent: pct });
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
let loginSpinTimer = null;

function startLoginSpin() {
  if (loginSpinTimer) return;
  let frame = 0;
  loginSpinTimer = setInterval(() => {
    setSpinImage(frame++, null);
  }, 80);
}

function stopLoginSpin() {
  if (loginSpinTimer) {
    clearInterval(loginSpinTimer);
    loginSpinTimer = null;
  }
  updateTray(usageData);
}

function showLoginWindow() {
  startLoginSpin();
  showLoginWindowImpl({
    getLoginWindow: () => loginWindow,
    setLoginWindow: (w) => { loginWindow = w; },
    onLoginSuccess: (data) => {
      stopLoginSpin();
      usageData = data;
      loggedIn = true;
      updateTray(usageData);
      recordSnapshot(usageData);
      startPolling();
    },
    onClosed: () => {
      stopLoginSpin();
    },
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
ipcMain.on("speak-preview", (_, payload) => {
  if (typeof payload === "string") {
    speakText(payload, null);
  } else if (payload && payload.text) {
    speakText(payload.text, payload.voiceName || null);
  }
});
ipcMain.handle("piper-status", () => piper.getInstallStatus());
ipcMain.handle("piper-install-binary", async (event) => {
  try {
    await piper.installPiperBinary((p) => {
      event.sender.send("piper-progress", { kind: "binary", progress: p });
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("piper-install-voice", async (event, voiceId) => {
  try {
    await piper.installVoice(voiceId, (p) => {
      event.sender.send("piper-progress", { kind: "voice", voiceId, progress: p });
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("backfill-transcripts", () => backfillAllTranscripts());
ipcMain.handle("check-paths-exist", (_, paths) => {
  const result = {};
  for (const p of paths) result[p] = require("fs").existsSync(p);
  return result;
});
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
