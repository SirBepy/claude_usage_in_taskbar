import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { saveSettings } from "../../shared/settings-save";
import { getSettings } from "../../shared/state";
import { api } from "../../shared/api";
import type { UpdateState } from "../../shared/api";
import * as shortcuts from "../../shared/shortcuts";
import { normalizeEvent } from "../../shared/shortcuts";
import type { ShortcutDef } from "../../shared/shortcuts";
import "./settings.css";

export { saveSettings };

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
  renderUpdateState?: (s: UpdateState) => void;
  renderSettingsRoot?: () => Promise<void> | void;
  saveSettings?: () => void;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

let isMac = false;
let _isMacResolved = false;

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function renderUpdateState(updateState: UpdateState): void {
  const updateStateLabel = $("updateStateLabel");
  const updateBtn = $("updateBtn") as HTMLButtonElement | null;
  const macUpdateNotice = $("macUpdateNotice");
  const macReleasesBtn = $("macReleasesBtn") as HTMLButtonElement | null;
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
        void api.openExternal(
          `https://github.com/SirBepy/claude_usage_in_taskbar/releases/tag/v${updateState.version}`,
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
    updateBtn.onclick = () => { void api.installUpdate(); };
  } else if (updateState.state === "available") {
    updateStateLabel.innerText = `v${updateState.version} available`;
    updateStateLabel.style.color = "var(--text)";
    updateBtn.style.display = "block";
    updateBtn.disabled = false;
    updateBtn.innerText = `Download & Install v${updateState.version}`;
    updateBtn.onclick = () => {
      updateBtn.disabled = true;
      updateBtn.innerText = "Downloading...";
      void api.downloadAndInstall();
    };
  } else if (updateState.state === "downloading") {
    updateStateLabel.innerText = "Downloading...";
    updateStateLabel.style.color = "var(--text-dim)";
    updateBtn.style.display = "block";
    updateBtn.disabled = true;
    updateBtn.innerText = "Downloading...";
  } else if (updateState.state === "error") {
    updateStateLabel.innerText = "Error";
    updateStateLabel.style.color = "#ff4444";
    updateBtn.style.display = "block";
    updateBtn.disabled = false;
    updateBtn.innerText = "Retry";
    updateBtn.onclick = () => { void api.checkForUpdates(); };
  } else {
    updateStateLabel.innerText = "Up to date";
    updateStateLabel.style.color = "var(--text-dim)";
    updateBtn.style.display = "none";
  }
}

async function hydrateSettingsRoot(): Promise<void> {
  const s = getSettings();
  const launchAtLogin = $("launchAtLogin") as HTMLInputElement | null;
  const autoUpdate = $("autoUpdate") as HTMLSelectElement | null;
  const refreshUpdateBtn = $("refreshUpdateBtn") as HTMLButtonElement | null;
  const copyLogsBtn = $("copyLogsBtn") as HTMLButtonElement | null;
  const appVersionLabel = $("appVersionLabel");
  const autoUpdateRow = $("autoUpdateRow");
  if (!launchAtLogin || !autoUpdate || !refreshUpdateBtn || !copyLogsBtn) return;

  if (!_isMacResolved) {
    const platform = await api.getPlatform();
    isMac = platform === "darwin";
    _isMacResolved = true;
  }
  if (isMac && autoUpdateRow) autoUpdateRow.style.display = "none";

  launchAtLogin.checked = !!s.launchAtLogin;
  // Migrate legacy bool values silently: true → immediate, false → never.
  const raw = s.autoUpdate;
  const initialMode =
    raw === true ? "immediate" :
    raw === false ? "never" :
    (typeof raw === "string" && (raw === "never" || raw === "onStartup" || raw === "immediate"))
      ? raw
      : "immediate";
  autoUpdate.value = initialMode;
  launchAtLogin.addEventListener("change", saveSettings);
  autoUpdate.addEventListener("change", saveSettings);

  refreshUpdateBtn.addEventListener("click", () => {
    void api.checkForUpdates();
    const updateStateLabel = $("updateStateLabel");
    const updateBtn = $("updateBtn") as HTMLButtonElement | null;
    if (updateStateLabel) {
      updateStateLabel.innerText = "Checking...";
      updateStateLabel.style.color = "var(--text-dim)";
    }
    if (updateBtn) updateBtn.style.display = "none";
  });

  copyLogsBtn.addEventListener("click", () => {
    void api.copyLogs();
    const originalText = copyLogsBtn.textContent;
    copyLogsBtn.textContent = "Copied to Clipboard!";
    copyLogsBtn.classList.replace("btn-secondary", "btn-primary");
    setTimeout(() => {
      copyLogsBtn.textContent = originalText;
      copyLogsBtn.classList.replace("btn-primary", "btn-secondary");
    }, 2000);
  });

  const version = await api.getAppVersion();
  if (version && appVersionLabel) appVersionLabel.innerText = `Version: ${version}`;

  const initialState = await api.getUpdateState();
  if (initialState) renderUpdateState(initialState);
  api.onUpdateStateChange(renderUpdateState);
}

