"use strict";

// ── Theme definitions ─────────────────────────────────────────────────────────
const THEMES = [
  { id: "void",    label: "Void",    darkColors: ["#16151f", "#1e1d2b", "#9d7dfc", "#6e8fff", "#e2e0f0"], lightColors: ["#f0eff5", "#ffffff", "#7c5cdb", "#4a6bdf", "#1e1d2b"] },
  { id: "nebula",  label: "Nebula",  darkColors: ["#0f1629", "#172040", "#c084fc", "#a78bfa", "#e2dff0"], lightColors: ["#f2f0fa", "#ffffff", "#9333ea", "#7c3aed", "#1a1040"] },
  { id: "glacier", label: "Glacier", darkColors: ["#0c1a24", "#112430", "#38bdf8", "#22d3ee", "#e0f0f8"], lightColors: ["#eef6fa", "#ffffff", "#0284c7", "#0891b2", "#0c2430"] },
  { id: "cosmo",   label: "Cosmo",   darkColors: ["#1a0a1e", "#241430", "#f472b6", "#fb923c", "#f0e4f5"], lightColors: ["#faf0f4", "#ffffff", "#db2777", "#ea580c", "#2a1030"] },
];

const themeGrid = document.getElementById("themeGrid");
const themeModToggle = document.getElementById("themeModToggle");
const modeLabelDark = document.getElementById("modeLabelDark");
const modeLabelLight = document.getElementById("modeLabelLight");

function resolveThemeId(baseId, isLight) {
  return isLight ? baseId + "-light" : baseId;
}

function parseThemeId(fullId) {
  const isLight = fullId.endsWith("-light");
  return { baseId: isLight ? fullId.replace("-light", "") : fullId, isLight };
}

function applyTheme(baseId) {
  const isLight = themeModToggle.checked;
  const fullId = resolveThemeId(baseId, isLight);
  document.documentElement.dataset.theme = fullId;
  currentSettings.theme = fullId;
  saveSettings();

  // Update active card highlight (no DOM rebuild)
  for (const card of themeGrid.querySelectorAll(".theme-card")) {
    card.classList.toggle("active", card.dataset.themeId === baseId);
  }

  // Update mode label colors (they use --primary which just changed)
  modeLabelDark.style.color = isLight ? "var(--text-dim)" : "var(--primary)";
  modeLabelLight.style.color = isLight ? "var(--primary)" : "var(--text-dim)";
}

function renderThemeCards(activeTheme) {
  const { baseId: activeBase, isLight } = parseThemeId(activeTheme);
  const colorKey = isLight ? "lightColors" : "darkColors";
  themeGrid.innerHTML = "";
  for (const t of THEMES) {
    const card = document.createElement("div");
    card.className = "theme-card" + (t.id === activeBase ? " active" : "");
    card.dataset.themeId = t.id;
    card.innerHTML = `
      <div class="theme-swatch">${t[colorKey].map(c => `<span style="background:${c}"></span>`).join("")}</div>
      <span class="theme-card-label">${t.label}</span>
    `;
    card.onclick = () => applyTheme(t.id);
    themeGrid.appendChild(card);
  }

  modeLabelDark.style.color = isLight ? "var(--text-dim)" : "var(--primary)";
  modeLabelLight.style.color = isLight ? "var(--primary)" : "var(--text-dim)";
}

themeModToggle.addEventListener("change", () => {
  const { baseId } = parseThemeId(currentSettings.theme || "void");
  const isLight = themeModToggle.checked;
  const fullId = resolveThemeId(baseId, isLight);

  // Apply theme + save
  document.documentElement.dataset.theme = fullId;
  currentSettings.theme = fullId;
  saveSettings();

  // Rebuild cards to show correct color swatches for the new mode
  renderThemeCards(fullId);
});

