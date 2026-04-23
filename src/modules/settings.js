"use strict";

// ── Theme definitions ─────────────────────────────────────────────────────────
const THEMES = [
  { id: "void",    label: "Void",    darkColors: ["#16151f", "#1e1d2b", "#9d7dfc", "#6e8fff", "#e2e0f0"], lightColors: ["#f0eff5", "#ffffff", "#7c5cdb", "#4a6bdf", "#1e1d2b"] },
  { id: "nebula",  label: "Nebula",  darkColors: ["#0f1629", "#172040", "#c084fc", "#a78bfa", "#e2dff0"], lightColors: ["#f2f0fa", "#ffffff", "#9333ea", "#7c3aed", "#1a1040"] },
  { id: "glacier", label: "Glacier", darkColors: ["#0c1a24", "#112430", "#38bdf8", "#22d3ee", "#e0f0f8"], lightColors: ["#eef6fa", "#ffffff", "#0284c7", "#0891b2", "#0c2430"] },
  { id: "cosmo",   label: "Cosmo",   darkColors: ["#1a0a1e", "#241430", "#f472b6", "#fb923c", "#f0e4f5"], lightColors: ["#faf0f4", "#ffffff", "#db2777", "#ea580c", "#2a1030"] },
];

function resolveThemeId(baseId, isLight) {
  return isLight ? baseId + "-light" : baseId;
}

function parseThemeId(fullId) {
  const isLight = fullId.endsWith("-light");
  return { baseId: isLight ? fullId.replace("-light", "") : fullId, isLight };
}

// ── Notification types ────────────────────────────────────────────────────────
const NOTIF_TYPES = [
  { key: "workFinished",     title: "Done (Work Finished)",     hint: "Supports {name}",    defaultSound: "sound1.mp3", defaultTemplate: "{name} is done" },
  { key: "questionAsked",    title: "Waiting (Question Asked)", hint: "Supports {name}",    defaultSound: "sound3.mp3", defaultTemplate: "{name} is waiting" },
  { key: "thresholdCrossed", title: "Threshold Reached",        hint: "Supports {percent}", defaultSound: "sound6.mp3", defaultTemplate: "{percent} threshold reached" },
];

// ── Module state ──────────────────────────────────────────────────────────────
const notifCards = {};
let piperStatusCache = null;
let isMac = false;
let _isMacResolved = false;

// ── Helpers ───────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

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

