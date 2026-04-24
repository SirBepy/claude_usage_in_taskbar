/**
 * Boot-time wiring extracted from the legacy src/dashboard.js.
 *
 * Owns:
 *  - initial data fetch (usage history, token history with live merge, settings)
 *  - refreshDashboard + dead-path check once all three land
 *  - live subscriptions (onHistoryUpdated, onTokenHistoryUpdated, onInstancesChanged)
 *  - hook-registration consent modal wiring
 *  - legacy obsidian_claude_remote import banner wiring
 *
 * All state goes through src/shared/state.ts. DOM-level static templates live
 * in src/index.html; this module only wires button handlers.
 */

import {
  getSettings,
  setSettings,
  setTokenHistory,
  setUsageHistory,
  getTokenHistory,
} from "./state";
import type { SettingsShape } from "./state";
import type { TokenRecord, AliasMap } from "./tokens";
import { doMerge } from "./merges";
import { showToast } from "./toast";
import { api } from "./api";
import { refreshDashboard } from "../views/statistics/statistics";
import { renderProjectsList } from "../views/projects/projects";
import { renderProjectDetailContent } from "../views/project-detail/project-detail";

function activeViewName(): string {
  return window.location.hash.replace(/^#/, "") || "dashboard";
}

// ── Live token history merge ───────────────────────────────────────────────
async function fetchTokenHistoryWithLive(): Promise<TokenRecord[]> {
  const history = (await api.getTokenHistory()) ?? [];
  try {
    const active = (await api.getActiveSessions()) ?? [];
    if (active.length) return [...history, ...active];
  } catch {
    // handler may not be registered yet
  }
  return history;
}

// ── Dead-path reconciliation ──────────────────────────────────────────────
const deadPaths = new Set<string>();

async function runDeadPathCheck(): Promise<void> {
  const tokenHistory = getTokenHistory();
  if (!tokenHistory || !tokenHistory.length) return;
  const settings = getSettings();
  const aliases: AliasMap = (settings.projectAliases as AliasMap) || {};

  const cwds = [
    ...new Set(tokenHistory.map((r) => r.cwd).filter((c): c is string => !!c)),
  ].filter((c) => !aliases[c]?.mergedInto);
  if (!cwds.length) return;

  const allPathsToCheck = new Set<string>(cwds);
  for (const c of cwds) {
    const merged = aliases[c]?.mergedPaths || [];
    for (const m of merged) allPathsToCheck.add(m);
  }

  const existsMap = await api.checkPathsExist([...allPathsToCheck]);

  const isProjectAlive = (c: string): boolean => {
    if (existsMap[c]) return true;
    const merged = aliases[c]?.mergedPaths || [];
    return merged.some((m) => existsMap[m]);
  };

  const dead = cwds.filter((c) => !isProjectAlive(c));
  if (!dead.length) return;
  const live = cwds.filter(isProjectAlive);

  let anyMerged = false;
  for (const deadCwd of dead) {
    const deadName =
      deadCwd.split(/[/\\]/).filter(Boolean).pop()?.toLowerCase() || "";
    const matches = live.filter(
      (lc) =>
        (lc.split(/[/\\]/).filter(Boolean).pop()?.toLowerCase() || "") ===
        deadName,
    );
    if (matches.length === 1 && matches[0]) {
      doMerge(aliases, deadCwd, matches[0]);
      settings.projectAliases = aliases;
      setSettings(settings);
      void api.saveSettings(settings);
      anyMerged = true;
    } else {
      deadPaths.add(deadCwd);
    }
  }
  if (anyMerged) {
    void renderProjectsList();
    refreshDashboard();
  } else if (deadPaths.size) {
    void renderProjectsList();
  }
}

// ── Hook-registration consent modal ────────────────────────────────────────
async function renderHookModalPreview(): Promise<void> {
  const state = await api.getHookRegistrationState();
  const port = state?.port ?? "?";
  const preview = [
    `"hooks": {`,
    `  "SessionStart": [{`,
    `    "matcher": "aiusage-taskbar",`,
    `    "hooks": [{ "type": "command",`,
    `      "command": "curl -sS -X POST … :${port}/hooks/session-start" }]`,
    `  }],`,
    `  "SessionEnd": [{ ... similarly … }]`,
    `}`,
  ].join("\n");
  const el = document.getElementById("hookModalPreview");
  if (el) el.textContent = preview;
}

function hideHookModal(): void {
  const b = document.getElementById("hookModalBackdrop");
  const m = document.getElementById("hookModal");
  if (b) b.style.display = "none";
  if (m) m.style.display = "none";
}

function showHookModal(): void {
  const b = document.getElementById("hookModalBackdrop");
  const m = document.getElementById("hookModal");
  if (b) b.style.display = "block";
  if (m) m.style.display = "block";
  void renderHookModalPreview();
}

async function maybeShowHookModal(): Promise<void> {
  const state = await api.getHookRegistrationState();
  if (!state || state.registered || state.declined) return;
  showHookModal();
}

function wireHookModal(): void {
  const accept = document.getElementById("hookModalAccept");
  const skip = document.getElementById("hookModalSkip");
  const never = document.getElementById("hookModalNever");

  if (accept) {
    (accept as HTMLButtonElement).onclick = async () => {
      try {
        await api.registerHooksGlobally();
        hideHookModal();
        showToast("Hooks enabled. Running instances will now show up.");
      } catch (e) {
        showToast(`Hook install failed: ${String(e)}`);
      }
    };
  }
  if (skip) {
    (skip as HTMLButtonElement).onclick = () => {
      hideHookModal();
    };
  }
  if (never) {
    (never as HTMLButtonElement).onclick = async () => {
      await api.skipHookRegistration();
      hideHookModal();
    };
  }
}

// ── Legacy obsidian_claude_remote import banner ────────────────────────────
async function maybeOfferLegacyImport(): Promise<void> {
  let preview: unknown;
  try {
    preview = await api.importLegacyObsidianConfig();
  } catch {
    return;
  }
  if (!preview) return;
  const banner = document.getElementById("legacyImportBanner");
  if (!banner) return;
  banner.style.display = "flex";

  const finish = async (accept: boolean): Promise<void> => {
    banner.style.display = "none";
    try {
      await api.confirmLegacyObsidianImport(accept);
    } catch (e) {
      console.error("confirm_legacy_obsidian_import failed", e);
    }
    if (accept) showToast("Imported. See Projects.");
  };

  const acceptBtn = document.getElementById("legacyImportAccept");
  const dismissBtn = document.getElementById("legacyImportDismiss");
  if (acceptBtn) (acceptBtn as HTMLButtonElement).onclick = () => void finish(true);
  if (dismissBtn) (dismissBtn as HTMLButtonElement).onclick = () => void finish(false);
}

// ── Initial-render gating ──────────────────────────────────────────────────
let initUsage: unknown = null;
let initTokens: TokenRecord[] | null = null;
let initSettings = false;

function tryInitialRender(): void {
  if (initUsage && initTokens && initSettings) {
    refreshDashboard();
    void runDeadPathCheck();
  }
}

function coerceSettings(s: SettingsShape): SettingsShape {
  const colorApplyTo = (s.colorApplyTo as Record<string, boolean | undefined> | undefined) || {};
  s.colorApplyTo = {
    icon: colorApplyTo.icon !== false,
    number: colorApplyTo.number !== false,
    dashboard: colorApplyTo.dashboard !== false,
    tooltip: colorApplyTo.tooltip !== false,
  };
  if (!Array.isArray(s.pinnedCards)) s.pinnedCards = [];
  return s;
}

// ── Public entrypoint ──────────────────────────────────────────────────────
export function initBoot(): void {
  // Initial data fetches.
  void api.getUsageHistory().then((h) => {
    initUsage = h;
    setUsageHistory(h);
    tryInitialRender();
  });
  void fetchTokenHistoryWithLive().then((th) => {
    initTokens = th;
    setTokenHistory(th);
    tryInitialRender();
  });
  void api.getSettings().then((s) => {
    if (s) {
      const coerced = coerceSettings(s);
      setSettings(coerced);
    }
    initSettings = true;
    tryInitialRender();
  });

  // Live subscriptions.
  api.onHistoryUpdated((h) => {
    setUsageHistory(h);
    refreshDashboard();
    if (activeViewName() === "projects") void renderProjectsList();
  });
  api.onTokenHistoryUpdated(async (th) => {
    let active: TokenRecord[] = [];
    try {
      active = (await api.getActiveSessions()) ?? [];
    } catch {
      /* ignore */
    }
    const merged = active.length ? [...(th || []), ...active] : th || [];
    setTokenHistory(merged);
    refreshDashboard();
    const view = activeViewName();
    if (view === "projects") void renderProjectsList();
    if (view === "project-detail") renderProjectDetailContent();
  });
  api.onInstancesChanged(() => {
    if (activeViewName() === "projects") void renderProjectsList();
  });

  // Modal + banner wiring (idempotent; safe to call on boot).
  wireHookModal();
  void maybeOfferLegacyImport();
  void maybeShowHookModal();
}
