"use strict";

// ── Theme definitions ─────────────────────────────────────────────────────────
const THEMES = [
  { id: "void",          label: "Void",    mode: "dark",  colors: ["#16151f", "#1e1d2b", "#9d7dfc", "#6e8fff", "#e2e0f0"] },
  { id: "nebula",        label: "Nebula",  mode: "dark",  colors: ["#0f1629", "#172040", "#c084fc", "#a78bfa", "#e2dff0"] },
  { id: "glacier",       label: "Glacier", mode: "dark",  colors: ["#0c1a24", "#112430", "#38bdf8", "#22d3ee", "#e0f0f8"] },
  { id: "cosmo",         label: "Cosmo",   mode: "dark",  colors: ["#1a0a1e", "#241430", "#f472b6", "#fb923c", "#f0e4f5"] },
  { id: "void-light",    label: "Void",    mode: "light", colors: ["#f0eff5", "#ffffff", "#7c5cdb", "#4a6bdf", "#1e1d2b"] },
  { id: "nebula-light",  label: "Nebula",  mode: "light", colors: ["#f2f0fa", "#ffffff", "#9333ea", "#7c3aed", "#1a1040"] },
  { id: "glacier-light", label: "Glacier", mode: "light", colors: ["#eef6fa", "#ffffff", "#0284c7", "#0891b2", "#0c2430"] },
  { id: "cosmo-light",   label: "Cosmo",   mode: "light", colors: ["#faf0f4", "#ffffff", "#db2777", "#ea580c", "#2a1030"] },
];

const themeGridDark = document.getElementById("themeGridDark");
const themeGridLight = document.getElementById("themeGridLight");

function renderThemeCards(activeTheme) {
  [themeGridDark, themeGridLight].forEach(g => g.innerHTML = "");
  for (const t of THEMES) {
    const card = document.createElement("div");
    card.className = "theme-card" + (t.id === activeTheme ? " active" : "");
    card.innerHTML = `
      <div class="theme-swatch">${t.colors.map(c => `<span style="background:${c}"></span>`).join("")}</div>
      <span class="theme-card-label">${t.label}</span>
    `;
    card.onclick = () => {
      document.documentElement.dataset.theme = t.id;
      currentSettings.theme = t.id;
      saveSettings();
      renderThemeCards(t.id);
    };
    (t.mode === "dark" ? themeGridDark : themeGridLight).appendChild(card);
  }
}

// ── Settings ───────────────────────────────────────────────────────────────────
const defaultDisplay = document.getElementById("defaultDisplay");
const iconStyle = document.getElementById("iconStyle");
const timeStyle = document.getElementById("timeStyle");
const iconStyleSection = document.getElementById("iconStyleSection");
const overlayStyle = document.getElementById("overlayStyle");
const overlayStyleSection = document.getElementById("overlayStyleSection");
const colorOverlayMode = document.getElementById("colorOverlayMode");
const colorOverlayModeSection = document.getElementById("colorOverlayModeSection");
const launchAtLogin = document.getElementById("launchAtLogin");
const tooltipLayout = document.getElementById("tooltipLayout");
const tooltipShowSafePace = document.getElementById("tooltipShowSafePace");
const tooltipEstimateTokens = document.getElementById("tooltipEstimateTokens");
const colorApplyIcon = document.getElementById("colorApplyIcon");
const colorApplyNumber = document.getElementById("colorApplyNumber");
const colorApplyDashboard = document.getElementById("colorApplyDashboard");
const colorApplyTooltip = document.getElementById("colorApplyTooltip");
const dashboardShowSession = document.getElementById("dashboardShowSession");
const dashboardShowWeekly = document.getElementById("dashboardShowWeekly");
const dashboardShowSafePace = document.getElementById("dashboardShowSafePace");
const sessionPlan = document.getElementById("sessionPlan");
const weeklyPlan = document.getElementById("weeklyPlan");
const colorContainer = document.getElementById("colorContainer");
const colorMode = document.getElementById("colorMode");
const thresholdSection = document.getElementById("thresholdSection");
const paceSection = document.getElementById("paceSection");
const paceBand = document.getElementById("paceBand");
const paceColorUnder = document.getElementById("paceColorUnder");
const paceColorNearSafe = document.getElementById("paceColorNearSafe");
const paceColorNearOver = document.getElementById("paceColorNearOver");
const paceColorOver = document.getElementById("paceColorOver");
const tokenEstimateFields = document.getElementById("tokenEstimateFields");
const addColorBtn = document.getElementById("addColorBtn");
const soundWorkFinishedEnabled = document.getElementById("soundWorkFinishedEnabled");
const soundWorkFinishedFile = document.getElementById("soundWorkFinishedFile");
const soundWorkFinishedPicker = document.getElementById("soundWorkFinishedPicker");
const soundQuestionAskedEnabled = document.getElementById("soundQuestionAskedEnabled");
const soundQuestionAskedFile = document.getElementById("soundQuestionAskedFile");
const soundQuestionAskedPicker = document.getElementById("soundQuestionAskedPicker");
const soundThresholdEnabled = document.getElementById("soundThresholdEnabled");
const soundThresholdFile = document.getElementById("soundThresholdFile");
const soundThresholdPicker = document.getElementById("soundThresholdPicker");
const refreshUpdateBtn = document.getElementById("refreshUpdateBtn");
const copyLogsBtn = document.getElementById("copyLogsBtn");
const appVersionLabel = document.getElementById("appVersionLabel");
const updateBtn = document.getElementById("updateBtn");
const updateStateLabel = document.getElementById("updateStateLabel");
const macUpdateNotice = document.getElementById("macUpdateNotice");
const macReleasesBtn = document.getElementById("macReleasesBtn");
let isMac = false;

