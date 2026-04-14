"use strict";

const { Tray, Menu } = require("electron");
const { makeIcon, makeSpinFrame } = require("./icon");
const {
  parseSessionPct,
  parseWeeklyPct,
  buildTooltip,
  calcSafePct,
} = require("./usage-parser");

// ── State ────────────────────────────────────────────────────────────────────
let tray = null;
let tempDisplay = null;
let tempDisplayCycle = null;
let tempDisplayIndex = 0;
let tempDisplayTimer = null;
let lastUsageData = null;

// Callbacks set during createTray
let _settings = null;
let _getSettings = null;

function hasThresholdCrossed(prevPct, newPct, thresholds) {
  if (prevPct == null || newPct == null || !thresholds) return false;
  return thresholds.some((t) => prevPct < t.min && newPct >= t.min);
}

function defaultDisplayToMode(def) {
  if (def === "session") return { displayMode: "number", overlayDisplay: "session" };
  if (def === "weekly") return { displayMode: "number", overlayDisplay: "weekly" };
  return { displayMode: "icon" };
}

function getActiveSettings() {
  const s = _getSettings();
  if (tempDisplay) return { ...s, ...tempDisplay };
  return { ...s, ...defaultDisplayToMode(s.defaultDisplay) };
}

function buildDisplayCycle(settings) {
  const def = settings.defaultDisplay || "icon";
  const allStates = [
    { displayMode: "icon" },
    { displayMode: "number", overlayDisplay: "session" },
    { displayMode: "number", overlayDisplay: "weekly" },
  ];
  // Map default setting to the matching state index
  const defaultIndex = def === "session" ? 1 : def === "weekly" ? 2 : 0;
  // Cycle: default first, then remaining two in fixed order
  const cycle = [allStates[defaultIndex]];
  for (let i = 0; i < allStates.length; i++) {
    if (i !== defaultIndex) cycle.push(allStates[i]);
  }
  return cycle;
}

function cycleDisplayMode() {
  const settings = _getSettings();
  if (!tempDisplayCycle) {
    tempDisplayCycle = buildDisplayCycle(settings);
    tempDisplayIndex = 0;
  }

  tempDisplayIndex = (tempDisplayIndex + 1) % tempDisplayCycle.length;
  tempDisplay = tempDisplayCycle[tempDisplayIndex];
  updateTray();

  if (tempDisplayTimer) clearTimeout(tempDisplayTimer);
  tempDisplayTimer = setTimeout(resetDisplayMode, 60 * 1000);
}

function resetDisplayMode() {
  tempDisplay = null;
  tempDisplayCycle = null;
  tempDisplayIndex = 0;
  tempDisplayTimer = null;
  updateTray();
}

function clearTempDisplay() {
  if (tempDisplayTimer) clearTimeout(tempDisplayTimer);
  tempDisplay = null;
  tempDisplayCycle = null;
  tempDisplayIndex = 0;
  tempDisplayTimer = null;
}

function updateTray(usageData) {
  if (!tray) return;
  if (usageData !== undefined) lastUsageData = usageData;
  const data = lastUsageData;
  const s = getActiveSettings();
  const iconSettings = {
    ...s,
    _sessionSafe: calcSafePct(data?.five_hour?.resets_at, 5 * 3600000),
    _weeklySafe: calcSafePct(data?.seven_day?.resets_at, 7 * 24 * 3600000),
  };
  tray.setImage(makeIcon(parseSessionPct(data), parseWeeklyPct(data), iconSettings));
  tray.setToolTip(buildTooltip(data, s));
}

function buildContextMenu(callbacks) {
  const { loggedIn, loggingIn, getUpdateState, showLoginWindow, showDashboardWindow, refreshWithAnimation, quitAndInstall, downloadUpdate, downloadAndInstall, quit } = callbacks;
  const { state, version } = getUpdateState();

  let statusItems;
  if (loggedIn) {
    statusItems = [
      { label: "Refresh", click: () => refreshWithAnimation() },
      { label: "Dashboard", click: showDashboardWindow },
      { type: "separator" },
    ];
  } else if (loggingIn) {
    statusItems = [
      { label: "Logging in...", enabled: false },
      { type: "separator" },
    ];
  } else {
    statusItems = [
      { label: "Log In", click: showLoginWindow },
      { type: "separator" },
    ];
  }

  const template = [...statusItems, { label: "Quit", click: quit }];

  if (state === "downloaded") {
    template.unshift(
      { label: `Restart to update to v${version}`, click: quitAndInstall },
      { type: "separator" },
    );
  } else if (state === "downloading") {
    template.unshift(
      { label: `Downloading v${version}…`, enabled: false },
      { type: "separator" },
    );
  } else if (state === "available") {
    template.unshift(
      { label: `Download & install v${version}`, click: downloadAndInstall },
      { type: "separator" },
    );
  }

  return Menu.buildFromTemplate(template);
}

function createTray(callbacks) {
  const { getSettings, isLoggedIn, onLeftClick, onRightClick } = callbacks;
  _getSettings = getSettings;

  tray = new Tray(makeIcon(null, null, getSettings()));
  tray.setToolTip("Claude Usage — Initializing...");

  tray.on("click", () => {
    if (isLoggedIn()) {
      cycleDisplayMode();
    } else {
      onLeftClick();
    }
  });

  tray.on("right-click", () => {
    onRightClick();
  });

  return tray;
}

function getTray() {
  return tray;
}

function setSpinImage(frame, weeklyPct) {
  tray?.setImage(makeSpinFrame(frame, weeklyPct, getActiveSettings()));
}

module.exports = {
  createTray,
  updateTray,
  buildContextMenu,
  cycleDisplayMode,
  resetDisplayMode,
  clearTempDisplay,
  getActiveSettings,
  hasThresholdCrossed,
  getTray,
  setSpinImage,
};
