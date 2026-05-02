import { html, render } from "lit-html";
import {
  saveSettings,
  notifCards,
  resetNotifCards,
  NOTIF_TYPES,
} from "../../../../shared/settings-save";
import type { NotifCardRef } from "../../../../shared/settings-save";
import { getSettings } from "../../../../shared/state";
import { api } from "../../../../shared/api";
import "./notifications.css";

const DEFAULT_SOUNDS: { id: string; label: string }[] = [
  { id: "sound1.mp3", label: "Sound 1" },
  { id: "sound2.mp3", label: "Sound 2" },
  { id: "sound3.mp3", label: "Sound 3" },
  { id: "sound4.mp3", label: "Sound 4" },
  { id: "sound5.mp3", label: "Sound 5" },
  { id: "sound6.mp3", label: "Sound 6" },
];

function populateDefaultSoundSelect(sel: HTMLSelectElement, currentSoundId: string | undefined): void {
  sel.innerHTML = DEFAULT_SOUNDS.map((s) => {
    const selected = s.id === currentSoundId ? " selected" : "";
    return `<option value="${s.id}"${selected}>${s.label}</option>`;
  }).join("");
}

interface PiperVoice { id: string; label: string; installed: boolean; [k: string]: unknown; }
interface PiperStatus { voices?: PiperVoice[]; [k: string]: unknown; }

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
  renderNotificationSettings?(): Promise<void> | void;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

let piperStatusCache: PiperStatus | null = null;

function getInstalledPiperVoices(): PiperVoice[] {
  return (piperStatusCache?.voices || []).filter((v) => v.installed);
}

function populateVoiceSelect(sel: HTMLSelectElement, selected: string | null): void {
  const webVoices = (window.speechSynthesis?.getVoices() || []).filter((v) => v.name && v.name !== "Matej");
  const piperVoices = getInstalledPiperVoices();
  const parts: string[] = [];
  if (piperVoices.length) {
    parts.push(`<optgroup label="High-quality (Piper)">${piperVoices.map((v) => `<option value="${v.id}"${v.id === selected ? " selected" : ""}>${v.label}</option>`).join("")}</optgroup>`);
  }
  if (webVoices.length) {
    parts.push(`<optgroup label="System voices">${webVoices.map((v) => `<option value="${v.name}"${v.name === selected ? " selected" : ""}>${v.name}</option>`).join("")}</optgroup>`);
  }
  if (!parts.length) parts.push(`<option value="">(loading voices...)</option>`);
  sel.innerHTML = parts.join("");
  if (selected) {
    const opt = Array.from(sel.options).find((o) => o.value === selected);
    if (opt) sel.value = selected;
  }
}

function refreshAllVoiceSelects(): void {
  for (const t of NOTIF_TYPES) {
    const c = notifCards[t.key];
    if (!c) continue;
    const desired = c.voiceSelect.dataset.desired || c.voiceSelect.value || null;
    populateVoiceSelect(c.voiceSelect, desired);
  }
}

interface FullNotifCardRef extends NotifCardRef {
  root: HTMLElement;
  body: HTMLElement;
  soundRow: HTMLElement;
  soundPreview: HTMLButtonElement;
  voiceRows: HTMLElement;
  voicePreview: HTMLButtonElement;
}

const fullCards: Record<string, FullNotifCardRef> = {};

function applyNotifCardVisibility(type: string): void {
  const c = fullCards[type];
  if (!c) return;
  const enabled = c.enabled.checked;
  const mode = Array.from(c.modes).find((r) => r.checked)?.value || "sound";
  c.body.style.display = enabled ? "flex" : "none";
  c.soundRow.style.display = (enabled && mode === "sound") ? "flex" : "none";
  c.voiceRows.style.display = (enabled && mode === "voice") ? "flex" : "none";
}

async function renderNotifCard(
  type: string,
  cfg: Record<string, unknown>,
): Promise<void> {
  const c = fullCards[type];
  if (!c) return;
  const def = NOTIF_TYPES.find((n) => n.key === type);
  if (!def) return;
  c.enabled.checked = cfg.enabled !== false;
  const mode = cfg.mode === "voice" ? "voice" : "sound";
  c.modes.forEach((r) => { r.checked = r.value === mode; });

  const currentSound = (cfg.soundFile as string) || def.defaultSound;
  populateDefaultSoundSelect(c.soundFile, currentSound);

  c.template.value = (cfg.template as string) || def.defaultTemplate;
  if (cfg.voiceName) c.voiceSelect.dataset.desired = cfg.voiceName as string;
  populateVoiceSelect(c.voiceSelect, (cfg.voiceName as string) || null);
  applyNotifCardVisibility(type);
}