function saveSettings() {
  const settings = {
    theme: document.documentElement.dataset.theme || "void",
    defaultDisplay: defaultDisplay.value,
    iconStyle: iconStyle.value,
    overlayStyle: overlayStyle.value,
    colorOverlayMode: colorOverlayMode.value,
    timeStyle: timeStyle.value,
    tooltipLayout: tooltipLayout.value,
    tooltipShowSafePace: tooltipShowSafePace.checked,
    tooltipEstimateTokens: tooltipEstimateTokens.checked,
    launchAtLogin: launchAtLogin.checked,
    dashboardShowSession: dashboardShowSession.checked,
    dashboardShowWeekly: dashboardShowWeekly.checked,
    dashboardShowSafePace: dashboardShowSafePace.checked,
    colorApplyTo: {
      icon: colorApplyIcon.checked,
      number: colorApplyNumber.checked,
      dashboard: colorApplyDashboard.checked,
      tooltip: colorApplyTooltip.checked,
    },
    sessionPlan: parseInt(sessionPlan.value, 10) || 44000,
    weeklyPlan: parseInt(weeklyPlan.value, 10) || 200000,
    colorMode: colorMode.value,
    paceBand: parseInt(paceBand.value, 10) || 10,
    paceColors: {
      under: paceColorUnder.value,
      nearSafe: paceColorNearSafe.value,
      nearOver: paceColorNearOver.value,
      over: paceColorOver.value,
    },
    colorThresholds: Array.from(colorContainer.querySelectorAll(".color-row"))
      .map((row) => ({
        min: parseInt(row.querySelector(".color-min").value, 10),
        color: row.querySelector(".color-val").value,
      }))
      .sort((a, b) => a.min - b.min),
    sounds: {
      workFinished: { enabled: soundWorkFinishedEnabled.checked, file: soundWorkFinishedFile.value },
      questionAsked: { enabled: soundQuestionAskedEnabled.checked, file: soundQuestionAskedFile.value },
      thresholdCrossed: { enabled: soundThresholdEnabled.checked, file: soundThresholdFile.value },
    },
    projectAliases: currentSettings.projectAliases || {},
    sync: currentSettings.sync || { enabled: false, serverUrl: "", apiKey: "", deviceName: "" },
  };
  currentSettings = settings;
  window.electronAPI?.saveSettings(settings);
  renderHistory(lastHistory);
}

function createColorRow(min = 0, color = "#ffffff") {
  const row = document.createElement("div");
  row.className = "option color-row";
  row.innerHTML = `
    <div style="display: flex; align-items: center; gap: 8px; flex: 1;">
      <input type="number" class="color-min" value="${min}" min="0" max="100" style="width:50px">
      <span style="font-size: 0.8rem; color: var(--text-dim);">%</span>
      <input type="color" class="color-val" value="${color}"
        style="width: 30px; height: 24px; border: none; background: none; cursor: pointer;">
    </div>
    <button class="btn-secondary remove-color-btn" style="padding: 2px 8px; font-size: 0.7rem;">Remove</button>
  `;
  row.querySelector(".remove-color-btn").onclick = () => { row.remove(); saveSettings(); };
  row.querySelector(".color-min").addEventListener("change", saveSettings);
  row.querySelector(".color-val").addEventListener("change", saveSettings);
  return row;
}

function updateVisibilities() {
  const def = defaultDisplay.value;
  // Icon style always visible (icon is always one of the 3 cycle states)
  iconStyleSection.style.display = "flex";
  // Number font/color always visible (number states are always in cycle)
  overlayStyleSection.style.display = "flex";
  colorOverlayModeSection.style.display = "flex";
}

function updateColorModeVisibility() {
  const isPace = colorMode.value === "pace";
  thresholdSection.style.display = isPace ? "none" : "block";
  paceSection.style.display = isPace ? "block" : "none";
}

