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
  installUpdate: () => ipcRenderer.send("install-update"),
  downloadUpdate: () => ipcRenderer.send("download-update"),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),

  onUsageUpdate: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on("usage-update", handler);
    return () => ipcRenderer.removeListener("usage-update", handler);
  },
});
