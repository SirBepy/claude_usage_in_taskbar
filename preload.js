"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getUsage: () => ipcRenderer.invoke("get-usage"),
  refresh: () => ipcRenderer.invoke("refresh"),
  close: () => ipcRenderer.send("close-popup"),

  // Settings
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings) => ipcRenderer.send("save-settings", settings),

  // Updates & Version
  getUpdateState: () => ipcRenderer.invoke("get-update-state"),
  downloadUpdate: () => ipcRenderer.send("download-update"),
  installUpdate: () => ipcRenderer.send("install-update"),
  checkForUpdates: () => ipcRenderer.send("check-for-updates"),
  copyLogs: () => ipcRenderer.send("copy-logs"),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),

  onUsageUpdate: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on("usage-update", handler);
    return () => ipcRenderer.removeListener("usage-update", handler);
  },
  onUpdateStateChange: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on("update-state-changed", handler);
    return () => ipcRenderer.removeListener("update-state-changed", handler);
  },
});