// Back-compat window bindings (legacy dashboard.js/stats.js/boot modals still reference these).
(window as unknown as { renderSettingsRoot?: () => Promise<void> }).renderSettingsRoot = hydrateSettingsRoot;
(window as unknown as { renderUpdateState?: (s: UpdateState) => void }).renderUpdateState = renderUpdateState;

interface ShortcutsUIState {
  capturingId: string | null;
  conflictMsg: string | null;
  captureListener: ((e: KeyboardEvent) => void) | null;
}

function renderShortcutsSection(container: HTMLElement): () => void {
  const s: ShortcutsUIState = { capturingId: null, conflictMsg: null, captureListener: null };

  const re = () => {
    const defs = shortcuts.getAll();
    const globalDefs = defs.filter(d => !d.context && !d.todo);
    const chatsDefs = defs.filter(d => d.context === "sessions" && !d.todo);
    const todoDefs = defs.filter(d => !!d.todo);

    function kbdHtml(id: string): string {
      const binding = shortcuts.getBinding(id);
      return binding.split("+").map(k =>
        `<kbd>${k.charAt(0).toUpperCase() + k.slice(1)}</kbd>`
      ).join("+");
    }

    function rowHtml(def: ShortcutDef): string {
      const isCapturing = s.capturingId === def.id;
      const hasOverride = shortcuts.hasOverride(def.id);
      const isTodo = !!def.todo;

      const bindingEl = isCapturing
        ? `<span class="shortcut-capture-input">Press a key combo...</span>`
        : `<span class="shortcut-kbd">${kbdHtml(def.id)}</span>`;

      const conflictEl = (isCapturing && s.conflictMsg)
        ? `<div class="shortcut-conflict-msg">${s.conflictMsg}</div>`
        : "";

      const controls = isTodo
        ? `<span class="shortcut-row-todo-tag">coming soon</span>`
        : `<div class="shortcut-row-controls">
            <div>
              ${bindingEl}
              ${conflictEl}
            </div>
            <button class="shortcut-rebind-btn" data-rebind="${def.id}">${isCapturing ? "Cancel" : "Rebind"}</button>
            ${hasOverride ? `<button class="shortcut-reset-btn" data-reset="${def.id}" title="Reset to default"><i class="ph ph-arrow-counter-clockwise"></i></button>` : ""}
          </div>`;

      return `<div class="shortcut-row${isTodo ? " is-todo" : ""}" data-id="${def.id}">
        <div class="shortcut-row-info">
          <span class="shortcut-row-label">${def.label}</span>
          <span class="shortcut-row-desc">${def.description}</span>
        </div>
        ${controls}
      </div>`;
    }

    container.innerHTML = `
      <div class="shortcut-group-header">Global</div>
      ${globalDefs.map(rowHtml).join("")}
      <div class="shortcut-group-header">Chats</div>
      ${chatsDefs.map(rowHtml).join("")}
      <div class="shortcut-group-header">Coming Soon</div>
      ${todoDefs.map(rowHtml).join("")}
    `;

    container.querySelectorAll<HTMLButtonElement>("[data-rebind]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.rebind!;
        if (s.capturingId === id) {
          stopCapture();
        } else {
          startCapture(id);
        }
      });
    });

    container.querySelectorAll<HTMLButtonElement>("[data-reset]").forEach(btn => {
      btn.addEventListener("click", () => {
        shortcuts.resetBinding(btn.dataset.reset!);
        stopCapture();
      });
    });
  };

  function startCapture(id: string): void {
    stopCapture();
    s.capturingId = id;
    s.conflictMsg = null;

    const listener = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") { stopCapture(); return; }

      const combo = normalizeEvent(e);
      if (!combo) return;

      const conflict = shortcuts.findConflict(combo, id);
      if (conflict) {
        s.conflictMsg = `Already used by: ${conflict.label}`;
        re();
        return;
      }

      shortcuts.setBinding(id, combo);
      stopCapture();
    };

    s.captureListener = listener;
    document.addEventListener("keydown", listener, true);
    re();
  }

  function stopCapture(): void {
    if (s.captureListener) {
      document.removeEventListener("keydown", s.captureListener, true);
      s.captureListener = null;
    }
    s.capturingId = null;
    s.conflictMsg = null;
    re();
  }

  re();
  return () => stopCapture();
}

