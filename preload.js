"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getUsage: () => ipcRenderer.invoke("get-usage"),
  refresh: () => ipcRenderer.invoke("refresh"),
  close: () => ipcRenderer.send("close-popup"),

  onUsageUpdate: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on("usage-update", handler);
    // Returns a cleanup function
    return () => ipcRenderer.removeListener("usage-update", handler);
  },
});
