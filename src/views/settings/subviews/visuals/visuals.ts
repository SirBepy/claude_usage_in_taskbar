import { html, render } from "lit-html";
import { saveSettings } from "../../../../shared/settings-save";
import { getSettings } from "../../../../shared/state";
import "./visuals.css";

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
  renderVisualsSettings?(): void;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function createColorRow(min = 0, color = "#ffffff"): HTMLElement {
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
  const removeBtn = row.querySelector<HTMLButtonElement>(".remove-color-btn");
  if (removeBtn) removeBtn.onclick = () => { row.remove(); saveSettings(); };
  row.querySelector(".color-min")?.addEventListener("change", saveSettings);
  row.querySelector(".color-val")?.addEventListener("change", saveSettings);
  return row;
}

function updateFourBarsColorsVisibility(): void {
  const iconStyleEl = $("iconStyle") as HTMLSelectElement | null;
  const section = $("fourBarsSafeColorsSection");
  if (section) section.style.display = iconStyleEl?.value === "fourbars" ? "block" : "none";
}

function updateColorModeVisibility(): void {
  const colorMode = $("colorMode") as HTMLSelectElement | null;
  const thresholdSection = $("thresholdSection");
  const paceSection = $("paceSection");
  if (!colorMode || !thresholdSection || !paceSection) return;
  const isPace = colorMode.value === "pace";
  thresholdSection.style.display = isPace ? "none" : "block";
  paceSection.style.display = isPace ? "block" : "none";
}

