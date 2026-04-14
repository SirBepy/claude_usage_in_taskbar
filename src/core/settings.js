"use strict";

const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");

const DEFAULT_SETTINGS = {
  theme: "void", // "void" | "void-light" | "nebula" | "nebula-light" | "glacier" | "glacier-light" | "cosmo" | "cosmo-light"
  iconStyle: "rings", // "rings" | "bars"
  timeStyle: "absolute", // "absolute" | "countdown"
  launchAtLogin: false,
  estimateTokens: false,
  showSafePace: true,
  sessionPlan: 44000,
  weeklyPlan: 200000,
  defaultDisplay: "icon", // "icon" | "session" | "weekly"
  overlayStyle: "classic",
  colorApplyTo: { icon: true, number: true, dashboard: true, tooltip: true },
  colorMode: "threshold", // "threshold" | "pace"
  paceBand: 10,
  paceColors: {
    under: "#27ae60",
    nearSafe: "#f1c40f",
    nearOver: "#e67e22",
    over: "#e74c3c",
  },
  colorThresholds: [
    { min: 0, color: "#27ae60" },
    { min: 50, color: "#e67e22" },
    { min: 80, color: "#e74c3c" },
  ],
  notifications: {
    workFinished: {
      enabled: true,
      mode: "sound", // "sound" | "voice"
      soundFile: "sound1.mp3",
      voiceName: null,
      template: "{name} is done",
    },
    questionAsked: {
      enabled: true,
      mode: "sound",
      soundFile: "sound3.mp3",
      voiceName: null,
      template: "{name} is waiting",
    },
    thresholdCrossed: {
      enabled: true,
      mode: "sound",
      soundFile: "sound6.mp3",
      voiceName: null,
      template: "{percent} threshold reached",
    },
  },
  sync: {
    enabled: false,
    serverUrl: "",
    apiKey: "",
    deviceName: "",
  },
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const data = fs.readFileSync(SETTINGS_PATH, "utf8");
      const saved = JSON.parse(data);

      // Migrate old displayMode/overlayDisplay to defaultDisplay
      if (saved.displayMode && !saved.defaultDisplay) {
        if (saved.displayMode === "number" && saved.overlayDisplay === "weekly") {
          saved.defaultDisplay = "weekly";
        } else if (saved.displayMode === "number") {
          saved.defaultDisplay = "session";
        } else {
          saved.defaultDisplay = "icon";
        }
        delete saved.displayMode;
        delete saved.overlayDisplay;
      }

      // Migrate old sounds/voice blocks to unified notifications block
      if ((saved.sounds || saved.voice) && !saved.notifications) {
        const oldSounds = saved.sounds || {};
        const oldVoice = saved.voice || {};
        const voiceMode = oldVoice.enabled ? "voice" : "sound";
        const voiceName = oldVoice.voiceName || null;
        const includeName = oldVoice.includeProjectName !== false;
        const nameTok = includeName ? "{name} " : "";
        const mk = (evt, defaults, voiceText) => ({
          enabled: !!(oldSounds[evt]?.enabled) || !!oldVoice.enabled,
          mode: voiceMode,
          soundFile: oldSounds[evt]?.file || defaults.soundFile,
          voiceName,
          template: voiceText,
        });
        saved.notifications = {
          workFinished: mk("workFinished", { soundFile: "sound1.mp3" }, `${nameTok}is done`.trim()),
          questionAsked: mk("questionAsked", { soundFile: "sound3.mp3" }, `${nameTok}is waiting`.trim()),
          thresholdCrossed: {
            enabled: !!(oldSounds.thresholdCrossed?.enabled) || !!oldVoice.enabled,
            mode: voiceMode,
            soundFile: oldSounds.thresholdCrossed?.file || "sound6.mp3",
            voiceName,
            template: "{percent} threshold reached",
          },
        };
        delete saved.sounds;
        delete saved.voice;
      }

      const merged = { ...DEFAULT_SETTINGS, ...saved };
      merged.notifications = {
        ...DEFAULT_SETTINGS.notifications,
        ...(saved.notifications || {}),
      };
      return merged;
    }
  } catch (e) {
    console.error("Failed to load settings:", e);
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

    // Sync with Electron's login item settings
    if (app.isPackaged && typeof settings.launchAtLogin === "boolean") {
      app.setLoginItemSettings({
        openAtLogin: settings.launchAtLogin,
        args: ["--hidden"],
      });
    }
  } catch (e) {
    console.error("Failed to save settings:", e);
  }
}

module.exports = { loadSettings, saveSettings };
