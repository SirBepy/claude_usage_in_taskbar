"use strict";

const { app } = require("electron");
const { autoUpdater } = require("electron-updater");

let updateState = "none"; // "none" | "available" | "downloading" | "downloaded"
let updateVersion = null;
let _onStateChange = null;

function setupAutoUpdater(onStateChange) {
  _onStateChange = onStateChange;

  if (!app.isPackaged) return; // skip in dev mode

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null; // suppress verbose logs

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
    console.error("Updater:", err.message);
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