async function renderNotifCard(type, cfg) {
  const c = notifCards[type];
  if (!c) return;
  const def = NOTIF_TYPES.find(n => n.key === type);
  c.enabled.checked = cfg.enabled !== false;
  const mode = cfg.mode === "voice" ? "voice" : "sound";
  c.modes.forEach(r => { r.checked = r.value === mode; });

  const packs = await window.SoundPacks.loadPacks();
  const currentPack = cfg.soundPack || "default";
  const currentSound = cfg.soundFile || def.defaultSound;
  window.SoundPacks.populatePackSelect(c.soundPack, packs, currentPack);
  const pack = window.SoundPacks.findPack(packs, currentPack);
  window.SoundPacks.populateSoundSelect(c.soundFile, pack, currentSound);
  c.packInstall.style.display = (pack && !pack.installed) ? "inline-block" : "none";

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
  c.soundPack.addEventListener("change", async () => {
    const packs = await window.SoundPacks.loadPacks();
    const pack = window.SoundPacks.findPack(packs, c.soundPack.value);
    window.SoundPacks.populateSoundSelect(c.soundFile, pack, pack?.sounds[0]?.id);
    c.packInstall.style.display = (pack && !pack.installed) ? "inline-block" : "none";
    saveSettings();
  });
  c.packInstall.addEventListener("click", async () => {
    c.packInstall.disabled = true;
    c.packInstall.textContent = "Installing...";
    try {
      const packs = await window.SoundPacks.installPack(c.soundPack.value);
      const pack = window.SoundPacks.findPack(packs, c.soundPack.value);
      window.SoundPacks.populatePackSelect(c.soundPack, packs, c.soundPack.value);
      window.SoundPacks.populateSoundSelect(c.soundFile, pack, c.soundFile.value);
      c.packInstall.style.display = "none";
    } catch (e) {
      console.error("[pack install] failed", e);
      alert("Sound pack install failed. See console.");
    } finally {
      c.packInstall.disabled = false;
      c.packInstall.textContent = "Install";
    }
  });
  c.soundFile.addEventListener("change", saveSettings);
  c.template.addEventListener("input", saveSettings);
  c.voiceSelect.addEventListener("change", () => {
    c.voiceSelect.dataset.desired = c.voiceSelect.value || "";
    saveSettings();
  });
  c.soundPreview.onclick = () => {
    window.electronAPI.playPackSoundPreview(c.soundPack.value, c.soundFile.value).catch(e => {
      console.error("[sound preview] failed", e);
    });
  };
  c.voicePreview.onclick = () => {
    const voicePreviewProject = $("voicePreviewProject");
    const cwd = voicePreviewProject?.value || "";
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
  const notifCardsRoot = $("notifCards");
  const notifCardTemplate = $("notifCardTemplate");
  if (!notifCardsRoot || !notifCardTemplate) {
    console.error("[notif] template or root missing");
    return;
  }
  // Reset state for fresh mount
  for (const k of Object.keys(notifCards)) delete notifCards[k];
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
      soundPack: node.querySelector(".notif-sound-pack"),
      packInstall: node.querySelector(".notif-pack-install"),
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
  // If notif UI isn't mounted, preserve whatever is already in currentSettings.
  if (!Object.keys(notifCards).length) {
    return currentSettings.notifications || {};
  }
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
      soundPack: c.soundPack.value || "default",
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

// ── Save ──────────────────────────────────────────────────────────────────────
// Reads every DOM field defensively. When a settings subview isn't mounted, we
// fall back to whatever is already in currentSettings so save round-trips
// don't drop data.
function saveSettings() {
  const prev = currentSettings || {};
  const valOr = (id, fallback) => { const el = $(id); return el ? el.value : fallback; };
  const chkOr = (id, fallback) => { const el = $(id); return el ? el.checked : fallback; };

  const colorContainer = $("colorContainer");
  const thresholds = colorContainer
    ? Array.from(colorContainer.querySelectorAll(".color-row")).map((row) => ({
        min: parseInt(row.querySelector(".color-min").value, 10),
        color: row.querySelector(".color-val").value,
      })).sort((a, b) => a.min - b.min)
    : (prev.colorThresholds || []);

  const settings = {
    theme: document.documentElement.dataset.theme || prev.theme || "void",
    defaultDisplay: valOr("defaultDisplay", prev.defaultDisplay || "icon"),
    iconStyle: valOr("iconStyle", prev.iconStyle || "rings"),
    timeStyle: valOr("timeStyle", prev.timeStyle || "absolute"),
    tooltipLayout: valOr("tooltipLayout", prev.tooltipLayout || "rows"),
    tooltipShowSafePace: chkOr("tooltipShowSafePace", prev.tooltipShowSafePace !== false),
    launchAtLogin: chkOr("launchAtLogin", prev.launchAtLogin || false),
    autoUpdate: chkOr("autoUpdate", prev.autoUpdate || false),
    pinnedCards: Array.isArray(prev.pinnedCards) ? prev.pinnedCards : [],
    colorApplyTo: {
      icon: chkOr("colorApplyIcon", prev.colorApplyTo?.icon !== false),
      number: chkOr("colorApplyNumber", prev.colorApplyTo?.number !== false),
      dashboard: chkOr("colorApplyDashboard", prev.colorApplyTo?.dashboard !== false),
      tooltip: chkOr("colorApplyTooltip", prev.colorApplyTo?.tooltip !== false),
    },
    colorMode: valOr("colorMode", prev.colorMode || "threshold"),
    paceBand: parseInt(valOr("paceBand", prev.paceBand ?? 10), 10) || 10,
    paceColors: {
      under: valOr("paceColorUnder", prev.paceColors?.under || "#27ae60"),
      nearSafe: valOr("paceColorNearSafe", prev.paceColors?.nearSafe || "#f1c40f"),
      nearOver: valOr("paceColorNearOver", prev.paceColors?.nearOver || "#e67e22"),
      over: valOr("paceColorOver", prev.paceColors?.over || "#e74c3c"),
    },
    colorThresholds: thresholds,
    muteAll: chkOr("muteAllSwitch", prev.muteAll || false),
    muteSounds: chkOr("muteSoundsSwitch", prev.muteSounds || false),
    muteSystemNotifications: chkOr("muteSystemSwitch", prev.muteSystemNotifications || false),
    notifications: gatherNotifSettings(),
    projectAliases: prev.projectAliases || {},
    projectBlacklist: prev.projectBlacklist || [],
    projectNotifOverrides: prev.projectNotifOverrides || {},
    sync: prev.sync || { enabled: false, serverUrl: "", apiKey: "", deviceName: "" },
  };
  currentSettings = settings;
  window.electronAPI?.saveSettings(settings);
  if (typeof renderHistory === "function") renderHistory(lastHistory);
}
window.saveSettings = saveSettings;

// ── Visuals subview ───────────────────────────────────────────────────────────
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

function updateColorModeVisibility() {
  const colorMode = $("colorMode");
  const thresholdSection = $("thresholdSection");
  const paceSection = $("paceSection");
  if (!colorMode || !thresholdSection || !paceSection) return;
  const isPace = colorMode.value === "pace";
  thresholdSection.style.display = isPace ? "none" : "block";
  paceSection.style.display = isPace ? "block" : "none";
}

function wireInfoTooltips(root) {
  for (const wrap of root.querySelectorAll(".info-wrap")) {
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
      if (left < pad) left = pad;
      if (left + tipRect.width > window.innerWidth - pad) left = window.innerWidth - pad - tipRect.width;
      if (top < pad) top = iconRect.bottom + pad;
      tip.style.top = top + "px";
      tip.style.left = left + "px";
    });
    icon.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  }
}

