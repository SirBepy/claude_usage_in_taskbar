import { html, render } from "lit-html";
import { invoke } from "../../../../shared/ipc";
import { getSettings, setSettings } from "../../../../shared/state";
import { api } from "../../../../shared/api";
import { escapeHtml } from "../../../../shared/escape-html";
import "./presets.css";

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

interface Preset {
  name: string;
  model: string;
  effort: string;
}

const MODELS = ["haiku", "sonnet", "opus"] as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const DEFAULT_PRESETS: Preset[] = [
  { name: "Light", model: "sonnet", effort: "low" },
  { name: "Normal", model: "opus", effort: "high" },
  { name: "Heavy", model: "opus", effort: "max" },
];

function isModel(v: unknown): v is typeof MODELS[number] {
  return typeof v === "string" && (MODELS as readonly string[]).includes(v);
}
function isEffort(v: unknown): v is typeof EFFORTS[number] {
  return typeof v === "string" && (EFFORTS as readonly string[]).includes(v);
}

function readPresets(settings: Record<string, unknown>): Preset[] {
  const raw = settings["effortPresets"];
  if (!Array.isArray(raw)) return [...DEFAULT_PRESETS];
  const out: Preset[] = [];
  for (const p of raw) {
    if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name : "";
      const model = isModel(o.model) ? o.model : "";
      const effort = isEffort(o.effort) ? o.effort : "";
      if (name && model && effort) out.push({ name, model, effort });
    }
  }
  while (out.length < 3) {
    const d = DEFAULT_PRESETS[out.length]!;
    out.push({ ...d });
  }
  return out.slice(0, 3);
}

function rowTemplate(p: Preset, i: number) {
  const modelOpts = MODELS.map(
    (m) => `<option value="${m}"${m === p.model ? " selected" : ""}>${escapeHtml(m)}</option>`,
  ).join("");
  const effortOpts = EFFORTS.map(
    (e) => `<option value="${e}"${e === p.effort ? " selected" : ""}>${escapeHtml(e)}</option>`,
  ).join("");
  return html`
    <div class="preset-row" data-idx="${i}">
      <input type="text" class="preset-name" maxlength="20" value="${p.name}" placeholder="Name">
      <select class="preset-model" .innerHTML=${modelOpts}></select>
      <select class="preset-effort" .innerHTML=${effortOpts}></select>
    </div>
  `;
}

function template(presets: Preset[], errorMsg: string | null) {
  return html`
    <div class="view view-settings-presets">
      <div class="view-header">
        <button class="icon-btn back-to-settings" title="Back">←</button>
        <h2>Session presets</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">
        <div class="section">
          <p class="presets-hint">Three quick-pick presets that show in the "New session" modal.</p>
          <div class="presets-list">
            ${presets.map((p, i) => rowTemplate(p, i))}
          </div>
          ${errorMsg ? html`<div class="presets-error">${errorMsg}</div>` : ""}
          <div class="presets-actions">
            <button class="btn-primary" id="presetsSaveBtn">Save</button>
            <span class="presets-status" id="presetsStatus"></span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function readRows(root: HTMLElement): Preset[] {
  const out: Preset[] = [];
  root.querySelectorAll<HTMLElement>(".preset-row").forEach((row) => {
    const name = row.querySelector<HTMLInputElement>(".preset-name")?.value.trim() ?? "";
    const model = row.querySelector<HTMLSelectElement>(".preset-model")?.value ?? "";
    const effort = row.querySelector<HTMLSelectElement>(".preset-effort")?.value ?? "";
    out.push({ name, model, effort });
  });
  return out;
}

function validate(presets: Preset[]): string | null {
  for (let i = 0; i < presets.length; i++) {
    const p = presets[i]!;
    if (!p.name) return `Preset ${i + 1}: name required`;
    if (!isModel(p.model)) return `Preset ${i + 1}: invalid model`;
    if (!isEffort(p.effort)) return `Preset ${i + 1}: invalid effort`;
  }
  return null;
}

export async function renderPresetsView(root: HTMLElement): Promise<() => void> {
  let settings: Record<string, unknown> = {};
  try {
    settings = await invoke<Record<string, unknown>>("get_settings");
  } catch (e) {
    console.error("[presets] get_settings failed", e);
  }
  const presets = readPresets(settings);

  function rerender(errMsg: string | null = null) {
    render(template(presets, errMsg), root);
    const backBtn = root.querySelector<HTMLButtonElement>(".back-to-settings");
    if (backBtn) backBtn.onclick = () => g().navigateTo("settings");

    const saveBtn = root.querySelector<HTMLButtonElement>("#presetsSaveBtn");
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const fresh = readRows(root);
        const err = validate(fresh);
        if (err) {
          rerender(err);
          return;
        }
        try {
          const cur = { ...getSettings(), effortPresets: fresh };
          setSettings(cur);
          await api.saveSettings(cur);
          const status = root.querySelector<HTMLElement>("#presetsStatus");
          if (status) {
            status.textContent = "Saved";
            setTimeout(() => { if (status) status.textContent = ""; }, 1500);
          }
        } catch (e) {
          rerender(`Save failed: ${e}`);
        }
      };
    }
  }

  rerender(null);
  return () => { /* no teardown */ };
}
