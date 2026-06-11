import { html, render } from "lit-html";
import { saveSettings } from "../../../../shared/settings-save";
import { getSettings } from "../../../../shared/state";
import { api } from "../../../../shared/api";
import { populateAudioDevicePicker } from "../../../../../vendor/tauri_kit/frontend/audio/device-picker";

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

async function populateDevicePicker(): Promise<void> {
  const sel = $("audioOutputDevice") as HTMLSelectElement | null;
  if (!sel) return;
  const current = (getSettings().audioOutputDevice as string | null) || "";
  const devices = await api.listAudioOutputDevices();
  populateAudioDevicePicker(sel, devices, current);
  sel.removeEventListener("change", saveSettings);
  sel.addEventListener("change", saveSettings);
}

async function hydrateSound(): Promise<void> {
  const s = getSettings();
  await populateDevicePicker();

  const pauseInMeetingSwitch = $("pauseInMeetingSwitch") as HTMLInputElement | null;
  if (pauseInMeetingSwitch) {
    // Default on when the key is absent.
    pauseInMeetingSwitch.checked = s.pauseInMeeting !== false;
    pauseInMeetingSwitch.addEventListener("change", saveSettings);
  }
}

export async function renderSoundView(root: HTMLElement): Promise<() => void> {
  render(template(), root);

  const backBtn = root.querySelector<HTMLButtonElement>(".back-to-settings");
  if (backBtn) backBtn.onclick = () => g().navigateTo("settings");

  try { await hydrateSound(); }
  catch (e) { console.error("[sound] render failed", e); }

  return () => { /* no teardown */ };
}

function template() {
  return html`
    <div class="view view-settings-sound">
      <div class="view-header">
        <button class="icon-btn back-to-settings" title="Back">←</button>
        <h2>Sound</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">
        <div class="kit-section">
          <div class="kit-section-title">Audio output</div>
          <div class="kit-row">
            <span class="kit-row-label">Output device</span>
            <select id="audioOutputDevice">
              <option value="">System default</option>
            </select>
          </div>
          <div style="font-size:0.72rem;color:var(--text-dim);padding:2px 0 4px">"System default" follows your computer's default output - if you switch the default device, sounds follow automatically.</div>
        </div>
        <div class="kit-section" id="meetingSection">
          <div class="kit-section-title">Meetings</div>
          <div class="kit-row">
            <span class="kit-row-label">Pause sounds during meetings</span>
            <label class="kit-toggle">
              <input type="checkbox" id="pauseInMeetingSwitch">
              <span class="kit-toggle-track"></span>
            </label>
          </div>
          <div style="font-size:0.72rem;color:var(--text-dim);padding:2px 0 4px">Silences sounds and voice while your camera or mic is in use, or a meeting app (Teams, Zoom, Discord...) is in a call. Windows only.</div>
        </div>
      </div>
    </div>
  `;
}