window.renderVisualsSettings = function () {
  const s = currentSettings || {};
  const defaultDisplay = $("defaultDisplay");
  const iconStyle = $("iconStyle");
  const timeStyle = $("timeStyle");
  const tooltipLayout = $("tooltipLayout");
  const tooltipShowSafePace = $("tooltipShowSafePace");
  const colorApplyIcon = $("colorApplyIcon");
  const colorApplyNumber = $("colorApplyNumber");
  const colorApplyDashboard = $("colorApplyDashboard");
  const colorApplyTooltip = $("colorApplyTooltip");
  const colorContainer = $("colorContainer");
  const colorMode = $("colorMode");
  const paceBand = $("paceBand");
  const paceColorUnder = $("paceColorUnder");
  const paceColorNearSafe = $("paceColorNearSafe");
  const paceColorNearOver = $("paceColorNearOver");
  const paceColorOver = $("paceColorOver");
  const addColorBtn = $("addColorBtn");
  const iconStyleSection = $("iconStyleSection");
  if (!defaultDisplay) return;

  defaultDisplay.value = s.defaultDisplay || "icon";
  iconStyle.value = s.iconStyle || "rings";
  timeStyle.value = s.timeStyle || "absolute";
  tooltipLayout.value = s.tooltipLayout || "rows";
  tooltipShowSafePace.checked = s.tooltipShowSafePace !== false;
  const cat = s.colorApplyTo || {};
  colorApplyIcon.checked = cat.icon !== false;
  colorApplyNumber.checked = cat.number !== false;
  colorApplyDashboard.checked = cat.dashboard !== false;
  colorApplyTooltip.checked = cat.tooltip !== false;
  colorMode.value = s.colorMode || "threshold";
  paceBand.value = s.paceBand ?? 10;
  const pc = s.paceColors || {};
  paceColorUnder.value = pc.under || "#27ae60";
  paceColorNearSafe.value = pc.nearSafe || "#f1c40f";
  paceColorNearOver.value = pc.nearOver || "#e67e22";
  paceColorOver.value = pc.over || "#e74c3c";

  const DEFAULT_THRESHOLDS = [
    { min: 0,  color: "#27ae60" },
    { min: 50, color: "#e67e22" },
    { min: 80, color: "#e74c3c" },
  ];
  const thresholds = (s.colorThresholds && s.colorThresholds.length) ? s.colorThresholds : DEFAULT_THRESHOLDS;
  colorContainer.innerHTML = "";
  thresholds.forEach((t) => colorContainer.appendChild(createColorRow(t.min, t.color)));

  updateColorModeVisibility();
  if (iconStyleSection) iconStyleSection.style.display = "flex";

  for (const el of [iconStyle, timeStyle, tooltipLayout]) el.addEventListener("change", saveSettings);
  for (const el of [tooltipShowSafePace, colorApplyIcon, colorApplyNumber, colorApplyDashboard, colorApplyTooltip]) {
    el.addEventListener("change", saveSettings);
  }
  defaultDisplay.addEventListener("change", saveSettings);
  colorMode.addEventListener("change", () => { updateColorModeVisibility(); saveSettings(); });
  paceBand.addEventListener("change", saveSettings);
  paceColorUnder.addEventListener("change", saveSettings);
  paceColorNearSafe.addEventListener("change", saveSettings);
  paceColorNearOver.addEventListener("change", saveSettings);
  paceColorOver.addEventListener("change", saveSettings);
  addColorBtn.onclick = () => { colorContainer.appendChild(createColorRow(0, "#9d7dfc")); saveSettings(); };

  wireInfoTooltips(document.getElementById("app") || document);
};

