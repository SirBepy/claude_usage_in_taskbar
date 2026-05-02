/**
 * Ported from src/modules/settings.js saveSettings().
 * Reads every DOM field defensively. When a subview isn't mounted, falls back
 * to whatever is already in currentSettings so round-trips don't drop data.
 */

import { getSettings, setSettings } from "./state";
import type { SettingsShape } from "./state";
import { api } from "./api";

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export interface NotifCardRef {
  enabled: HTMLInputElement;
  modes: NodeListOf<HTMLInputElement>;
  soundPack: HTMLSelectElement;
  soundFile: HTMLSelectElement;
  voiceSelect: HTMLSelectElement;
  template: HTMLInputElement;
}

export const NOTIF_TYPES: Array<{
  key: string; title: string; hint: string; defaultSound: string; defaultTemplate: string;
}> = [
  { key: "workFinished",     title: "Done (Work Finished)",     hint: "Supports {name}",    defaultSound: "sound1.mp3", defaultTemplate: "{name} is done" },
  { key: "questionAsked",    title: "Waiting (Question Asked)", hint: "Supports {name}",    defaultSound: "sound3.mp3", defaultTemplate: "{name} is waiting" },
  { key: "thresholdCrossed", title: "Threshold Reached",        hint: "Supports {percent}", defaultSound: "sound6.mp3", defaultTemplate: "{percent} threshold reached" },
];

// Shared registry used by the notifications subview to publish card refs.
export const notifCards: Record<string, NotifCardRef> = {};

export function resetNotifCards(): void {
  for (const k of Object.keys(notifCards)) delete notifCards[k];
}

function gatherNotifSettings(prev: SettingsShape): Record<string, unknown> {
  if (!Object.keys(notifCards).length) {
    return (prev.notifications as Record<string, unknown>) || {};
  }
  const out: Record<string, unknown> = {};
  for (const t of NOTIF_TYPES) {
    const c = notifCards[t.key];
    if (!c) {
      out[t.key] = { enabled: true, mode: "sound", soundFile: t.defaultSound, voiceName: null, template: t.defaultTemplate };
      continue;
    }
    const mode = Array.from(c.modes).find((r) => r.checked)?.value || "sound";
    out[t.key] = {
      enabled: c.enabled.checked,
      mode,
      soundPack: c.soundPack.value || "default",
      soundFile: c.soundFile.value,
      voiceName: c.voiceSelect.value || c.voiceSelect.dataset.desired || null,
      template: c.template.value || t.defaultTemplate,
    };
  }
  return out;
}

export function saveSettings(): void {
  const prev = getSettings();
  const valOr = (id: string, fallback: string): string => {
    const el = byId<HTMLInputElement | HTMLSelectElement>(id);
    return el ? el.value : fallback;
  };
  const chkOr = (id: string, fallback: boolean): boolean => {
    const el = byId<HTMLInputElement>(id);
    return el ? el.checked : fallback;
  };

  const colorContainer = byId("colorContainer");
  const thresholds = colorContainer
    ? Array.from(colorContainer.querySelectorAll<HTMLElement>(".color-row")).map((row) => ({
        min: parseInt((row.querySelector(".color-min") as HTMLInputElement).value, 10),
        color: (row.querySelector(".color-val") as HTMLInputElement).value,
      })).sort((a, b) => a.min - b.min)
    : (prev.colorThresholds || []);

  const prevColorApply = (prev.colorApplyTo as Record<string, boolean | undefined>) || {};
  const prevPace = (prev.paceColors as Record<string, string | undefined>) || {};
  const prevSync = (prev.sync as Record<string, unknown>) || { enabled: false, serverUrl: "", apiKey: "", deviceName: "" };

  const settings: SettingsShape = {
    theme: document.documentElement.dataset.theme || (prev.theme as string) || "void",
    defaultDisplay: valOr("defaultDisplay", (prev.defaultDisplay as string) || "icon"),
    iconStyle: valOr("iconStyle", (prev.iconStyle as string) || "rings"),
    timeStyle: valOr("timeStyle", (prev.timeStyle as string) || "absolute"),
    tooltipLayout: valOr("tooltipLayout", (prev.tooltipLayout as string) || "rows"),
    tooltipShowSafePace: chkOr("tooltipShowSafePace", prev.tooltipShowSafePace !== false),
    launchAtLogin: chkOr("launchAtLogin", !!prev.launchAtLogin),
    autoUpdate: (() => {
      const el = byId<HTMLSelectElement>("autoUpdate");
      if (el && (el.value === "never" || el.value === "onStartup" || el.value === "immediate")) return el.value;
      const p = prev.autoUpdate;
      if (p === true) return "immediate";
      if (p === false) return "never";
      if (typeof p === "string" && (p === "never" || p === "onStartup" || p === "immediate")) return p;
      return "immediate";
    })(),
    pinnedCards: Array.isArray(prev.pinnedCards) ? prev.pinnedCards : [],
    colorApplyTo: {
      icon: chkOr("colorApplyIcon", prevColorApply.icon !== false),
      number: chkOr("colorApplyNumber", prevColorApply.number !== false),
      dashboard: chkOr("colorApplyDashboard", prevColorApply.dashboard !== false),
      tooltip: chkOr("colorApplyTooltip", prevColorApply.tooltip !== false),
    },
    colorMode: valOr("colorMode", (prev.colorMode as string) || "pace") as "threshold" | "pace",
    paceBand: parseInt(valOr("paceBand", String(prev.paceBand ?? 10)), 10) || 10,
    paceColors: {
      under: valOr("paceColorUnder", prevPace.under || "#27ae60"),
      nearSafe: valOr("paceColorNearSafe", prevPace.nearSafe || "#f1c40f"),
      nearOver: valOr("paceColorNearOver", prevPace.nearOver || "#e67e22"),
      over: valOr("paceColorOver", prevPace.over || "#e74c3c"),
    },
    colorThresholds: thresholds,
    fourBarsSessionSafeColor: valOr("fourBarsSessionSafeColor", (prev.fourBarsSessionSafeColor as string) || ""),
    fourBarsWeeklySafeColor: valOr("fourBarsWeeklySafeColor", (prev.fourBarsWeeklySafeColor as string) || ""),
    muteAll: chkOr("muteAllSwitch", !!prev.muteAll),
    muteSounds: chkOr("muteSoundsSwitch", !!prev.muteSounds),
    muteSystemNotifications: chkOr("muteSystemSwitch", !!prev.muteSystemNotifications),
    notifications: gatherNotifSettings(prev),
    projectAliases: prev.projectAliases || {},
    projectBlacklist: prev.projectBlacklist || [],
    projectNotifOverrides: prev.projectNotifOverrides || {},
    sync: prevSync,
    // Preserve unknown extras
    projects: prev.projects,
  };

  setSettings(settings);
  void api.saveSettings(settings);
  const w = window as unknown as {
    renderHistory?: (h: unknown) => void;
    lastHistory?: unknown;
  };
  if (typeof w.renderHistory === "function") w.renderHistory(w.lastHistory);
}

// Back-compat: expose on window for any legacy callers (stats.js, dashboard.js).
(window as unknown as { saveSettings?: () => void }).saveSettings = saveSettings;
