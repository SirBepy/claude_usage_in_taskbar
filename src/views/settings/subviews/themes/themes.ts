import { html, render } from "lit-html";
import "./themes.css";

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
  renderThemesSettings?(): void;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

export async function renderThemesView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  const backBtn = root.querySelector<HTMLButtonElement>(".back-to-settings");
  if (backBtn) backBtn.onclick = () => g().navigateTo("settings");

  try { g().renderThemesSettings?.(); }
  catch (e) { console.error("[themes] render failed", e); }

  return () => { /* no teardown */ };
}

function template() {
  return html`
    <div class="view view-settings-themes">
      <div class="view-header">
        <button class="icon-btn back-to-settings" title="Back">←</button>
        <h2>Themes</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">
        <div class="section">
          <div class="option" style="justify-content: space-between;">
            <div class="option-label-row">
              <i class="ph ph-moon"></i>
              <span>Dark Mode</span>
            </div>
            <div class="mode-toggle-row">
              <span class="mode-toggle-label" id="modeLabelDark">Dark</span>
              <label class="switch">
                <input type="checkbox" id="themeModToggle">
                <span class="slider"></span>
              </label>
              <span class="mode-toggle-label" id="modeLabelLight">Light</span>
            </div>
          </div>
        </div>
        <div class="section">
          <div class="theme-grid" id="themeGrid"></div>
        </div>
      </div>
    </div>
  `;
}
