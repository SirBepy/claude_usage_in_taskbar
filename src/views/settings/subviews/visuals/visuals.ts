import { html, render } from "lit-html";
import { saveSettings } from "../../../../shared/settings-save";
import { getSettings } from "../../../../shared/state";
import { LS_ANIM } from "../../../sessions/sidebar-anim";
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
  row.className = "kit-row color-row";
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

async function hydrateVisuals(): Promise<void> {
  const s = getSettings();
  const colorApplyDashboard = $("colorApplyDashboard") as HTMLInputElement | null;
  const colorApplyOverlay = $("colorApplyOverlay") as HTMLInputElement | null;
  const colorContainer = $("colorContainer");
  const colorMode = $("colorMode") as HTMLSelectElement | null;
  const paceBand = $("paceBand") as HTMLInputElement | null;
  const paceColorUnder = $("paceColorUnder") as HTMLInputElement | null;
  const paceColorNearSafe = $("paceColorNearSafe") as HTMLInputElement | null;
  const paceColorNearOver = $("paceColorNearOver") as HTMLInputElement | null;
  const paceColorOver = $("paceColorOver") as HTMLInputElement | null;
  const addColorBtn = $("addColorBtn") as HTMLButtonElement | null;
  if (!colorApplyDashboard || !colorApplyOverlay) return;
  if (!colorContainer || !colorMode || !paceBand || !addColorBtn) return;
  if (!paceColorUnder || !paceColorNearSafe || !paceColorNearOver || !paceColorOver) return;

  const cat = (s.colorApplyTo as Record<string, boolean | undefined>) || {};
  colorApplyDashboard.checked = cat.dashboard !== false;
  colorApplyOverlay.checked = cat.overlay !== false;
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

  for (const el of [colorApplyDashboard, colorApplyOverlay]) {
    el.addEventListener("change", saveSettings);
  }
  colorMode.addEventListener("change", () => { updateColorModeVisibility(); saveSettings(); });
  paceBand.addEventListener("change", saveSettings);
  paceColorUnder.addEventListener("change", saveSettings);
  paceColorNearSafe.addEventListener("change", saveSettings);
  paceColorNearOver.addEventListener("change", saveSettings);
  paceColorOver.addEventListener("change", saveSettings);
  addColorBtn.onclick = () => { colorContainer.appendChild(createColorRow(0, "#9d7dfc")); saveSettings(); };

  wireInfoTooltips(document.getElementById("app") || document);

  const sessionStateStyle = $("sessionStateStyle") as HTMLSelectElement | null;
  if (sessionStateStyle) {
    try {
      sessionStateStyle.value = localStorage.getItem("cc_session_state_style") || "icons";
    } catch { /* ignore */ }
    sessionStateStyle.addEventListener("change", () => {
      try { localStorage.setItem("cc_session_state_style", sessionStateStyle.value); }
      catch { /* ignore */ }
    });
  }

  const sidebarAnimations = $("sidebarAnimations") as HTMLInputElement | null;
  if (sidebarAnimations) {
    try { sidebarAnimations.checked = localStorage.getItem(LS_ANIM) !== "off"; }
    catch { sidebarAnimations.checked = true; }
    sidebarAnimations.addEventListener("change", () => {
      try { localStorage.setItem(LS_ANIM, sidebarAnimations.checked ? "on" : "off"); }
      catch { /* ignore */ }
    });
  }

  const hideInMeetingSwitch = $("hideInMeetingSwitch") as HTMLInputElement | null;
  if (hideInMeetingSwitch) {
    hideInMeetingSwitch.checked = !!s.hideInMeeting;
    hideInMeetingSwitch.addEventListener("change", saveSettings);
  }

  const overlayOpacity = $("overlayOpacity") as HTMLInputElement | null;
  const overlayOpacityValue = $("overlayOpacityValue");
  if (overlayOpacity) {
    const pct = Math.round(Math.max(0, Math.min(1, (s.overlayOpacity as number) ?? 0.72)) * 100);
    overlayOpacity.value = String(pct);
    if (overlayOpacityValue) overlayOpacityValue.textContent = `${pct}%`;
    overlayOpacity.addEventListener("input", () => {
      if (overlayOpacityValue) overlayOpacityValue.textContent = `${overlayOpacity.value}%`;
    });
    overlayOpacity.addEventListener("change", saveSettings);
  }
}

// Back-compat window binding (legacy boot code calls this by name).
(window as unknown as { renderVisualsSettings?: () => void }).renderVisualsSettings = hydrateVisuals;

