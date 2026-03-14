"use strict";

const { app } = require("electron");
const { autoUpdater } = require("electron-updater");

let updateState = "none"; // "none" | "available" | "downloading" | "downloaded"
let updateVersion = null;
let _onStateChange = null;

let initialized = false;

function setupAutoUpdater(onStateChange) {
  if (onStateChange) _onStateChange = onStateChange;

  if (!app.isPackaged) return; // skip in dev mode
  if (initialized) {
    autoUpdater.checkForUpdates().catch(() => {});
    return;
  }
  initialized = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = console; // allow logging to the console

  autoUpdater.setFeedURL({
    provider: "github",
    owner: "SirBepy",
    repo: "ai_usage",
  });

  autoUpdater.on("update-available", (info) => {
    updateState = "available";
    updateVersion = info.version;
    _onStateChange?.();
  });

  autoUpdater.on("download-progress", () => {
    if (updateState !== "downloading") {
      updateState = "downloading";
      _onStateChange?.();
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
    updateState = "downloaded";
    updateVersion = info.version;
    _onStateChange?.();
  });

  autoUpdater.on("error", (err) => {
    console.error("Updater Error:", err.message);
    updateState = "error";
    updateVersion = err.message;
    _onStateChange?.();
  });

  autoUpdater.checkForUpdates().catch(() => {});
}

function downloadUpdate() {
  autoUpdater.downloadUpdate();
}

function getUpdateState() {
  return { state: updateState, version: updateVersion };
}

function quitAndInstall() {
  autoUpdater.quitAndInstall();
}

module.exports = {
  setupAutoUpdater,
  getUpdateState,
  quitAndInstall,
  downloadUpdate,
};