defaultDisplay.addEventListener("change", () => { updateVisibilities(); saveSettings(); });
colorMode.addEventListener("change", () => { updateColorModeVisibility(); saveSettings(); });
paceBand.addEventListener("change", saveSettings);
paceColorUnder.addEventListener("change", saveSettings);
paceColorNearSafe.addEventListener("change", saveSettings);
paceColorNearOver.addEventListener("change", saveSettings);
paceColorOver.addEventListener("change", saveSettings);

function renderUpdateState(updateState) {
  const hasUpdate = updateState.state === "available" ||
    updateState.state === "downloaded" ||
    updateState.state === "downloading" ||
    updateState.state === "error";

  if (isMac && hasUpdate) {
    updateStateLabel.innerText = `v${updateState.version} available`;
    updateStateLabel.style.color = "var(--text)";
    updateBtn.style.display = "none";
    macUpdateNotice.style.display = "block";
    macReleasesBtn.onclick = () => {
      window.electronAPI?.openExternal(
        `https://github.com/SirBepy/claude_usage_in_taskbar/releases/tag/v${updateState.version}`
      );
    };
    return;
  }

  macUpdateNotice.style.display = "none";

  if (updateState.state === "downloaded") {
    updateStateLabel.innerText = "Ready to install";
    updateStateLabel.style.color = "var(--primary)";
    updateBtn.style.display = "block";
    updateBtn.disabled = false;
    updateBtn.innerText = `Install v${updateState.version}`;
    updateBtn.onclick = () => window.electronAPI?.installUpdate();
  } else if (updateState.state === "available") {
    updateStateLabel.innerText = `v${updateState.version} available`;
    updateStateLabel.style.color = "var(--text)";
    updateBtn.style.display = "block";
    updateBtn.disabled = false;
    updateBtn.innerText = "Download";
    updateBtn.onclick = () => {
      updateBtn.disabled = true;
      updateBtn.innerText = "Downloading...";
      window.electronAPI?.downloadUpdate();
    };
  } else if (updateState.state === "downloading") {
    updateStateLabel.innerText = "Downloading...";
    updateStateLabel.style.color = "var(--text-dim)";
    updateBtn.style.display = "none";
  } else if (updateState.state === "error") {
    updateStateLabel.innerText = `Error`;
    updateStateLabel.style.color = "#ff4444";
    updateBtn.style.display = "block";
    updateBtn.disabled = false;
    updateBtn.innerText = "Retry";
    updateBtn.onclick = () => window.electronAPI?.checkForUpdates();
  } else {
    updateStateLabel.innerText = "Up to date";
    updateStateLabel.style.color = "var(--text-dim)";
    updateBtn.style.display = "none";
  }
}

