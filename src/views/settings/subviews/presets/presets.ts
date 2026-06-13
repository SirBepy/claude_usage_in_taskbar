import { html, render } from "lit-html";
import { invoke } from "../../../../shared/ipc";
import { getSettings, setSettings } from "../../../../shared/state";
import { api } from "../../../../shared/api";
import { escapeHtml } from "../../../../shared/escape-html";
import {
  EFFORTS,
  type Preset,
  isEffort,
  readPresets,
  readModels,
  readDefaultFlags,
  modelDisplayLabel,
} from "../../../../shared/effort-presets";
import "./presets.css";

/** Parse a comma-separated models string into a trimmed, deduped, non-empty list. */
function parseModels(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

/**
 * Build a preset row as a plain HTML string. The whole rows block is injected
 * via `listEl.innerHTML` (plain DOM) AFTER the lit render of the page — NOT as
 * lit child templates. Production lit-html's <template>-based parser fails to
 * render a repeated nested template containing <select>: the list comes out as
 * just a lit marker comment with zero rows (confirmed via DOM probe). The
 * browser's native innerHTML parser handles <select>/<option> correctly, which
 * is why the app fills selects this way elsewhere (notifications.ts).
 */
function rowHtml(p: Preset, i: number, models: string[]): string {
  // Keep the preset's own model selectable even if absent from the list.
  const opts = models.includes(p.model) ? models : [p.model, ...models];
  const modelOpts = opts
    .map((m) => `<option value="${escapeHtml(m)}"${m === p.model ? " selected" : ""}>${escapeHtml(modelDisplayLabel(m))}</option>`)
    .join("");
  const effortOpts = EFFORTS
    .map((e) => `<option value="${e}"${e === p.effort ? " selected" : ""}>${escapeHtml(e)}</option>`)
    .join("");
  return (
    `<div class="preset-row" data-idx="${i}">` +
    `<input type="text" class="preset-name" maxlength="20" value="${escapeHtml(p.name)}" placeholder="Name">` +
    `<select class="preset-model">${modelOpts}</select>` +
    `<select class="preset-effort">${effortOpts}</select>` +
    `</div>`
  );
}

function template(
  models: string[],
  flags: { autoAccept: boolean; remote: boolean },
  errorMsg: string | null,
) {
  return html`
    <div class="view view-settings-presets">
      <div class="view-header">
        <button class="icon-btn back-to-settings" title="Back">←</button>
        <h2>Session presets</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">
        <div class="kit-section">
          <label class="presets-field-label" for="presetsModels">Models</label>
          <input
            type="text"
            class="presets-models-input"
            id="presetsModels"
            value="${models.join(", ")}"
            placeholder="haiku, sonnet, opus"
          >
          <p class="presets-hint">Models offered in the New session picker, comma-separated.</p>
        </div>
        <div class="kit-section">
          <label class="presets-check">
            <input type="checkbox" id="presetsAutoAllow"${flags.autoAccept ? " checked" : ""}>
            Auto-allow permissions by default
          </label>
          <label class="presets-check">
            <input type="checkbox" id="presetsRemote"${flags.remote ? " checked" : ""}>
            Remote chat by default
          </label>
        </div>
        <div class="kit-section">
          <p class="presets-hint">Three quick-pick presets that show in the "New session" modal.</p>
          <div class="presets-list"></div>
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

function validate(presets: Preset[], models: string[]): string | null {
  for (let i = 0; i < presets.length; i++) {
    const p = presets[i]!;
    if (!p.name) return `Preset ${i + 1}: name required`;
    if (!models.includes(p.model)) return `Preset ${i + 1}: invalid model`;
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
  let presets = readPresets(settings, { padWithDefaults: true });
  let models = readModels(settings);
  let flags = readDefaultFlags(settings);

  function readModelsField(): string[] {
    const raw = root.querySelector<HTMLInputElement>("#presetsModels")?.value ?? "";
    const parsed = parseModels(raw);
    return parsed.length > 0 ? parsed : models;
  }

  // Pull the current form state back into the source-of-truth vars so an
  // error-path rerender preserves the user's in-progress edits.
  function syncFromDom(): void {
    if (!root.querySelector("#presetsModels")) return;
    models = readModelsField();
    presets = readRows(root);
    flags = {
      autoAccept: root.querySelector<HTMLInputElement>("#presetsAutoAllow")?.checked ?? flags.autoAccept,
      remote: root.querySelector<HTMLInputElement>("#presetsRemote")?.checked ?? flags.remote,
    };
  }

  function rerender(errMsg: string | null = null) {
    render(template(models, flags, errMsg), root);
    // Inject the preset rows via plain innerHTML. lit-html can't render a
    // repeated template containing <select> in the prod build (empty list); the
    // native parser handles it. See rowHtml.
    const listEl = root.querySelector<HTMLElement>(".presets-list");
    if (listEl) listEl.innerHTML = presets.map((p, i) => rowHtml(p, i, models)).join("");
    const backBtn = root.querySelector<HTMLButtonElement>(".back-to-settings");
    if (backBtn) backBtn.onclick = () => g().navigateTo("settings");

    const saveBtn = root.querySelector<HTMLButtonElement>("#presetsSaveBtn");
    if (saveBtn) {
      saveBtn.onclick = async () => {
        syncFromDom();
        const liveModels = models;
        const fresh = presets;
        const err = validate(fresh, liveModels);
        if (err) {
          rerender(err);
          return;
        }
        const autoAllow = flags.autoAccept;
        const remote = flags.remote;
        try {
          const cur = {
            ...getSettings(),
            effortPresets: fresh,
            models: liveModels,
            defaultAutoAllow: autoAllow,
            defaultRemoteControl: remote,
          };
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