function wireInfoTooltips(root: HTMLElement | Document): void {
  for (const wrap of root.querySelectorAll<HTMLElement>(".info-wrap")) {
    const icon = wrap.querySelector<HTMLElement>(".info-icon");
    const tip = wrap.querySelector<HTMLElement>(".info-tooltip");
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

function hydrateVisuals(): void {
  const s = getSettings();
  const defaultDisplay = $("defaultDisplay") as HTMLSelectElement | null;
  const iconStyle = $("iconStyle") as HTMLSelectElement | null;
  const timeStyle = $("timeStyle") as HTMLSelectElement | null;
  const tooltipLayout = $("tooltipLayout") as HTMLSelectElement | null;
  const tooltipShowSafePace = $("tooltipShowSafePace") as HTMLInputElement | null;
  const colorApplyIcon = $("colorApplyIcon") as HTMLInputElement | null;
  const colorApplyNumber = $("colorApplyNumber") as HTMLInputElement | null;
  const colorApplyDashboard = $("colorApplyDashboard") as HTMLInputElement | null;
  const colorApplyTooltip = $("colorApplyTooltip") as HTMLInputElement | null;
  const colorContainer = $("colorContainer");
  const colorMode = $("colorMode") as HTMLSelectElement | null;
  const paceBand = $("paceBand") as HTMLInputElement | null;
  const paceColorUnder = $("paceColorUnder") as HTMLInputElement | null;
  const paceColorNearSafe = $("paceColorNearSafe") as HTMLInputElement | null;
  const paceColorNearOver = $("paceColorNearOver") as HTMLInputElement | null;
  const paceColorOver = $("paceColorOver") as HTMLInputElement | null;
  const addColorBtn = $("addColorBtn") as HTMLButtonElement | null;
  const iconStyleSection = $("iconStyleSection");
  if (!defaultDisplay || !iconStyle || !timeStyle || !tooltipLayout || !tooltipShowSafePace) return;
  if (!colorApplyIcon || !colorApplyNumber || !colorApplyDashboard || !colorApplyTooltip) return;
  if (!colorContainer || !colorMode || !paceBand || !addColorBtn) return;
  if (!paceColorUnder || !paceColorNearSafe || !paceColorNearOver || !paceColorOver) return;

  defaultDisplay.value = (s.defaultDisplay as string) || "icon";
  iconStyle.value = (s.iconStyle as string) || "rings";
  timeStyle.value = (s.timeStyle as string) || "absolute";
  tooltipLayout.value = (s.tooltipLayout as string) || "rows";
  tooltipShowSafePace.checked = s.tooltipShowSafePace !== false;
  const cat = (s.colorApplyTo as Record<string, boolean | undefined>) || {};
  colorApplyIcon.checked = cat.icon !== false;
  colorApplyNumber.checked = cat.number !== false;
  colorApplyDashboard.checked = cat.dashboard !== false;
  colorApplyTooltip.checked = cat.tooltip !== false;
  colorMode.value = (s.colorMode as string) || "pace";
  paceBand.value = String(s.paceBand ?? 10);
  const pc = (s.paceColors as Record<string, string | undefined>) || {};
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

  timeStyle.addEventListener("change", saveSettings);
  tooltipLayout.addEventListener("change", saveSettings);
  iconStyle.addEventListener("change", () => { updateFourBarsColorsVisibility(); saveSettings(); });
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

  // 4-bars safe-pace color pickers
  const wireSafePicker = (hiddenId: string, pickerId: string, autoBtnId: string, stored: string) => {
    const hidden = $(hiddenId) as HTMLInputElement | null;
    const picker = $(pickerId) as HTMLInputElement | null;
    const autoBtn = $(autoBtnId) as HTMLButtonElement | null;
    if (!hidden || !picker || !autoBtn) return;
    const isAuto = stored === "auto";
    hidden.value = stored;
    picker.value = isAuto || !stored ? "#6496dc" : stored;
    picker.disabled = isAuto;
    picker.style.opacity = isAuto ? "0.4" : "";
    autoBtn.textContent = isAuto ? "Auto (on)" : "Auto";
    picker.addEventListener("change", () => { hidden.value = picker.value; saveSettings(); });
    autoBtn.addEventListener("click", () => {
      const nowAuto = hidden.value !== "auto";
      hidden.value = nowAuto ? "auto" : picker.value;
      picker.disabled = nowAuto;
      picker.style.opacity = nowAuto ? "0.4" : "";
      autoBtn.textContent = nowAuto ? "Auto (on)" : "Auto";
      saveSettings();
    });
  };
  wireSafePicker("fourBarsSessionSafeColor", "fourBarsSessionSafeColorPicker",
                 "fourBarsSessionSafeAutoBtn", (s.fourBarsSessionSafeColor as string) || "");
  wireSafePicker("fourBarsWeeklySafeColor", "fourBarsWeeklySafeColorPicker",
                 "fourBarsWeeklySafeAutoBtn", (s.fourBarsWeeklySafeColor as string) || "");
  updateFourBarsColorsVisibility();

  wireInfoTooltips(document.getElementById("app") || document);
}

// Back-compat window binding (legacy boot code calls this by name).
(window as unknown as { renderVisualsSettings?: () => void }).renderVisualsSettings = hydrateVisuals;

export async function renderVisualsView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  const backBtn = root.querySelector<HTMLButtonElement>(".back-to-settings");
  if (backBtn) backBtn.onclick = () => g().navigateTo("settings");

  try { hydrateVisuals(); }
  catch (e) { console.error("[visuals] render failed", e); }

  return () => { /* no teardown */ };
}

function template() {
  return html`
    <div class="view view-settings-visuals">
      <div class="view-header">
        <button class="icon-btn back-to-settings" title="Back">←</button>
        <h2>Visuals</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">

        <div class="section">
          <div class="section-title">ICON</div>
          <div class="option">
            <span class="option-label">Default Display</span>
            <select id="defaultDisplay">
              <option value="icon">Icon</option>
              <option value="session">Session %</option>
              <option value="weekly">Weekly %</option>
            </select>
          </div>
          <div class="option" id="iconStyleSection">
            <span class="option-label">Icon Style</span>
            <select id="iconStyle">
              <option value="rings">Rings</option>
              <option value="bars">Bars</option>
              <option value="fourbars">4 Bars</option>
            </select>
          </div>
        </div>

        <div class="section" id="fourBarsSafeColorsSection" style="display:none">
          <div class="section-title">4 BARS - SAFE PACE COLORS</div>
          <div class="option">
            <span class="option-label">Session safe</span>
            <div style="display:flex;gap:6px;align-items:center">
              <input type="color" id="fourBarsSessionSafeColorPicker" value="#6496dc">
              <button id="fourBarsSessionSafeAutoBtn" class="btn-secondary">Auto</button>
            </div>
            <input type="hidden" id="fourBarsSessionSafeColor" value="">
          </div>
          <div class="option">
            <span class="option-label">Weekly safe</span>
            <div style="display:flex;gap:6px;align-items:center">
              <input type="color" id="fourBarsWeeklySafeColorPicker" value="#6496dc">
              <button id="fourBarsWeeklySafeAutoBtn" class="btn-secondary">Auto</button>
            </div>
            <input type="hidden" id="fourBarsWeeklySafeColor" value="">
          </div>
        </div>

        <div class="section">
          <div class="section-title">TOOLTIP</div>
          <div class="option">
            <span class="option-label"><span class="info-wrap">Time Display<span class="info-icon">?</span><span class="info-tooltip">Absolute shows clock time (e.g. 3:45 PM), Countdown shows time remaining (e.g. 2h 15m)</span></span></span>
            <select id="timeStyle">
              <option value="absolute">Absolute Time</option>
              <option value="countdown">Time Until</option>
            </select>
          </div>
          <div class="option">
            <span class="option-label">Layout</span>
            <select id="tooltipLayout">
              <option value="rows">Rows</option>
              <option value="columns">Columns</option>
            </select>
          </div>
          <div class="option">
            <span class="option-label"><span class="info-wrap">Show Safe Pace<span class="info-icon">?</span><span class="info-tooltip">Shows what percentage of usage you'd have if you used Claude at a steady rate across the full window</span></span></span>
            <label class="switch">
              <input type="checkbox" id="tooltipShowSafePace">
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <div class="section">
          <div class="section-title">COLORS</div>
          <div class="option">
            <span class="option-label"><span class="info-wrap">Toolbar Icon<span class="info-icon">?</span><span class="info-tooltip">Colors the icon (rings or bars) in the system tray</span></span></span>
            <label class="switch">
              <input type="checkbox" id="colorApplyIcon" checked>
              <span class="slider"></span>
            </label>
          </div>
          <div class="option">
            <span class="option-label"><span class="info-wrap">Toolbar Number<span class="info-icon">?</span><span class="info-tooltip">Colors the percentage number shown in the system tray when cycling away from the icon</span></span></span>
            <label class="switch">
              <input type="checkbox" id="colorApplyNumber" checked>
              <span class="slider"></span>
            </label>
          </div>
          <div class="option">
            <span class="option-label"><span class="info-wrap">Dashboard<span class="info-icon">?</span><span class="info-tooltip">Colors the percentage numbers shown in the dashboard</span></span></span>
            <label class="switch">
              <input type="checkbox" id="colorApplyDashboard" checked>
              <span class="slider"></span>
            </label>
          </div>
          <div class="option">
            <span class="option-label"><span class="info-wrap">Tooltip<span class="info-icon">?</span><span class="info-tooltip">Colors the icon shown in the system tray tooltip</span></span></span>
            <label class="switch">
              <input type="checkbox" id="colorApplyTooltip" checked>
              <span class="slider"></span>
            </label>
          </div>
          <div class="option">
            <span class="option-label"><span class="info-wrap">Color Mode<span class="info-icon">?</span><span class="info-tooltip">Threshold: colors change at fixed percentages you define. Safe Pace: colors based on whether you're ahead or behind a steady usage rate</span></span></span>
            <select id="colorMode">
              <option value="pace">Safe Pace</option>
              <option value="threshold">Threshold</option>
            </select>
          </div>
        </div>
        <div class="section">
          <div class="section-title">COLOR MODE CONFIG</div>
          <div id="thresholdSection">
            <div id="colorContainer"></div>
            <button class="btn-secondary" id="addColorBtn" style="margin-top: 10px; width: 100%; font-size: 0.8rem;">+ Add Color Threshold</button>
          </div>
          <div id="paceSection" style="display:none">
            <div class="option">
              <span class="option-label"><span class="info-wrap">Band %<span class="info-icon">?</span><span class="info-tooltip">How close to the safe pace line before the color changes (e.g. 10% means within 10 points)</span></span></span>
              <input type="number" id="paceBand" value="10" min="0" max="50" style="width:60px">
            </div>
            <div class="section-title" style="margin-top:10px">Colors</div>
            <div class="option">
              <span class="option-label">Under</span>
              <input type="color" id="paceColorUnder" value="#27ae60">
            </div>
            <div class="option">
              <span class="option-label">Near (safe side)</span>
              <input type="color" id="paceColorNearSafe" value="#f1c40f">
            </div>
            <div class="option">
              <span class="option-label">Near (over side)</span>
              <input type="color" id="paceColorNearOver" value="#e67e22">
            </div>
            <div class="option">
              <span class="option-label">Over</span>
              <input type="color" id="paceColorOver" value="#e74c3c">
            </div>
          </div>
        </div>

      </div>
    </div>
  `;
}
