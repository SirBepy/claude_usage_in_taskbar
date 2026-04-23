import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import "./settings.css";

interface LegacyGlobals {
  electronAPI?: { logout(): Promise<unknown> };
  navigateTo(name: string): Promise<void>;
  renderSettingsRoot?(): Promise<void> | void;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
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
  if (navVisuals) navVisuals.onclick = () => g().navigateTo("settings-visuals");
  if (navThemes) navThemes.onclick = () => g().navigateTo("settings-themes");
  if (navNotifs) navNotifs.onclick = () => g().navigateTo("settings-notifications");

  const logoutBtn = root.querySelector<HTMLButtonElement>("#logoutBtn");
  if (logoutBtn) logoutBtn.onclick = () => { void g().electronAPI?.logout(); };

  try { await g().renderSettingsRoot?.(); }
  catch (e) { console.error("[settings root] render failed", e); }

  return () => { /* no teardown */ };
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
            <label class="switch">
              <input type="checkbox" id="autoUpdate">
              <span class="slider"></span>
            </label>
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

        <div class="section" style="border-color: rgba(224,82,82,0.3);">
          <div class="section-title" style="color: var(--danger);">Account</div>
          <button class="btn-danger" id="logoutBtn">Log Out</button>
        </div>

      </div>
    </div>
  `;
}
