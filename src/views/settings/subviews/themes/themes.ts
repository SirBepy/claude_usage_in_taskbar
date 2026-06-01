import { html, render } from "lit-html";
import { saveSettings } from "../../../../shared/settings-save";
import { getSettings, setSettings } from "../../../../shared/state";
import "./themes.css";

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
  renderThemesSettings?(): void;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

interface ThemeDef {
  id: string;
  label: string;
  darkColors: string[];
  lightColors: string[];
}

const THEMES: ThemeDef[] = [
  { id: "void",    label: "Void",    darkColors: ["#16151f", "#1e1d2b", "#9d7dfc", "#6e8fff", "#e2e0f0"], lightColors: ["#f0eff5", "#ffffff", "#7c5cdb", "#4a6bdf", "#1e1d2b"] },
  { id: "nebula",  label: "Nebula",  darkColors: ["#0f1629", "#172040", "#c084fc", "#a78bfa", "#e2dff0"], lightColors: ["#f2f0fa", "#ffffff", "#9333ea", "#7c3aed", "#1a1040"] },
  { id: "glacier", label: "Glacier", darkColors: ["#0c1a24", "#112430", "#38bdf8", "#22d3ee", "#e0f0f8"], lightColors: ["#eef6fa", "#ffffff", "#0284c7", "#0891b2", "#0c2430"] },
  { id: "cosmo",   label: "Cosmo",   darkColors: ["#1a0a1e", "#241430", "#f472b6", "#fb923c", "#f0e4f5"], lightColors: ["#faf0f4", "#ffffff", "#db2777", "#ea580c", "#2a1030"] },
];

function resolveThemeId(baseId: string, isLight: boolean): string {
  return isLight ? baseId + "-light" : baseId;
}

function parseThemeId(fullId: string): { baseId: string; isLight: boolean } {
  const isLight = fullId.endsWith("-light");
  return { baseId: isLight ? fullId.replace("-light", "") : fullId, isLight };
}

/**
 * Applies a flat theme id ("void" | "void-light") as the styleguide 2D pair:
 * data-theme="<palette>" + data-mode="light|dark". Storage stays the flat id.
 */
function applyThemeAttrs(fullId: string): void {
  const { baseId, isLight } = parseThemeId(fullId);
  const el = document.documentElement;
  el.dataset.theme = baseId;
  el.dataset.mode = isLight ? "light" : "dark";
}

function renderThemeCards(activeTheme: string): void {
  const themeGrid = $("themeGrid");
  const modeLabelDark = $("modeLabelDark");
  const modeLabelLight = $("modeLabelLight");
  if (!themeGrid) return;
  const { baseId: activeBase, isLight } = parseThemeId(activeTheme);
  const colorKey: "darkColors" | "lightColors" = isLight ? "lightColors" : "darkColors";
  themeGrid.innerHTML = "";
  for (const t of THEMES) {
    const card = document.createElement("div");
    card.className = "theme-card" + (t.id === activeBase ? " active" : "");
    card.dataset.themeId = t.id;
    card.innerHTML = `
      <div class="theme-swatch">${t[colorKey].map((c) => `<span style="background:${c}"></span>`).join("")}</div>
      <span class="theme-card-label">${t.label}</span>
    `;
    card.onclick = () => applyTheme(t.id);
    themeGrid.appendChild(card);
  }

  if (modeLabelDark) modeLabelDark.style.color = isLight ? "var(--text-dim)" : "var(--primary)";
  if (modeLabelLight) modeLabelLight.style.color = isLight ? "var(--primary)" : "var(--text-dim)";
}

function applyTheme(baseId: string): void {
  const themeModToggle = $("themeModToggle") as HTMLInputElement | null;
  const isLight = themeModToggle ? themeModToggle.checked : false;
  const fullId = resolveThemeId(baseId, isLight);
  applyThemeAttrs(fullId);
  const s = getSettings();
  s.theme = fullId;
  setSettings(s);
  saveSettings();

  const themeGrid = $("themeGrid");
  if (themeGrid) {
    for (const card of themeGrid.querySelectorAll<HTMLElement>(".theme-card")) {
      card.classList.toggle("active", card.dataset.themeId === baseId);
    }
  }
  const modeLabelDark = $("modeLabelDark");
  const modeLabelLight = $("modeLabelLight");
  if (modeLabelDark) modeLabelDark.style.color = isLight ? "var(--text-dim)" : "var(--primary)";
  if (modeLabelLight) modeLabelLight.style.color = isLight ? "var(--primary)" : "var(--text-dim)";
}

function hydrateThemes(): void {
  const themeModToggle = $("themeModToggle") as HTMLInputElement | null;
  if (!themeModToggle) return;
  const s = getSettings();
  const savedTheme = (s.theme as string) || document.documentElement.dataset.theme || "void";
  themeModToggle.checked = savedTheme.endsWith("-light");
  renderThemeCards(savedTheme);

  themeModToggle.onchange = () => {
    const cur = getSettings();
    const { baseId } = parseThemeId((cur.theme as string) || "void");
    const isLight = themeModToggle.checked;
    const fullId = resolveThemeId(baseId, isLight);
    applyThemeAttrs(fullId);
    cur.theme = fullId;
    setSettings(cur);
    saveSettings();
    renderThemeCards(fullId);
  };
}

// Back-compat window binding.
(window as unknown as { renderThemesSettings?: () => void }).renderThemesSettings = hydrateThemes;

export async function renderThemesView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  const backBtn = root.querySelector<HTMLButtonElement>(".back-to-settings");
  if (backBtn) backBtn.onclick = () => g().navigateTo("settings");

  try { hydrateThemes(); }
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