function wireNotifCard(type: string): void {
  const c = fullCards[type];
  const def = NOTIF_TYPES.find((n) => n.key === type);
  if (!c || !def) return;
  const onToggle = () => { applyNotifCardVisibility(type); saveSettings(); };
  c.enabled.addEventListener("change", onToggle);
  c.modes.forEach((r) => r.addEventListener("change", onToggle));
  c.soundFile.addEventListener("change", saveSettings);
  c.template.addEventListener("input", saveSettings);
  c.voiceSelect.addEventListener("change", () => {
    c.voiceSelect.dataset.desired = c.voiceSelect.value || "";
    saveSettings();
  });
  c.soundPreview.onclick = () => {
    api.playSoundPreview(c.soundFile.value).catch((e) => {
      console.error("[sound preview] failed", e);
    });
  };
  c.voicePreview.onclick = () => {
    const voicePreviewProject = $("voicePreviewProject") as HTMLSelectElement | null;
    const cwd = voicePreviewProject?.value || "";
    const rawName = cwd ? (cwd.split(/[\\/]/).pop() || "Project") : "Project";
    const name = rawName.replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
    const text = (c.template.value || def.defaultTemplate)
      .replace(/\{name\}/g, name)
      .replace(/\{percent\}/g, "80%")
      .replace(/[_\-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return;
    void api.speakPreview({ text, voiceName: c.voiceSelect.value || null });
  };
}

function buildNotifCards(): void {
  const notifCardsRoot = $("notifCards");
  const notifCardTemplate = $("notifCardTemplate") as HTMLTemplateElement | null;
  if (!notifCardsRoot || !notifCardTemplate) {
    console.error("[notif] template or root missing");
    return;
  }
  resetNotifCards();
  for (const k of Object.keys(fullCards)) delete fullCards[k];
  notifCardsRoot.innerHTML = "";
  for (const t of NOTIF_TYPES) {
    const first = notifCardTemplate.content.firstElementChild;
    if (!first) continue;
    const node = first.cloneNode(true) as HTMLElement;
    const titleEl = node.querySelector<HTMLElement>(".notif-title");
    if (titleEl) titleEl.textContent = t.title;
    const hintEl = node.querySelector<HTMLElement>(".notif-template-hint");
    if (hintEl) hintEl.textContent = t.hint;
    node.querySelectorAll<HTMLInputElement>(".notif-mode").forEach((r) => { r.name = `notif-mode-${t.key}`; });
    notifCardsRoot.appendChild(node);
    const ref: FullNotifCardRef = {
      root: node,
      enabled: node.querySelector<HTMLInputElement>(".notif-enabled")!,
      body: node.querySelector<HTMLElement>(".notif-body")!,
      modes: node.querySelectorAll<HTMLInputElement>(".notif-mode"),
      soundRow: node.querySelector<HTMLElement>(".notif-sound-row")!,
      soundFile: node.querySelector<HTMLSelectElement>(".notif-sound-file")!,
      soundPreview: node.querySelector<HTMLButtonElement>(".notif-sound-preview")!,
      voiceRows: node.querySelector<HTMLElement>(".notif-voice-rows")!,
      voiceSelect: node.querySelector<HTMLSelectElement>(".notif-voice-select")!,
      template: node.querySelector<HTMLInputElement>(".notif-template")!,
      voicePreview: node.querySelector<HTMLButtonElement>(".notif-voice-preview")!,
    };
    fullCards[t.key] = ref;
    notifCards[t.key] = {
      enabled: ref.enabled,
      modes: ref.modes,
      soundFile: ref.soundFile,
      voiceSelect: ref.voiceSelect,
      template: ref.template,
    };
    wireNotifCard(t.key);
  }
}

async function loadPiperVoices(): Promise<void> {
  try {
    const status = await api.piperStatus();
    if (status) piperStatusCache = status;
    refreshAllVoiceSelects();
  } catch (e) {
    console.error("[piper] populate failed:", e);
  }
}

function primeWebVoices(): void {
  if (!window.speechSynthesis) return;
  let tries = 0;
  const tick = () => {
    const list = window.speechSynthesis.getVoices() || [];
    if (list.length > 0) { refreshAllVoiceSelects(); return; }
    if (tries++ < 30) setTimeout(tick, 100);
  };
  tick();
  window.speechSynthesis.addEventListener?.("voiceschanged", refreshAllVoiceSelects);
  window.speechSynthesis.onvoiceschanged = refreshAllVoiceSelects;
}

function applyMuteAllVisual(): void {
  const muteAllSwitch = $("muteAllSwitch") as HTMLInputElement | null;
  const muteSection = $("muteSection");
  if (!muteAllSwitch || !muteSection) return;
  muteSection.classList.toggle("mute-all-on", muteAllSwitch.checked);
}

async function populateVoicePreview(): Promise<void> {
  const voicePreviewProject = $("voicePreviewProject") as HTMLSelectElement | null;
  if (!voicePreviewProject) return;
  const history = (await api.getTokenHistory()) || [];
  const seen = new Set<string>();
  const projects: string[] = [];
  for (let i = history.length - 1; i >= 0 && projects.length < 5; i--) {
    const cwd = history[i]?.cwd;
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    projects.push(cwd);
  }
  voicePreviewProject.innerHTML = projects.length
    ? projects.map((p) => `<option value="${p}">${p.split(/[\\/]/).pop()}</option>`).join("")
    : `<option value="">No projects yet</option>`;
}

async function hydrateNotifications(): Promise<void> {
  const s = getSettings();
  const muteAllSwitch = $("muteAllSwitch") as HTMLInputElement | null;
  const muteSoundsSwitch = $("muteSoundsSwitch") as HTMLInputElement | null;
  const muteSystemSwitch = $("muteSystemSwitch") as HTMLInputElement | null;
  const voicePreviewProjectRow = $("voicePreviewProjectRow");
  if (!muteAllSwitch || !muteSoundsSwitch || !muteSystemSwitch) return;

  muteAllSwitch.checked = !!s.muteAll;
  muteSoundsSwitch.checked = !!s.muteSounds;
  muteSystemSwitch.checked = !!s.muteSystemNotifications;
  applyMuteAllVisual();

  muteAllSwitch.addEventListener("change", () => { applyMuteAllVisual(); saveSettings(); });
  muteSoundsSwitch.addEventListener("change", saveSettings);

  buildNotifCards();
  const notifs = (s.notifications as Record<string, Record<string, unknown>>) || {};
  await Promise.all(NOTIF_TYPES.map((t) => renderNotifCard(t.key, notifs[t.key] || {})));
  await populateVoicePreview();
  await loadPiperVoices();
  primeWebVoices();

  if (voicePreviewProjectRow) voicePreviewProjectRow.style.display = "flex";
}

// Back-compat window binding.
(window as unknown as { renderNotificationSettings?: () => Promise<void> }).renderNotificationSettings = hydrateNotifications;

export async function renderNotificationsView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  const backBtn = root.querySelector<HTMLButtonElement>(".back-to-settings");
  if (backBtn) backBtn.onclick = () => g().navigateTo("settings");

  try { await hydrateNotifications(); }
  catch (e) { console.error("[notifications] render failed", e); }

  return () => { /* no teardown */ };
}

function template() {
  return html`
    <div class="view view-settings-notifications">
      <div class="view-header">
        <button class="icon-btn back-to-settings" title="Back">←</button>
        <h2>Notifications</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">
        <div class="section" id="muteSection">
          <div class="section-title">Mute</div>
          <div class="option">
            <span class="option-label">Mute all notifications</span>
            <label class="switch">
              <input type="checkbox" id="muteAllSwitch">
              <span class="slider"></span>
            </label>
          </div>
          <div class="option mute-child">
            <span class="option-label">Mute sounds</span>
            <label class="switch">
              <input type="checkbox" id="muteSoundsSwitch">
              <span class="slider"></span>
            </label>
          </div>
          <div class="option mute-child is-disabled" title="Coming soon - OS toasts aren't implemented yet">
            <span class="option-label">Mute system notifications <span style="color:var(--text-dim);font-size:0.75rem">(coming soon)</span></span>
            <label class="switch">
              <input type="checkbox" id="muteSystemSwitch" disabled>
              <span class="slider"></span>
            </label>
          </div>
        </div>
        <template id="notifCardTemplate">
          <div class="section notif-card">
            <div class="section-title notif-title"></div>
            <div class="option">
              <span class="option-label">Enabled</span>
              <label class="switch">
                <input type="checkbox" class="notif-enabled">
                <span class="slider"></span>
              </label>
            </div>
            <div class="option notif-body" style="display:none">
              <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Type</span>
              <div style="display:flex;gap:10px">
                <label style="display:flex;align-items:center;gap:4px;font-size:0.85rem"><input type="radio" class="notif-mode" value="sound"> Sound</label>
                <label style="display:flex;align-items:center;gap:4px;font-size:0.85rem"><input type="radio" class="notif-mode" value="voice"> Voice</label>
              </div>
            </div>
            <div class="option notif-sound-row" style="display:none">
              <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Sound</span>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end">
                <select class="notif-sound-file"></select>
                <button class="btn-secondary notif-sound-preview" style="padding:3px 10px;font-size:0.8rem">▶</button>
              </div>
            </div>
            <div class="notif-voice-rows" style="display:none;flex-direction:column;gap:6px;padding:6px 0">
              <div class="option" style="border:none;padding:0">
                <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Voice</span>
                <select class="notif-voice-select" style="flex:1;max-width:220px"></select>
              </div>
              <div class="option" style="border:none;padding:0;flex-direction:column;align-items:stretch;gap:4px">
                <span class="option-label notif-template-label" style="font-size:0.82rem;color:var(--text-dim)">Message</span>
                <div style="display:flex;align-items:center;gap:8px">
                  <input type="text" class="notif-template" style="flex:1;padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:0.85rem">
                  <button class="btn-secondary notif-voice-preview" style="padding:3px 10px;font-size:0.8rem">▶</button>
                </div>
                <span class="notif-template-hint" style="font-size:0.72rem;color:var(--text-dim)"></span>
              </div>
            </div>
          </div>
        </template>
        <div id="notifCards"></div>
        <div class="option" id="voicePreviewProjectRow" style="display:none">
          <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Preview with project</span>
          <select id="voicePreviewProject" style="flex:1;max-width:220px"></select>
        </div>
      </div>
    </div>
  `;
}