// ── Settings ───────────────────────────────────────────────────────────────────
const defaultDisplay = document.getElementById("defaultDisplay");
const iconStyle = document.getElementById("iconStyle");
const timeStyle = document.getElementById("timeStyle");
const iconStyleSection = document.getElementById("iconStyleSection");
const launchAtLogin = document.getElementById("launchAtLogin");
const tooltipLayout = document.getElementById("tooltipLayout");
const tooltipShowSafePace = document.getElementById("tooltipShowSafePace");
const colorApplyIcon = document.getElementById("colorApplyIcon");
const colorApplyNumber = document.getElementById("colorApplyNumber");
const colorApplyDashboard = document.getElementById("colorApplyDashboard");
const colorApplyTooltip = document.getElementById("colorApplyTooltip");
const dashboardShowSession = document.getElementById("dashboardShowSession");
const dashboardShowWeekly = document.getElementById("dashboardShowWeekly");
const dashboardShowSafePace = document.getElementById("dashboardShowSafePace");
const colorContainer = document.getElementById("colorContainer");
const colorMode = document.getElementById("colorMode");
const thresholdSection = document.getElementById("thresholdSection");
const paceSection = document.getElementById("paceSection");
const paceBand = document.getElementById("paceBand");
const paceColorUnder = document.getElementById("paceColorUnder");
const paceColorNearSafe = document.getElementById("paceColorNearSafe");
const paceColorNearOver = document.getElementById("paceColorNearOver");
const paceColorOver = document.getElementById("paceColorOver");
const addColorBtn = document.getElementById("addColorBtn");
const NOTIF_TYPES = [
  { key: "workFinished",     title: "Done (Work Finished)",     hint: "Supports {name}",    defaultSound: "sound1.mp3", defaultTemplate: "{name} is done" },
  { key: "questionAsked",    title: "Waiting (Question Asked)", hint: "Supports {name}",    defaultSound: "sound3.mp3", defaultTemplate: "{name} is waiting" },
  { key: "thresholdCrossed", title: "Threshold Reached",        hint: "Supports {percent}", defaultSound: "sound6.mp3", defaultTemplate: "{percent} threshold reached" },
];
const notifCardsRoot = document.getElementById("notifCards");
const notifCardTemplate = document.getElementById("notifCardTemplate");
const voicePreviewProject = document.getElementById("voicePreviewProject");
const voicePreviewProjectRow = document.getElementById("voicePreviewProjectRow");
const notifCards = {};
let piperStatusCache = null;

function getInstalledPiperVoices() {
  return (piperStatusCache?.voices || []).filter(v => v.installed);
}

function populateVoiceSelect(sel, selected) {
  const webVoices = (window.speechSynthesis?.getVoices() || []).filter(v => v.name && v.name !== "Matej");
  const piperVoices = getInstalledPiperVoices();
  const parts = [];
  if (piperVoices.length) {
    parts.push(`<optgroup label="High-quality (Piper)">${piperVoices.map(v => `<option value="${v.id}"${v.id===selected?" selected":""}>${v.label}</option>`).join("")}</optgroup>`);
  }
  if (webVoices.length) {
    parts.push(`<optgroup label="System voices">${webVoices.map(v => `<option value="${v.name}"${v.name===selected?" selected":""}>${v.name}</option>`).join("")}</optgroup>`);
  }
  if (!parts.length) parts.push(`<option value="">(loading voices...)</option>`);
  sel.innerHTML = parts.join("");
  if (selected) {
    const opt = Array.from(sel.options).find(o => o.value === selected);
    if (opt) sel.value = selected;
  }
}

function refreshAllVoiceSelects() {
  for (const t of NOTIF_TYPES) {
    const c = notifCards[t.key];
    if (!c) continue;
    const desired = c.voiceSelect.dataset.desired || c.voiceSelect.value || null;
    populateVoiceSelect(c.voiceSelect, desired);
  }
}

function applyNotifCardVisibility(type) {
  const c = notifCards[type];
  if (!c) return;
  const enabled = c.enabled.checked;
  const mode = Array.from(c.modes).find(r => r.checked)?.value || "sound";
  c.body.style.display = enabled ? "flex" : "none";
  c.soundRow.style.display = (enabled && mode === "sound") ? "flex" : "none";
  c.voiceRows.style.display = (enabled && mode === "voice") ? "flex" : "none";
}