window.onload = async () => {
  const platform = await window.electronAPI?.getPlatform();
  isMac = platform === "darwin";

  const settings = await window.electronAPI?.getSettings();
  if (settings) {
    const savedTheme = settings.theme || "void";
    document.documentElement.dataset.theme = savedTheme;
    renderThemeCards(savedTheme);

    defaultDisplay.value = settings.defaultDisplay || "icon";
    iconStyle.value = settings.iconStyle || "rings";
    overlayStyle.value = settings.overlayStyle || "classic";
    colorOverlayMode.value = settings.colorOverlayMode || "number";
    timeStyle.value = settings.timeStyle || "absolute";
    tooltipLayout.value = settings.tooltipLayout || "rows";
    tooltipShowSafePace.checked = settings.tooltipShowSafePace !== false;
    tooltipEstimateTokens.checked = settings.tooltipEstimateTokens ?? settings.estimateTokens ?? false;
    launchAtLogin.checked = settings.launchAtLogin || false;
    dashboardShowSession.checked = settings.dashboardShowSession !== false;
    dashboardShowWeekly.checked = settings.dashboardShowWeekly !== false;
    dashboardShowSafePace.checked = settings.dashboardShowSafePace ?? settings.showSafePace ?? true;
    const cat = settings.colorApplyTo || {};
    colorApplyIcon.checked = cat.icon !== false;
    colorApplyNumber.checked = cat.number !== false;
    colorApplyDashboard.checked = cat.dashboard !== false;
    colorApplyTooltip.checked = cat.tooltip !== false;
    sessionPlan.value = settings.sessionPlan || 44000;
    weeklyPlan.value = settings.weeklyPlan || 200000;
    colorMode.value = settings.colorMode || "threshold";
    paceBand.value = settings.paceBand ?? 10;
    const pc = settings.paceColors || {};
    paceColorUnder.value = pc.under || "#27ae60";
    paceColorNearSafe.value = pc.nearSafe || "#f1c40f";
    paceColorNearOver.value = pc.nearOver || "#e67e22";
    paceColorOver.value = pc.over || "#e74c3c";
    updateColorModeVisibility();
    currentSettings = settings;
    if (settings.projectAliases) currentSettings.projectAliases = settings.projectAliases;
    (settings.colorThresholds || []).forEach((t) =>
      colorContainer.appendChild(createColorRow(t.min, t.color))
    );

    const sfx = settings.sounds || {};
    const wf = sfx.workFinished || {};
    const tc = sfx.thresholdCrossed || {};
    soundWorkFinishedEnabled.checked = wf.enabled || false;
    soundWorkFinishedFile.value = wf.file || "sound1.mp3";
    const qa = sfx.questionAsked || {};
    soundQuestionAskedEnabled.checked = qa.enabled || false;
    soundQuestionAskedFile.value = qa.file || "sound3.mp3";
    soundThresholdEnabled.checked = tc.enabled || false;
    soundThresholdFile.value = tc.file || "sound6.mp3";
    soundWorkFinishedPicker.style.display = soundWorkFinishedEnabled.checked ? "flex" : "none";
    soundQuestionAskedPicker.style.display = soundQuestionAskedEnabled.checked ? "flex" : "none";
    soundThresholdPicker.style.display = soundThresholdEnabled.checked ? "flex" : "none";
    tokenEstimateFields.style.display = tooltipEstimateTokens.checked ? "block" : "none";

    // Initialize sync settings (defined in sync-settings.js)
    if (typeof initSyncSettings === "function") initSyncSettings(settings);
  }

  updateVisibilities();

  // Auto-save on any input change
  for (const el of [iconStyle, overlayStyle, colorOverlayMode, timeStyle, tooltipLayout, sessionPlan, weeklyPlan]) {
    el.addEventListener("change", saveSettings);
  }
  for (const el of [launchAtLogin, tooltipShowSafePace, dashboardShowSession, dashboardShowWeekly, dashboardShowSafePace, colorApplyIcon, colorApplyNumber, colorApplyDashboard, colorApplyTooltip]) {
    el.addEventListener("change", saveSettings);
  }

  addColorBtn.onclick = () => {
    colorContainer.appendChild(createColorRow(0, "#9d7dfc"));
    saveSettings();
  };

  tooltipEstimateTokens.addEventListener("change", () => {
    tokenEstimateFields.style.display = tooltipEstimateTokens.checked ? "block" : "none";
    saveSettings();
  });
  soundWorkFinishedEnabled.addEventListener("change", () => {
    soundWorkFinishedPicker.style.display = soundWorkFinishedEnabled.checked ? "flex" : "none";
    saveSettings();
  });
  soundQuestionAskedEnabled.addEventListener("change", () => {
    soundQuestionAskedPicker.style.display = soundQuestionAskedEnabled.checked ? "flex" : "none";
    saveSettings();
  });
  soundThresholdEnabled.addEventListener("change", () => {
    soundThresholdPicker.style.display = soundThresholdEnabled.checked ? "flex" : "none";
    saveSettings();
  });
  soundWorkFinishedFile.addEventListener("change", saveSettings);
  soundQuestionAskedFile.addEventListener("change", saveSettings);
  soundThresholdFile.addEventListener("change", saveSettings);

  document.getElementById("previewWorkFinished").onclick = () => {
    new Audio(`../assets/sounds/${soundWorkFinishedFile.value}`).play().catch(() => {});
  };
  document.getElementById("previewQuestionAsked").onclick = () => {
    new Audio(`../assets/sounds/${soundQuestionAskedFile.value}`).play().catch(() => {});
  };
  document.getElementById("previewThreshold").onclick = () => {
    new Audio(`../assets/sounds/${soundThresholdFile.value}`).play().catch(() => {});
  };

  const version = await window.electronAPI?.getAppVersion();
  if (version) appVersionLabel.innerText = `Version: ${version}`;

  const initialState = await window.electronAPI?.getUpdateState();
  if (initialState) renderUpdateState(initialState);

  window.electronAPI?.onUpdateStateChange(renderUpdateState);
};

refreshUpdateBtn.addEventListener("click", () => {
  window.electronAPI?.checkForUpdates();
  updateStateLabel.innerText = "Checking...";
  updateStateLabel.style.color = "var(--text-dim)";
  updateBtn.style.display = "none";
});

copyLogsBtn.addEventListener("click", () => {
  window.electronAPI?.copyLogs();
  const originalText = copyLogsBtn.textContent;
  copyLogsBtn.textContent = "Copied to Clipboard!";
  copyLogsBtn.classList.replace("btn-secondary", "btn-primary");
  setTimeout(() => {
    copyLogsBtn.textContent = originalText;
    copyLogsBtn.classList.replace("btn-primary", "btn-secondary");
  }, 2000);
});
