"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("profileAPI", {
  getChromeProfiles: () => ipcRenderer.invoke("get-chrome-profiles"),
  importProfile: (dir) => ipcRenderer.invoke("import-chrome-profile", dir),
  signInFresh: () => ipcRenderer.send("profile-picker:fresh-login"),
});
