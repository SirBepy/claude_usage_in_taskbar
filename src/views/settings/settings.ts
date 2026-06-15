import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { saveSettings } from "../../shared/settings-save";
import { getSettings } from "../../shared/state";
import { api } from "../../shared/api";
import "./settings.css";

export { saveSettings };

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
  renderSettingsRoot?: () => Promise<void> | void;
  saveSettings?: () => void;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

async function hydrateSettingsRoot(): Promise<void> {
  const s = getSettings();
  const launchAtLogin = $("launchAtLogin") as HTMLInputElement | null;
  if (!launchAtLogin) return;

  launchAtLogin.checked = !!s.launchAtLogin;
  launchAtLogin.addEventListener("change", saveSettings);
}

// Back-compat window binding.
(window as unknown as { renderSettingsRoot?: () => Promise<void> }).renderSettingsRoot = hydrateSettingsRoot;

export async function renderSettingsView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  const burger = root.querySelector<HTMLButtonElement>("#burgerBtn-settings");
  if (burger) burger.onclick = () => openSidemenu();

  const navVisuals = root.querySelector<HTMLElement>("#nav-visuals");
  const navThemes = root.querySelector<HTMLElement>("#nav-themes");
  const navSound = root.querySelector<HTMLElement>("#nav-sound");
  const navNotifs = root.querySelector<HTMLElement>("#nav-notifications");
  const navPresets = root.querySelector<HTMLElement>("#nav-presets");
  const navPermissions = root.querySelector<HTMLElement>("#nav-permissions");
  const navCharacters = root.querySelector<HTMLElement>("#nav-characters");
  const navShortcuts = root.querySelector<HTMLElement>("#nav-shortcuts");
  const navStatusline = root.querySelector<HTMLElement>("#nav-statusline");
  const navAbout = root.querySelector<HTMLElement>("#nav-about");
  if (navVisuals) navVisuals.onclick = () => g().navigateTo("settings-visuals");
  if (navThemes) navThemes.onclick = () => g().navigateTo("settings-themes");
  if (navSound) navSound.onclick = () => g().navigateTo("settings-sound");
  if (navNotifs) navNotifs.onclick = () => g().navigateTo("settings-notifications");
  if (navPresets) navPresets.onclick = () => g().navigateTo("settings-presets");
  if (navPermissions) navPermissions.onclick = () => g().navigateTo("settings-permissions");
  if (navCharacters) navCharacters.onclick = () => g().navigateTo("settings-characters");
  if (navShortcuts) navShortcuts.onclick = () => g().navigateTo("settings-shortcuts");
  if (navStatusline) navStatusline.onclick = () => g().navigateTo("settings-statusline");
  if (navAbout) navAbout.onclick = () => g().navigateTo("settings-about");

  const logoutBtn = root.querySelector<HTMLButtonElement>("#logoutBtn");
  if (logoutBtn) logoutBtn.onclick = () => { void api.logout(); };

  try { await hydrateSettingsRoot(); }
  catch (e) { console.error("[settings root] render failed", e); }

  return () => {};
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

        <div class="kit-section">
          <div class="kit-section-title">Appearance</div>
          <div class="kit-row kit-nav-row" id="nav-visuals">
            <span class="kit-row-label">Visuals</span>
            <span class="kit-nav-arrow">›</span>
          </div>
          <div class="kit-row kit-nav-row" id="nav-themes">
            <span class="kit-row-label">Themes</span>
            <span class="kit-nav-arrow">›</span>
          </div>
        </div>

        <div class="kit-section">
          <div class="kit-section-title">Agent</div>
          <div class="kit-row kit-nav-row" id="nav-presets">
            <span class="kit-row-label">Session presets</span>
            <span class="kit-nav-arrow">›</span>
          </div>
          <div class="kit-row kit-nav-row" id="nav-permissions">
            <span class="kit-row-label">Permissions</span>
            <span class="kit-nav-arrow">›</span>
          </div>
          <div class="kit-row kit-nav-row" id="nav-characters">
            <span class="kit-row-label">Characters</span>
            <span class="kit-nav-arrow">›</span>
          </div>
          <div class="kit-row kit-nav-row" id="nav-statusline">
            <span class="kit-row-label">Statusline</span>
            <span class="kit-nav-arrow">›</span>
          </div>
        </div>

        <div class="kit-section">
          <div class="kit-section-title">System</div>
          <div class="kit-row kit-nav-row" id="nav-sound">
            <span class="kit-row-label">Sound</span>
            <span class="kit-nav-arrow">›</span>
          </div>
          <div class="kit-row kit-nav-row" id="nav-notifications">
            <span class="kit-row-label">Notifications</span>
            <span class="kit-nav-arrow">›</span>
          </div>
          <div class="kit-row kit-nav-row" id="nav-shortcuts">
            <span class="kit-row-label">Shortcuts</span>
            <span class="kit-nav-arrow">›</span>
          </div>
          <div class="kit-row">
            <span class="kit-row-label">Launch at Login</span>
            <label class="kit-toggle">
              <input type="checkbox" id="launchAtLogin">
              <span class="kit-toggle-track"></span>
            </label>
          </div>
        </div>

        <div class="kit-section">
          <div class="kit-row kit-nav-row" id="nav-about">
            <span class="kit-row-label">About & Updates</span>
            <span class="kit-nav-arrow">›</span>
          </div>
        </div>

        <div class="kit-section" style="border-color: rgba(224,82,82,0.3);">
          <div class="kit-section-title" style="color: var(--danger);">Account</div>
          <button class="btn-danger" id="logoutBtn">Log Out</button>
        </div>

      </div>
    </div>
  `;
}
