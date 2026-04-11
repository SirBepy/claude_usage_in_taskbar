"use strict";

// ── Sync Settings ────────────────────────────────────────────────────────────
const syncEnabled = document.getElementById("syncEnabled");
const syncConfigSection = document.getElementById("syncConfigSection");
const syncServerUrl = document.getElementById("syncServerUrl");
const syncApiKey = document.getElementById("syncApiKey");
const syncDeviceName = document.getElementById("syncDeviceName");
const syncRegisterBtn = document.getElementById("syncRegisterBtn");
const syncLinkBtn = document.getElementById("syncLinkBtn");
const syncLinkCodeSection = document.getElementById("syncLinkCodeSection");
const syncLinkCode = document.getElementById("syncLinkCode");
const syncLinkSubmitBtn = document.getElementById("syncLinkSubmitBtn");
const syncStatusMsg = document.getElementById("syncStatusMsg");
const syncDevicesSection = document.getElementById("syncDevicesSection");
const syncGetLinkCodeBtn = document.getElementById("syncGetLinkCodeBtn");
const syncLinkCodeDisplay = document.getElementById("syncLinkCodeDisplay");
const syncLinkCodeValue = document.getElementById("syncLinkCodeValue");
const syncDevicesList = document.getElementById("syncDevicesList");
const syncPushNowBtn = document.getElementById("syncPushNowBtn");

function updateSyncVisibility() {
  const enabled = syncEnabled.checked;
  syncConfigSection.style.display = enabled ? "block" : "none";

  const hasKey = syncApiKey.value.trim().length > 0;
  syncDevicesSection.style.display = hasKey ? "block" : "none";

  if (hasKey) loadDevices();
}

function showSyncStatus(msg, color) {
  syncStatusMsg.textContent = msg;
  syncStatusMsg.style.color = color || "var(--text-dim)";
}

function saveSyncSettings() {
  const sync = {
    enabled: syncEnabled.checked,
    serverUrl: syncServerUrl.value.trim().replace(/\/$/, ""),
    apiKey: syncApiKey.value.trim(),
    deviceName: syncDeviceName.value.trim(),
  };
  // Merge into currentSettings and save
  currentSettings.sync = sync;
  window.electronAPI?.saveSettings(currentSettings);
}

// Toggle sync on/off
syncEnabled.addEventListener("change", () => {
  saveSyncSettings();
  updateSyncVisibility();
});

// Save on field changes
syncServerUrl.addEventListener("change", saveSyncSettings);
syncApiKey.addEventListener("change", () => {
  saveSyncSettings();
  updateSyncVisibility();
});
syncDeviceName.addEventListener("change", saveSyncSettings);

// Register new account
syncRegisterBtn.addEventListener("click", async () => {
  const serverUrl = syncServerUrl.value.trim().replace(/\/$/, "");
  const deviceName = syncDeviceName.value.trim();
  if (!serverUrl) return showSyncStatus("Enter a server URL first", "#ff4444");
  if (!deviceName) return showSyncStatus("Enter a device name first", "#ff4444");

  syncRegisterBtn.disabled = true;
  showSyncStatus("Registering...", "var(--text-dim)");
  try {
    const result = await window.electronAPI.syncRegister(serverUrl, deviceName);
    syncApiKey.value = result.apiKey;
    saveSyncSettings();
    showSyncStatus("Registered! API key saved.", "#27ae60");
    updateSyncVisibility();
  } catch (e) {
    showSyncStatus("Failed: " + e.message, "#ff4444");
  } finally {
    syncRegisterBtn.disabled = false;
  }
});

// Show link code input
syncLinkBtn.addEventListener("click", () => {
  const visible = syncLinkCodeSection.style.display !== "none";
  syncLinkCodeSection.style.display = visible ? "none" : "block";
});

// Submit link code
syncLinkSubmitBtn.addEventListener("click", async () => {
  const serverUrl = syncServerUrl.value.trim().replace(/\/$/, "");
  const code = syncLinkCode.value.trim();
  const deviceName = syncDeviceName.value.trim();
  if (!serverUrl) return showSyncStatus("Enter a server URL first", "#ff4444");
  if (!code) return showSyncStatus("Enter a link code", "#ff4444");
  if (!deviceName) return showSyncStatus("Enter a device name first", "#ff4444");

  syncLinkSubmitBtn.disabled = true;
  showSyncStatus("Linking...", "var(--text-dim)");
  try {
    const result = await window.electronAPI.syncLink(serverUrl, code, deviceName);
    syncApiKey.value = result.apiKey;
    saveSyncSettings();
    syncLinkCodeSection.style.display = "none";
    showSyncStatus("Linked! API key saved.", "#27ae60");
    updateSyncVisibility();
  } catch (e) {
    showSyncStatus("Failed: " + e.message, "#ff4444");
  } finally {
    syncLinkSubmitBtn.disabled = false;
  }
});

// Generate link code for other devices
syncGetLinkCodeBtn.addEventListener("click", async () => {
  syncGetLinkCodeBtn.disabled = true;
  try {
    const result = await window.electronAPI.syncGenerateLinkCode();
    syncLinkCodeValue.textContent = result.linkCode;
    syncLinkCodeDisplay.style.display = "block";
  } catch (e) {
    showSyncStatus("Failed: " + e.message, "#ff4444");
  } finally {
    syncGetLinkCodeBtn.disabled = false;
  }
});

// Push now
syncPushNowBtn.addEventListener("click", async () => {
  syncPushNowBtn.disabled = true;
  syncPushNowBtn.textContent = "Pushing...";
  try {
    await window.electronAPI.syncPush();
    syncPushNowBtn.textContent = "Pushed!";
    setTimeout(() => { syncPushNowBtn.textContent = "Push Now"; }, 2000);
  } catch (e) {
    syncPushNowBtn.textContent = "Failed";
    setTimeout(() => { syncPushNowBtn.textContent = "Push Now"; }, 2000);
  } finally {
    syncPushNowBtn.disabled = false;
  }
});

// Load linked devices list
async function loadDevices() {
  try {
    const devices = await window.electronAPI.syncListDevices();
    syncDevicesList.innerHTML = "";
    for (const d of devices) {
      const div = document.createElement("div");
      div.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:0.82rem;border-bottom:1px solid var(--border)";
      const lastSync = d.last_sync_at ? new Date(d.last_sync_at + "Z").toLocaleString() : "Never";
      const nameSpan = document.createElement("span");
      nameSpan.style.fontWeight = "500";
      nameSpan.textContent = d.name;
      const syncSpan = document.createElement("span");
      syncSpan.style.cssText = "color:var(--text-dim);font-size:0.72rem";
      syncSpan.textContent = "Last sync: " + lastSync;
      div.appendChild(nameSpan);
      div.appendChild(syncSpan);
      syncDevicesList.appendChild(div);
    }
    if (devices.length === 0) {
      syncDevicesList.innerHTML = '<div style="font-size:0.78rem;color:var(--text-dim)">No devices linked yet</div>';
    }
  } catch {
    // Silently fail - may not be configured yet
  }
}

// Initialize sync settings from loaded settings (called from settings.js window.onload)
function initSyncSettings(settings) {
  const sync = settings.sync || {};
  syncEnabled.checked = sync.enabled === true;
  syncServerUrl.value = sync.serverUrl || "";
  syncApiKey.value = sync.apiKey || "";
  syncDeviceName.value = sync.deviceName || "";
  updateSyncVisibility();
}