// ── Themes subview ────────────────────────────────────────────────────────────
function renderThemeCards(activeTheme) {
  const themeGrid = $("themeGrid");
  const modeLabelDark = $("modeLabelDark");
  const modeLabelLight = $("modeLabelLight");
  if (!themeGrid) return;
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

  if (modeLabelDark) modeLabelDark.style.color = isLight ? "var(--text-dim)" : "var(--primary)";
  if (modeLabelLight) modeLabelLight.style.color = isLight ? "var(--primary)" : "var(--text-dim)";
}

function applyTheme(baseId) {
  const themeModToggle = $("themeModToggle");
  const isLight = themeModToggle ? themeModToggle.checked : false;
  const fullId = resolveThemeId(baseId, isLight);
  document.documentElement.dataset.theme = fullId;
  currentSettings.theme = fullId;
  saveSettings();

  const themeGrid = $("themeGrid");
  if (themeGrid) {
    for (const card of themeGrid.querySelectorAll(".theme-card")) {
      card.classList.toggle("active", card.dataset.themeId === baseId);
    }
  }
  const modeLabelDark = $("modeLabelDark");
  const modeLabelLight = $("modeLabelLight");
  if (modeLabelDark) modeLabelDark.style.color = isLight ? "var(--text-dim)" : "var(--primary)";
  if (modeLabelLight) modeLabelLight.style.color = isLight ? "var(--primary)" : "var(--text-dim)";
}

window.renderThemesSettings = function () {
  const themeModToggle = $("themeModToggle");
  if (!themeModToggle) return;
  const savedTheme = (currentSettings && currentSettings.theme) || document.documentElement.dataset.theme || "void";
  themeModToggle.checked = savedTheme.endsWith("-light");
  renderThemeCards(savedTheme);

  themeModToggle.onchange = () => {
    const { baseId } = parseThemeId(currentSettings.theme || "void");
    const isLight = themeModToggle.checked;
    const fullId = resolveThemeId(baseId, isLight);
    document.documentElement.dataset.theme = fullId;
    currentSettings.theme = fullId;
    saveSettings();
    renderThemeCards(fullId);
  };
};

// ── Notifications subview ─────────────────────────────────────────────────────
function applyMuteAllVisual() {
  const muteAllSwitch = $("muteAllSwitch");
  const muteSection = $("muteSection");
  if (!muteAllSwitch || !muteSection) return;
  muteSection.classList.toggle("mute-all-on", muteAllSwitch.checked);
}