function renderNotifCard(type, cfg) {
  const c = notifCards[type];
  if (!c) return;
  const def = NOTIF_TYPES.find(n => n.key === type);
  c.enabled.checked = cfg.enabled !== false;
  const mode = cfg.mode === "voice" ? "voice" : "sound";
  c.modes.forEach(r => { r.checked = r.value === mode; });
  c.soundFile.value = cfg.soundFile || def.defaultSound;
  c.template.value = cfg.template || def.defaultTemplate;
  if (cfg.voiceName) c.voiceSelect.dataset.desired = cfg.voiceName;
  populateVoiceSelect(c.voiceSelect, cfg.voiceName || null);
  applyNotifCardVisibility(type);
}

function wireNotifCard(type) {
  const c = notifCards[type];
  const def = NOTIF_TYPES.find(n => n.key === type);
  const onToggle = () => { applyNotifCardVisibility(type); saveSettings(); };
  c.enabled.addEventListener("change", onToggle);
  c.modes.forEach(r => r.addEventListener("change", onToggle));
  c.soundFile.addEventListener("change", saveSettings);
  c.template.addEventListener("input", saveSettings);
  c.voiceSelect.addEventListener("change", () => {
    c.voiceSelect.dataset.desired = c.voiceSelect.value || "";
    saveSettings();
  });
  c.soundPreview.onclick = () => {
    const f = c.soundFile.value;
    if (!f) return;
    window.electronAPI.playSoundPreview(f).catch((e) => console.error("sound preview failed", e));
  };
  c.voicePreview.onclick = () => {
    const cwd = voicePreviewProject.value || "";
    const rawName = cwd ? cwd.split(/[\\/]/).pop() : "Project";
    const name = rawName.replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
    const text = (c.template.value || def.defaultTemplate)
      .replace(/\{name\}/g, name)
      .replace(/\{percent\}/g, "80%")
      .replace(/[_\-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return;
    window.electronAPI.speakPreview({ text, voiceName: c.voiceSelect.value || null });
  };
}

function buildNotifCards() {
  if (!notifCardsRoot || !notifCardTemplate) {
    console.error("[notif] template or root missing");
    return;
  }
  notifCardsRoot.innerHTML = "";
  for (const t of NOTIF_TYPES) {
    const node = notifCardTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".notif-title").textContent = t.title;
    node.querySelector(".notif-template-hint").textContent = t.hint;
    node.querySelectorAll(".notif-mode").forEach(r => { r.name = `notif-mode-${t.key}`; });
    notifCardsRoot.appendChild(node);
    notifCards[t.key] = {
      root: node,
      enabled: node.querySelector(".notif-enabled"),
      body: node.querySelector(".notif-body"),
      modes: node.querySelectorAll(".notif-mode"),
      soundRow: node.querySelector(".notif-sound-row"),
      soundFile: node.querySelector(".notif-sound-file"),
      soundPreview: node.querySelector(".notif-sound-preview"),
      voiceRows: node.querySelector(".notif-voice-rows"),
      voiceSelect: node.querySelector(".notif-voice-select"),
      template: node.querySelector(".notif-template"),
      voicePreview: node.querySelector(".notif-voice-preview"),
    };
    wireNotifCard(t.key);
  }
}

function gatherNotifSettings() {
  const out = {};
  for (const t of NOTIF_TYPES) {
    const c = notifCards[t.key];
    const def = NOTIF_TYPES.find(n => n.key === t.key);
    if (!c) {
      out[t.key] = { enabled: true, mode: "sound", soundFile: def.defaultSound, voiceName: null, template: def.defaultTemplate };
      continue;
    }
    const mode = Array.from(c.modes).find(r => r.checked)?.value || "sound";
    out[t.key] = {
      enabled: c.enabled.checked,
      mode,
      soundFile: c.soundFile.value,
      voiceName: c.voiceSelect.value || c.voiceSelect.dataset.desired || null,
      template: c.template.value || def.defaultTemplate,
    };
  }
  return out;
}

async function loadPiperVoices() {
  try {
    piperStatusCache = await window.electronAPI.piperStatus();
    refreshAllVoiceSelects();
  } catch (e) {
    console.error("[piper] populate failed:", e);
  }
}

// Electron quirk: speechSynthesis.getVoices() often returns [] initially.
// Poll for ~3s and also subscribe to onvoiceschanged.
function primeWebVoices() {
  if (!window.speechSynthesis) return;
  let tries = 0;
  const tick = () => {
    const list = speechSynthesis.getVoices() || [];
    if (list.length > 0) { refreshAllVoiceSelects(); return; }
    if (tries++ < 30) setTimeout(tick, 100);
  };
  tick();
  speechSynthesis.addEventListener?.("voiceschanged", refreshAllVoiceSelects);
  speechSynthesis.onvoiceschanged = refreshAllVoiceSelects;
}
const autoUpdate = document.getElementById("autoUpdate");
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
    timeStyle: timeStyle.value,
    tooltipLayout: tooltipLayout.value,
    tooltipShowSafePace: tooltipShowSafePace.checked,
    launchAtLogin: launchAtLogin.checked,
    autoUpdate: autoUpdate.checked,
    dashboardShowSession: dashboardShowSession.checked,
    dashboardShowWeekly: dashboardShowWeekly.checked,
    dashboardShowSafePace: dashboardShowSafePace.checked,
    colorApplyTo: {
      icon: colorApplyIcon.checked,
      number: colorApplyNumber.checked,
      dashboard: colorApplyDashboard.checked,
      tooltip: colorApplyTooltip.checked,
    },
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
    notifications: gatherNotifSettings(),
    projectAliases: currentSettings.projectAliases || {},
    // stats.js mutates projectBlacklist directly on currentSettings. If we
    // don't persist it here, each save round-trip drops any project the
    // user just hid.
    projectBlacklist: currentSettings.projectBlacklist || [],
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
      <input type="color" class="color-val" value="${color}">
    </div>
    <button class="btn-secondary remove-color-btn" style="padding: 2px 8px; font-size: 0.7rem;">Remove</button>
  `;
  row.querySelector(".remove-color-btn").onclick = () => { row.remove(); saveSettings(); };
  row.querySelector(".color-min").addEventListener("change", saveSettings);
  row.querySelector(".color-val").addEventListener("change", saveSettings);
  return row;
}

function updateVisibilities() {
  // Icon style always visible (icon is always one of the 3 cycle states)
  iconStyleSection.style.display = "flex";
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
    updateBtn.innerText = `Download & Install v${updateState.version}`;
    updateBtn.onclick = () => {
      updateBtn.disabled = true;
      updateBtn.innerText = "Downloading...";
      window.electronAPI?.downloadAndInstall();
    };
  } else if (updateState.state === "downloading") {
    updateStateLabel.innerText = "Downloading...";
    updateStateLabel.style.color = "var(--text-dim)";
    updateBtn.style.display = "block";
    updateBtn.disabled = true;
    updateBtn.innerText = "Downloading...";
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
  if (isMac) {
    const row = document.getElementById("autoUpdateRow");
    if (row) row.style.display = "none";
  }

  const settings = await window.electronAPI?.getSettings();
  if (settings) {
    const savedTheme = settings.theme || "void";
    document.documentElement.dataset.theme = savedTheme;
    themeModToggle.checked = savedTheme.endsWith("-light");
    renderThemeCards(savedTheme);

    defaultDisplay.value = settings.defaultDisplay || "icon";
    iconStyle.value = settings.iconStyle || "rings";
    timeStyle.value = settings.timeStyle || "absolute";
    tooltipLayout.value = settings.tooltipLayout || "rows";
    tooltipShowSafePace.checked = settings.tooltipShowSafePace !== false;
    launchAtLogin.checked = settings.launchAtLogin || false;
    autoUpdate.checked = settings.autoUpdate || false;
    dashboardShowSession.checked = settings.dashboardShowSession !== false;
    dashboardShowWeekly.checked = settings.dashboardShowWeekly !== false;
    dashboardShowSafePace.checked = settings.dashboardShowSafePace ?? settings.showSafePace ?? true;
    // Normalize colorApplyTo so every key has an explicit boolean. Keys added
    // after the field shipped (dashboard, tooltip) may be missing on stale
    // settings files; without this migration, valueColor sees undefined and
    // the read-side check still falls through, but anything that copies the
    // object loses the implicit-true default.
    const cat = {
      icon: settings.colorApplyTo?.icon !== false,
      number: settings.colorApplyTo?.number !== false,
      dashboard: settings.colorApplyTo?.dashboard !== false,
      tooltip: settings.colorApplyTo?.tooltip !== false,
    };
    settings.colorApplyTo = cat;
    colorApplyIcon.checked = cat.icon;
    colorApplyNumber.checked = cat.number;
    colorApplyDashboard.checked = cat.dashboard;
    colorApplyTooltip.checked = cat.tooltip;
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
    const DEFAULT_THRESHOLDS = [
      { min: 0,  color: "#27ae60" },
      { min: 50, color: "#e67e22" },
      { min: 80, color: "#e74c3c" },
    ];
    const thresholds = (settings.colorThresholds && settings.colorThresholds.length)
      ? settings.colorThresholds
      : DEFAULT_THRESHOLDS;
    settings.colorThresholds = thresholds;
    thresholds.forEach((t) =>
      colorContainer.appendChild(createColorRow(t.min, t.color))
    );

    buildNotifCards();
    const notifs = settings.notifications || {};
    for (const t of NOTIF_TYPES) renderNotifCard(t.key, notifs[t.key] || {});
    populateVoicePreview();
    loadPiperVoices();

    // Initialize sync settings (defined in sync-settings.js)
    if (typeof initSyncSettings === "function") initSyncSettings(settings);
  }

  updateVisibilities();

  // Auto-save on any input change
  for (const el of [iconStyle, timeStyle, tooltipLayout]) {
    el.addEventListener("change", saveSettings);
  }
  for (const el of [launchAtLogin, autoUpdate, tooltipShowSafePace, dashboardShowSession, dashboardShowWeekly, dashboardShowSafePace, colorApplyIcon, colorApplyNumber, colorApplyDashboard, colorApplyTooltip]) {
    el.addEventListener("change", saveSettings);
  }

  addColorBtn.onclick = () => {
    colorContainer.appendChild(createColorRow(0, "#9d7dfc"));
    saveSettings();
  };

  primeWebVoices();

  async function populateVoicePreview() {
    const history = await window.electronAPI.getTokenHistory();
    const seen = new Set();
    const projects = [];
    for (let i = history.length - 1; i >= 0 && projects.length < 5; i--) {
      const cwd = history[i].cwd;
      if (!cwd || seen.has(cwd)) continue;
      seen.add(cwd);
      projects.push(cwd);
    }
    voicePreviewProject.innerHTML = projects.length
      ? projects.map(p => `<option value="${p}">${p.split(/[\\/]/).pop()}</option>`).join("")
      : `<option value="">No projects yet</option>`;
  }

  voicePreviewProjectRow.style.display = "flex";

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

// ── Info tooltip positioning (fixed, viewport-clamped) ───────────────────────
for (const wrap of document.querySelectorAll(".info-wrap")) {
  const icon = wrap.querySelector(".info-icon");
  const tip = wrap.querySelector(".info-tooltip");
  if (!icon || !tip) continue;

  icon.addEventListener("mouseenter", () => {
    tip.style.display = "block";
    const iconRect = icon.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const pad = 8;

    let top = iconRect.top - tipRect.height - pad;
    let left = iconRect.left + iconRect.width / 2 - tipRect.width / 2;

    // clamp horizontal
    if (left < pad) left = pad;
    if (left + tipRect.width > window.innerWidth - pad) left = window.innerWidth - pad - tipRect.width;

    // flip below if no room above
    if (top < pad) top = iconRect.bottom + pad;

    tip.style.top = top + "px";
    tip.style.left = left + "px";
  });

  icon.addEventListener("mouseleave", () => {
    tip.style.display = "none";
  });
}