export async function renderVisualsView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  const backBtn = root.querySelector<HTMLButtonElement>(".back-to-settings");
  if (backBtn) backBtn.onclick = () => g().navigateTo("settings");

  try { await hydrateVisuals(); }
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

        <div class="kit-section">
          <div class="kit-section-title">OVERLAY</div>
          <div class="kit-row">
            <span class="kit-row-label"><span class="info-wrap">Overlay Opacity<span class="info-icon">?</span><span class="info-tooltip">How see-through the floating multi-account overlay is when idle - each card's background fades in on hover, and the whole window snaps fully opaque the moment your cursor enters it</span></span></span>
            <div style="display:flex;align-items:center;gap:8px;flex:1;max-width:220px">
              <input type="range" id="overlayOpacity" min="0" max="100" step="5" style="flex:1">
              <span id="overlayOpacityValue" style="font-size:0.78rem;color:var(--text-dim);width:36px;text-align:right">72%</span>
            </div>
          </div>
        </div>

        <div class="kit-section">
          <div class="kit-section-title">COLORS</div>
          <div class="kit-row">
            <span class="kit-row-label"><span class="info-wrap">Dashboard<span class="info-icon">?</span><span class="info-tooltip">Colors the percentage numbers shown in the dashboard</span></span></span>
            <label class="kit-toggle">
              <input type="checkbox" id="colorApplyDashboard" checked>
              <span class="kit-toggle-track"></span>
            </label>
          </div>
          <div class="kit-row">
            <span class="kit-row-label"><span class="info-wrap">Overlay<span class="info-icon">?</span><span class="info-tooltip">Colors the usage numbers shown in the floating multi-account overlay window</span></span></span>
            <label class="kit-toggle">
              <input type="checkbox" id="colorApplyOverlay" checked>
              <span class="kit-toggle-track"></span>
            </label>
          </div>
          <div class="kit-row">
            <span class="kit-row-label"><span class="info-wrap">Color Mode<span class="info-icon">?</span><span class="info-tooltip">Threshold: colors change at fixed percentages you define. Safe Pace: colors based on whether you're ahead or behind a steady usage rate</span></span></span>
            <select id="colorMode">
              <option value="pace">Safe Pace</option>
              <option value="threshold">Threshold</option>
            </select>
          </div>
        </div>
        <div class="kit-section">
          <div class="kit-section-title">COLOR MODE CONFIG</div>
          <div id="thresholdSection">
            <div id="colorContainer"></div>
            <button class="btn-secondary" id="addColorBtn" style="margin-top: 10px; width: 100%; font-size: 0.8rem;">+ Add Color Threshold</button>
          </div>
          <div id="paceSection" style="display:none">
            <div class="kit-row">
              <span class="kit-row-label"><span class="info-wrap">Band %<span class="info-icon">?</span><span class="info-tooltip">How close to the safe pace line before the color changes (e.g. 10% means within 10 points)</span></span></span>
              <input type="number" id="paceBand" value="10" min="0" max="50" style="width:60px">
            </div>
            <div class="kit-section-title" style="margin-top:10px">Colors</div>
            <div class="kit-row">
              <span class="kit-row-label">Under</span>
              <input type="color" id="paceColorUnder" value="#27ae60">
            </div>
            <div class="kit-row">
              <span class="kit-row-label">Near (safe side)</span>
              <input type="color" id="paceColorNearSafe" value="#f1c40f">
            </div>
            <div class="kit-row">
              <span class="kit-row-label">Near (over side)</span>
              <input type="color" id="paceColorNearOver" value="#e67e22">
            </div>
            <div class="kit-row">
              <span class="kit-row-label">Over</span>
              <input type="color" id="paceColorOver" value="#e74c3c">
            </div>
          </div>
        </div>

        <div class="kit-section">
          <div class="kit-section-title">SESSIONS</div>
          <div class="kit-row">
            <span class="kit-row-label">Session state style</span>
            <select id="sessionStateStyle">
              <option value="icons">Icons</option>
              <option value="dots">Dots</option>
            </select>
          </div>
          <div class="kit-row">
            <span class="kit-row-label">Sidebar animations</span>
            <label class="kit-toggle">
              <input type="checkbox" id="sidebarAnimations">
              <span class="kit-toggle-track"></span>
            </label>
          </div>
        </div>

        <div class="kit-section">
          <div class="kit-section-title">MEETINGS</div>
          <div class="kit-row">
            <span class="kit-row-label">Hide from screen capture</span>
            <label class="kit-toggle">
              <input type="checkbox" id="hideInMeetingSwitch">
              <span class="kit-toggle-track"></span>
            </label>
          </div>
          <div style="font-size:0.72rem;color:var(--text-dim);padding:2px 0 4px">Hides app windows from screen shares and recordings during meetings. Windows only.</div>
        </div>

      </div>
    </div>
  `;
}
