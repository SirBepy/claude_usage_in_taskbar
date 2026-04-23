import { html, render } from "lit-html";
import "./visuals.css";

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
  renderVisualsSettings?(): void;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

export async function renderVisualsView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  const backBtn = root.querySelector<HTMLButtonElement>(".back-to-settings");
  if (backBtn) backBtn.onclick = () => g().navigateTo("settings");

  try { g().renderVisualsSettings?.(); }
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
            </select>
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
              <option value="threshold">Threshold</option>
              <option value="pace">Safe Pace</option>
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
