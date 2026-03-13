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
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),

  onUsageUpdate: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on("usage-update", handler);
    return () => ipcRenderer.removeListener("usage-update", handler);
  },
});
