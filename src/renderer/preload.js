"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // History & Stats
  getUsageHistory: () => ipcRenderer.invoke("get-usage-history"),

  // Settings
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings) => ipcRenderer.send("save-settings", settings),
  logout: () => ipcRenderer.send("logout"),

  // Updates & Version
  getUpdateState: () => ipcRenderer.invoke("get-update-state"),
  downloadUpdate: () => ipcRenderer.send("download-update"),
  installUpdate: () => ipcRenderer.send("install-update"),
  checkForUpdates: () => ipcRenderer.send("check-for-updates"),
  copyLogs: () => ipcRenderer.send("copy-logs"),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getPlatform: () => ipcRenderer.invoke("get-platform"),
  openExternal: (url) => ipcRenderer.send("open-external", url),

  onUpdateStateChange: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on("update-state-changed", handler);
    return () => ipcRenderer.removeListener("update-state-changed", handler);
  },
  onHistoryUpdated: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on("history-updated", handler);
    return () => ipcRenderer.removeListener("history-updated", handler);
  },

  // File system
  checkPathsExist: (paths) => ipcRenderer.invoke("check-paths-exist", paths),

  // Open project
  openInExplorer: (folderPath) => ipcRenderer.send("open-in-explorer", folderPath),
  openInVSCode: (folderPath) => ipcRenderer.send("open-in-vscode", folderPath),

  // Sync
  syncRegister: (serverUrl, deviceName) => ipcRenderer.invoke("sync-register", serverUrl, deviceName),
  syncLink: (serverUrl, linkCode, deviceName) => ipcRenderer.invoke("sync-link", serverUrl, linkCode, deviceName),
  syncGenerateLinkCode: () => ipcRenderer.invoke("sync-generate-link-code"),
  syncListDevices: () => ipcRenderer.invoke("sync-list-devices"),
  syncPull: () => ipcRenderer.invoke("sync-pull"),
  syncPush: () => ipcRenderer.invoke("sync-push"),

  // Token stats
  getTokenHistory: () => ipcRenderer.invoke("get-token-history"),
  getActiveSessions: () => ipcRenderer.invoke("get-active-sessions"),
  backfillTranscripts: () => ipcRenderer.invoke("backfill-transcripts"),
  speakPreview: (text) => ipcRenderer.send("speak-preview", text),
  piperStatus: () => ipcRenderer.invoke("piper-status"),
  piperInstallBinary: () => ipcRenderer.invoke("piper-install-binary"),
  piperInstallVoice: (voiceId) => ipcRenderer.invoke("piper-install-voice", voiceId),
  onPiperProgress: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on("piper-progress", handler);
    return () => ipcRenderer.removeListener("piper-progress", handler);
  },
  onTokenHistoryUpdated: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on("token-history-updated", handler);
    return () => ipcRenderer.removeListener("token-history-updated", handler);
  },
});
