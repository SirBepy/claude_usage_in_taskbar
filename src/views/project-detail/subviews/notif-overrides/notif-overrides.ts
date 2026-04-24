import { html, render } from "lit-html";
import "./notif-overrides.css";
import { getProjectDetailState, getSettings } from "../../../../shared/state";
import { populateProjectSubviewHeader } from "../sessions-list/sessions-list";
import { backFromSubview } from "../../../../shared/navigation";
import {
  loadPacks,
  findPack,
  populatePackSelect,
  populateSoundSelect,
  installPack,
  type SoundPack,
} from "../../../../shared/sound-packs";
import { api } from "../../../../shared/api";

const OVERRIDE_EVENTS: Array<{ key: string; title: string }> = [
  { key: "workFinished",     title: "Done (Work Finished)" },
  { key: "questionAsked",    title: "Waiting (Question Asked)" },
  { key: "thresholdCrossed", title: "Threshold Reached" },
];

interface OverrideRule {
  enabled?: boolean;
  mode?: "sound" | "voice";
  soundPack?: string;
  soundFile?: string;
  voiceName?: string | null;
  template?: string;
}

export async function renderProjectOverrides(cwdKey: string): Promise<void> {
  const root = document.getElementById("projectOverrideRows");
  const tpl = document.getElementById("projectOverrideRowTemplate") as HTMLTemplateElement | null;
  if (!root || !tpl) return;
  root.innerHTML = "";
  const settings = getSettings();
  settings.projectNotifOverrides = (settings.projectNotifOverrides || {}) as Record<string, Record<string, OverrideRule>>;
  const allOverrides = settings.projectNotifOverrides as Record<string, Record<string, OverrideRule>>;
  const perProject = allOverrides[cwdKey] || {};
  const packs = await loadPacks();

  for (const ev of OVERRIDE_EVENTS) {
    const node = (tpl.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
    const rule: OverrideRule = perProject[ev.key] || {};
    (node.querySelector(".override-title") as HTMLElement).textContent = ev.title;
    const enabledBox = node.querySelector(".override-enabled") as HTMLInputElement;
    const body = node.querySelector(".override-body") as HTMLElement;
    const modes = node.querySelectorAll<HTMLInputElement>(".override-mode");
    const soundRow = node.querySelector(".override-sound-row") as HTMLElement;
    const voiceRows = node.querySelector(".override-voice-rows") as HTMLElement;
    const packSel = node.querySelector(".override-sound-pack") as HTMLSelectElement;
    const soundSel = node.querySelector(".override-sound-file") as HTMLSelectElement;
    const installBtn = node.querySelector(".override-pack-install") as HTMLButtonElement;
    const previewBtn = node.querySelector(".override-sound-preview") as HTMLButtonElement;
    const voiceSel = node.querySelector(".override-voice-select") as HTMLSelectElement;
    const templateInput = node.querySelector(".override-template") as HTMLInputElement;

    enabledBox.checked = !!rule.enabled;
    const mode = rule.mode === "voice" ? "voice" : "sound";
    modes.forEach((r) => {
      r.checked = r.value === mode;
      r.name = `override-mode-${ev.key}-${cwdKey}`;
    });
    const currentPack = rule.soundPack || "default";
    const currentSound = rule.soundFile || "sound1.mp3";
    populatePackSelect(packSel, packs, currentPack);
    const pack: SoundPack | null = findPack(packs, currentPack);
    populateSoundSelect(soundSel, pack, currentSound);
    installBtn.style.display = (pack && !pack.installed) ? "inline-block" : "none";
    templateInput.value = rule.template || "";

    const applyVis = () => {
      body.style.display = enabledBox.checked ? "block" : "none";
      const m = Array.from(modes).find((r) => r.checked)?.value || "sound";
      soundRow.style.display = (enabledBox.checked && m === "sound") ? "flex" : "none";
      voiceRows.style.display = (enabledBox.checked && m === "voice") ? "flex" : "none";
    };
    applyVis();

    const save = () => {
      allOverrides[cwdKey] = allOverrides[cwdKey] || {};
      allOverrides[cwdKey]![ev.key] = {
        enabled: enabledBox.checked,
        mode: (Array.from(modes).find((r) => r.checked)?.value as "sound" | "voice" | undefined) || "sound",
        soundPack: packSel.value || "default",
        soundFile: soundSel.value,
        voiceName: voiceSel.value || null,
        template: templateInput.value || "",
      };
      void api.saveSettings(settings);
    };

    enabledBox.addEventListener("change", () => { applyVis(); save(); });
    modes.forEach((r) => r.addEventListener("change", () => { applyVis(); save(); }));
    packSel.addEventListener("change", async () => {
      const refreshed = await loadPacks();
      const p = findPack(refreshed, packSel.value);
      populateSoundSelect(soundSel, p, p?.sounds[0]?.id);
      installBtn.style.display = (p && !p.installed) ? "inline-block" : "none";
      save();
    });
    soundSel.addEventListener("change", save);
    templateInput.addEventListener("input", save);
    voiceSel.addEventListener("change", save);
    installBtn.addEventListener("click", async () => {
      installBtn.disabled = true;
      installBtn.textContent = "Installing...";
      try {
        const refreshed = await installPack(packSel.value);
        const p = findPack(refreshed, packSel.value);
        populatePackSelect(packSel, refreshed, packSel.value);
        populateSoundSelect(soundSel, p, soundSel.value);
        installBtn.style.display = "none";
      } catch (e) {
        console.error("[override pack install] failed", e);
        alert("Pack install failed.");
      } finally {
        installBtn.disabled = false;
        installBtn.textContent = "Install";
      }
    });
    previewBtn.addEventListener("click", () => {
      api.playPackSoundPreview(packSel.value, soundSel.value).catch((e) => {
        console.error("[sound preview] failed", e);
      });
    });

    root.appendChild(node);
  }
}

(window as unknown as { renderProjectOverrides?: (cwd: string) => Promise<void> }).renderProjectOverrides =
  renderProjectOverrides;

export async function renderNotifOverridesView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  populateProjectSubviewHeader("notifOverrides");

  const backBtn = root.querySelector<HTMLButtonElement>("#notifOverridesBackBtn");
  if (backBtn) backBtn.onclick = () => backFromSubview();

  const cwd = getProjectDetailState().cwd;
  if (cwd) {
    try {
      await renderProjectOverrides(cwd);
    } catch (e) {
      console.error("[notif-overrides] render failed", e);
    }
  }

  return () => { /* no teardown */ };
}