export async function renderSettingsView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  const burger = root.querySelector<HTMLButtonElement>("#burgerBtn-settings");
  if (burger) burger.onclick = () => openSidemenu();

  const navVisuals = root.querySelector<HTMLElement>("#nav-visuals");
  const navThemes = root.querySelector<HTMLElement>("#nav-themes");
  const navNotifs = root.querySelector<HTMLElement>("#nav-notifications");
  const navPresets = root.querySelector<HTMLElement>("#nav-presets");
  if (navVisuals) navVisuals.onclick = () => g().navigateTo("settings-visuals");
  if (navThemes) navThemes.onclick = () => g().navigateTo("settings-themes");
  if (navNotifs) navNotifs.onclick = () => g().navigateTo("settings-notifications");
  if (navPresets) navPresets.onclick = () => g().navigateTo("settings-presets");

  const logoutBtn = root.querySelector<HTMLButtonElement>("#logoutBtn");
  if (logoutBtn) logoutBtn.onclick = () => { void api.logout(); };

  const shortcutsContainer = root.querySelector<HTMLElement>("#shortcuts-section-container");
  const cleanupShortcuts = shortcutsContainer ? renderShortcutsSection(shortcutsContainer) : null;

  try { await hydrateSettingsRoot(); }
  catch (e) { console.error("[settings root] render failed", e); }

  return () => { cleanupShortcuts?.(); };
}

function template() {
  return html`
    <div class="view view-settings">
      <div class="view-header">
        <button class="icon-btn burger" id="burgerBtn-settings" title="Menu" data-burger="true">
          <i class="ph ph-list"></i>
        </button>
        <h2>Settings</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">

        <div class="section">
          <div class="section-title">Appearance</div>
          <div class="nav-row" id="nav-visuals">
            <span class="nav-row-label">Visuals</span>
            <span class="nav-row-arrow">›</span>
          </div>
          <div class="nav-row" id="nav-themes">
            <span class="nav-row-label">Themes</span>
            <span class="nav-row-arrow">›</span>
          </div>
        </div>

        <div class="section">
          <div class="section-title">Agent</div>
          <div class="nav-row" id="nav-presets">
            <span class="nav-row-label">Session presets</span>
            <span class="nav-row-arrow">›</span>
          </div>
        </div>

        <div class="section">
          <div class="section-title">System</div>
          <div class="nav-row" id="nav-notifications">
            <span class="nav-row-label">Notifications</span>
            <span class="nav-row-arrow">›</span>
          </div>
          <div class="option">
            <span class="option-label">Launch at Login</span>
            <label class="switch">
              <input type="checkbox" id="launchAtLogin">
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <div class="section">
          <div class="section-title">Version</div>
          <div class="option" id="autoUpdateRow">
            <span class="option-label">Auto-Update</span>
            <select id="autoUpdate">
              <option value="never">Never</option>
              <option value="onStartup">On startup only</option>
              <option value="immediate">Immediate (auto-install)</option>
            </select>
          </div>
          <div class="option" id="updateStatusOption">
            <span class="option-label" id="appVersionLabel">Version: ...</span>
            <div style="display: flex; align-items: center; gap: 8px;">
              <button class="btn-secondary" id="refreshUpdateBtn" style="padding: 3px 7px; font-size: 0.7rem;">↻</button>
              <span id="updateStateLabel" style="font-size: 0.78rem; color: var(--text-dim);"></span>
              <button class="btn-primary" id="updateBtn" style="display: none; padding: 3px 8px; font-size: 0.75rem;">Update</button>
            </div>
          </div>
          <div id="macUpdateNotice" style="display: none; padding: 6px 10px; margin-top: 4px; font-size: 0.72rem; color: var(--text-dim); line-height: 1.45; border-radius: 6px; background: rgba(255,255,255,0.03);">
            Auto-update isn't available on macOS because Apple requires a $99/year Developer Program membership to sign apps. Maybe one day!
            <br>
            <button class="btn-primary" id="macReleasesBtn" style="margin-top: 6px; padding: 4px 10px; font-size: 0.72rem;">Download from GitHub</button>
          </div>
          <div style="margin-top: 12px;">
            <button class="btn-secondary" id="copyLogsBtn" style="width: 100%; font-size: 0.8rem;" title="Copy app logs for debugging">Copy Debug Logs</button>
          </div>
        </div>

        <div class="section">
          <div class="section-title">Shortcuts</div>
          <div id="shortcuts-section-container"></div>
        </div>

        <div class="section" style="border-color: rgba(224,82,82,0.3);">
          <div class="section-title" style="color: var(--danger);">Account</div>
          <button class="btn-danger" id="logoutBtn">Log Out</button>
        </div>

      </div>
    </div>
  `;
}
