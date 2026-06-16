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

  // Per-slot character-sound toggles. Each defaults ON when its key is absent.
  const slots = (s.characterSoundSlots as Record<string, boolean | undefined>) || {};
  for (const [id, key] of CHARACTER_SLOT_SWITCHES) {
    const el = $(id) as HTMLInputElement | null;
    if (!el) continue;
    el.checked = slots[key] !== false;
    el.addEventListener("change", saveSettings);
  }
  const selectOnClick = $("selectOnSessionClickSwitch") as HTMLInputElement | null;
  if (selectOnClick) {
    // Default off.
    selectOnClick.checked = s.selectOnSessionClick === true;
    selectOnClick.addEventListener("change", saveSettings);
  }
}

// [checkbox id, settings key] for the six character-sound slot toggles.
const CHARACTER_SLOT_SWITCHES: Array<[string, string]> = [
  ["soundSlotWorkFinished", "workFinished"],
  ["soundSlotQuestionAsked", "questionAsked"],
  ["soundSlotReady", "ready"],
  ["soundSlotSelect", "select"],
  ["soundSlotDeath", "death"],
  ["soundSlotAnnoyed", "annoyed"],
];

export async function renderSoundView(root: HTMLElement): Promise<() => void> {
  render(template(), root);

  const backBtn = root.querySelector<HTMLButtonElement>(".back-to-settings");
  if (backBtn) backBtn.onclick = () => g().navigateTo("settings");

  try { await hydrateSound(); }
  catch (e) { console.error("[sound] render failed", e); }

  return () => { /* no teardown */ };
}

function characterSlotRow(id: string, label: string) {
  return html`
    <div class="kit-row">
      <span class="kit-row-label">${label}</span>
      <label class="kit-toggle">
        <input type="checkbox" id=${id}>
        <span class="kit-toggle-track"></span>
      </label>
    </div>
  `;
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
        <div class="kit-section" id="characterSoundsSection">
          <div class="kit-section-title">Character sounds</div>
          ${characterSlotRow("soundSlotWorkFinished", "Work finished")}
          ${characterSlotRow("soundSlotQuestionAsked", "Question asked")}
          ${characterSlotRow("soundSlotReady", "Ready (new chat)")}
          ${characterSlotRow("soundSlotSelect", "Select (new chat / change)")}
          ${characterSlotRow("soundSlotDeath", "Death (chat closed)")}
          ${characterSlotRow("soundSlotAnnoyed", "Annoyed")}
          <div style="font-size:0.72rem;color:var(--text-dim);padding:2px 0 4px">Mute individual character voice-line slots. Off here silences that slot everywhere. The tray "Mute Notifications" overrides all of these.</div>
          <div class="kit-row">
            <span class="kit-row-label">Play "select" when clicking a session</span>
            <label class="kit-toggle">
              <input type="checkbox" id="selectOnSessionClickSwitch">
              <span class="kit-toggle-track"></span>
            </label>
          </div>
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