function template() {
  return html`
    <div class="view view-project-notif-overrides">
      <div class="view-header subview-header">
        <button class="icon-btn" id="notifOverridesBackBtn" title="Back"><i class="ph ph-arrow-left"></i></button>
        <div class="project-detail-heading">
          <div class="avatar-mini" id="notifOverridesAvatar">?</div>
          <div class="project-detail-titles">
            <h2 id="notifOverridesTitle" style="font-size:0.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Project</h2>
            <div class="project-detail-path" id="notifOverridesPath"></div>
          </div>
        </div>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">
        <div class="section" style="margin-top:12px">
          <div class="section-title">Notification overrides</div>
          <template id="projectOverrideRowTemplate">
            <div class="project-override">
              <div class="option">
                <span class="option-label override-title"></span>
                <label class="switch">
                  <input type="checkbox" class="override-enabled">
                  <span class="slider"></span>
                </label>
              </div>
              <div class="override-body" style="display:none;padding-left:8px">
                <div class="option">
                  <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Type</span>
                  <div style="display:flex;gap:10px">
                    <label style="display:flex;align-items:center;gap:4px;font-size:0.85rem"><input type="radio" class="override-mode" value="sound"> Sound</label>
                    <label style="display:flex;align-items:center;gap:4px;font-size:0.85rem"><input type="radio" class="override-mode" value="voice"> Voice</label>
                  </div>
                </div>
                <div class="option override-sound-row" style="display:none">
                  <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Sound</span>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end">
                    <select class="override-sound-pack"></select>
                    <select class="override-sound-file"></select>
                    <button class="btn-secondary override-pack-install" style="display:none;padding:3px 10px;font-size:0.8rem">Install</button>
                    <button class="btn-secondary override-sound-preview" style="padding:3px 10px;font-size:0.8rem">▶</button>
                  </div>
                </div>
                <div class="override-voice-rows" style="display:none;flex-direction:column;gap:6px;padding:6px 0">
                  <div class="option" style="border:none;padding:0">
                    <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Voice</span>
                    <select class="override-voice-select" style="flex:1;max-width:220px"></select>
                  </div>
                  <div class="option" style="border:none;padding:0;flex-direction:column;align-items:stretch;gap:4px">
                    <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Message</span>
                    <input type="text" class="override-template" style="padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:0.85rem">
                  </div>
                </div>
              </div>
            </div>
          </template>
          <div id="projectOverrideRows"></div>
        </div>
      </div>
    </div>
  `;
}