async function populateVoicePreview() {
  const voicePreviewProject = $("voicePreviewProject");
  if (!voicePreviewProject) return;
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

window.renderNotificationSettings = async function () {
  const s = currentSettings || {};
  const muteAllSwitch = $("muteAllSwitch");
  const muteSoundsSwitch = $("muteSoundsSwitch");
  const muteSystemSwitch = $("muteSystemSwitch");
  const voicePreviewProjectRow = $("voicePreviewProjectRow");
  if (!muteAllSwitch) return;

  muteAllSwitch.checked = !!s.muteAll;
  muteSoundsSwitch.checked = !!s.muteSounds;
  muteSystemSwitch.checked = !!s.muteSystemNotifications;
  applyMuteAllVisual();

  muteAllSwitch.addEventListener("change", () => { applyMuteAllVisual(); saveSettings(); });
  muteSoundsSwitch.addEventListener("change", saveSettings);

  buildNotifCards();
  const notifs = s.notifications || {};
  await Promise.all(NOTIF_TYPES.map(t => renderNotifCard(t.key, notifs[t.key] || {})));
  populateVoicePreview();
  loadPiperVoices();
  primeWebVoices();

  if (voicePreviewProjectRow) voicePreviewProjectRow.style.display = "flex";
};

// ── Update state (version row on Settings root) ──────────────────────────────
function renderUpdateState(updateState) {
  const updateStateLabel = $("updateStateLabel");
  const updateBtn = $("updateBtn");
  const macUpdateNotice = $("macUpdateNotice");
  const macReleasesBtn = $("macReleasesBtn");
  if (!updateStateLabel || !updateBtn) return;

  const hasUpdate = updateState.state === "available" ||
    updateState.state === "downloaded" ||
    updateState.state === "downloading" ||
    updateState.state === "error";

  if (isMac && hasUpdate) {
    updateStateLabel.innerText = `v${updateState.version} available`;
    updateStateLabel.style.color = "var(--text)";
    updateBtn.style.display = "none";
    if (macUpdateNotice) macUpdateNotice.style.display = "block";
    if (macReleasesBtn) {
      macReleasesBtn.onclick = () => {
        window.electronAPI?.openExternal(
          `https://github.com/SirBepy/claude_usage_in_taskbar/releases/tag/v${updateState.version}`
        );
      };
    }
    return;
  }

  if (macUpdateNotice) macUpdateNotice.style.display = "none";

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
window.renderUpdateState = renderUpdateState;

window.renderSettingsRoot = async function () {
  const s = currentSettings || {};
  const launchAtLogin = $("launchAtLogin");
  const autoUpdate = $("autoUpdate");
  const refreshUpdateBtn = $("refreshUpdateBtn");
  const copyLogsBtn = $("copyLogsBtn");
  const appVersionLabel = $("appVersionLabel");
  const autoUpdateRow = $("autoUpdateRow");
  if (!launchAtLogin) return;

  if (!_isMacResolved) {
    const platform = await window.electronAPI?.getPlatform();
    isMac = platform === "darwin";
    _isMacResolved = true;
  }
  if (isMac && autoUpdateRow) autoUpdateRow.style.display = "none";

  launchAtLogin.checked = !!s.launchAtLogin;
  autoUpdate.checked = !!s.autoUpdate;
  launchAtLogin.addEventListener("change", saveSettings);
  autoUpdate.addEventListener("change", saveSettings);

  refreshUpdateBtn.addEventListener("click", () => {
    window.electronAPI?.checkForUpdates();
    const updateStateLabel = $("updateStateLabel");
    const updateBtn = $("updateBtn");
    if (updateStateLabel) {
      updateStateLabel.innerText = "Checking...";
      updateStateLabel.style.color = "var(--text-dim)";
    }
    if (updateBtn) updateBtn.style.display = "none";
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

  const version = await window.electronAPI?.getAppVersion();
  if (version && appVersionLabel) appVersionLabel.innerText = `Version: ${version}`;

  const initialState = await window.electronAPI?.getUpdateState();
  if (initialState) renderUpdateState(initialState);
  window.electronAPI?.onUpdateStateChange(renderUpdateState);
};

// ── Initial settings load (runs once at script start, no DOM access) ─────────
window.addEventListener("load", async () => {
  const settings = await window.electronAPI?.getSettings();
  if (!settings) return;
  settings.colorApplyTo = {
    icon: settings.colorApplyTo?.icon !== false,
    number: settings.colorApplyTo?.number !== false,
    dashboard: settings.colorApplyTo?.dashboard !== false,
    tooltip: settings.colorApplyTo?.tooltip !== false,
  };
  if (!Array.isArray(settings.pinnedCards)) settings.pinnedCards = [];
  currentSettings = settings;
  const savedTheme = settings.theme || "void";
  document.documentElement.dataset.theme = savedTheme;
});
