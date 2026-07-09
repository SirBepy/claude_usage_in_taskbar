import { html, render } from "lit-html";
import { getSettings, setSettings } from "../../../../shared/state";
import { api } from "../../../../shared/api";
import { loadSort, saveSort } from "../../../sessions/sessions-helpers";
import type { SessionSort } from "../../../sessions/sessions-helpers";
import {
  EFFORTS,
  type Preset,
  isEffort,
  readPresets,
  readModels,
  readDefaultFlags,
  modelDisplayLabel,
} from "../../../../shared/effort-presets";
import { settingsHeader, toggleRow, selectHtml, escapeHtml } from "../../ui";
import "./chat-defaults.css";

/** Parse a comma-separated models string into a trimmed, deduped, non-empty list. */
function parseModels(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (t && !out.includes(t)) out.push(t);
  }
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

/**
 * Build a preset row as a plain HTML string, same innerHTML-injection
 * workaround as the old presets.ts rowHtml (production lit-html drops a
 * repeated nested template containing a <select> - see ui.ts's
 * "String builders" section comment). Selects are built via ui.ts's
 * selectHtml instead of a hand-rolled <option> string.
 */
function presetRowHtml(p: Preset, i: number, models: string[]): string {
  // Keep the preset's own model selectable even if absent from the list.
  const modelChoices = models.includes(p.model) ? models : [p.model, ...models];
  const modelSelect = selectHtml({
    className: "preset-model",
    options: modelChoices.map((m) => ({ value: m, label: modelDisplayLabel(m) })),
    selected: p.model,
  });
  const effortSelect = selectHtml({
    className: "preset-effort",
    options: EFFORTS.map((e) => ({ value: e, label: e })),
    selected: p.effort,
  });
  return (
    `<div class="cd-preset-row" data-idx="${i}">` +
    `<input type="text" class="preset-name" maxlength="20" value="${escapeHtml(p.name)}" placeholder="Name">` +
    modelSelect +
    effortSelect +
    `</div>`
  );
}

function template(
  models: string[],
  flags: { autoAccept: boolean; remote: boolean },
  sort: SessionSort,
) {
  return html`
    <div class="view view-settings-chat-defaults">
      ${settingsHeader("Chat defaults")}
      <div class="view-body">

        <div class="kit-section">
          <div class="kit-section-title">Behavior</div>
          <div class="kit-row">
            <span class="kit-row-label">Sort chats by</span>
            <select id="chatDefaultsSort" class="kit-select">
              <option value="status" ?selected=${sort === "status"}>Status</option>
              <option value="recent" ?selected=${sort === "recent"}>Recent</option>
              <option value="name" ?selected=${sort === "name"}>Name</option>
              <option value="drain" ?selected=${sort === "drain"}>Token drain</option>
            </select>
          </div>
          ${toggleRow({ label: "Auto-allow permissions by default", inputId: "chatDefaultsAutoAllow", checked: flags.autoAccept })}
          ${toggleRow({ label: "Remote chat by default", inputId: "chatDefaultsRemote", checked: flags.remote })}
        </div>

        <div class="kit-section">
          <div class="kit-section-title">Models</div>
          <input
            type="text"
            class="cd-models-input"
            id="chatDefaultsModels"
            .value=${models.join(", ")}
            placeholder="haiku, sonnet, opus"
          >
          <p class="cd-hint">Models offered in the New session picker, comma-separated.</p>
        </div>

        <div class="kit-section">
          <div class="kit-section-title">Presets</div>
          <p class="cd-hint">Three quick-pick presets that show in the "New session" modal.</p>
          <div class="cd-preset-list"></div>
          <div class="cd-error" id="chatDefaultsError" style="display:none"></div>
        </div>

      </div>
    </div>
  `;
}

export async function renderChatDefaultsView(root: HTMLElement): Promise<() => void> {
  const settings = getSettings();
  let presets = readPresets(settings, { padWithDefaults: true });
  let models = readModels(settings);
  let flags = readDefaultFlags(settings);
  const sort = loadSort();

  render(template(models, flags, sort), root);

  const sortSelect = root.querySelector<HTMLSelectElement>("#chatDefaultsSort");
  if (sortSelect) {
    sortSelect.addEventListener("change", () => {
      const v = sortSelect.value as SessionSort;
      saveSort(v);
      // Dispatch an event so the sessions view can re-render if it's mounted.
      document.dispatchEvent(new CustomEvent("cc-sort-changed"));
    });
  }

  const listEl = root.querySelector<HTMLElement>(".cd-preset-list");
  const errorEl = root.querySelector<HTMLElement>("#chatDefaultsError");

  function renderPresetRows(): void {
    if (listEl) listEl.innerHTML = presets.map((p, i) => presetRowHtml(p, i, models)).join("");
  }
  renderPresetRows();

  function showError(msg: string | null): void {
    if (!errorEl) return;
    errorEl.textContent = msg ?? "";
    errorEl.style.display = msg ? "block" : "none";
  }

  function readModelsField(): string[] {
    const raw = root.querySelector<HTMLInputElement>("#chatDefaultsModels")?.value ?? "";
    const parsed = parseModels(raw);
    return parsed.length > 0 ? parsed : models;
  }

  function readRows(): Preset[] {
    const out: Preset[] = [];
    root.querySelectorAll<HTMLElement>(".cd-preset-row").forEach((row) => {
      const name = row.querySelector<HTMLInputElement>(".preset-name")?.value.trim() ?? "";
      const model = row.querySelector<HTMLSelectElement>(".preset-model")?.value ?? "";
      const effort = row.querySelector<HTMLSelectElement>(".preset-effort")?.value ?? "";
      out.push({ name, model, effort });
    });
    return out;
  }

  // Autosave: every control persists on its own change/input event (no Save
  // button). Same underlying save call as the old presets.ts (a spread of
  // getSettings() plus the four keys below, via api.saveSettings) - only the
  // trigger timing changed. `refreshRows` re-injects the preset rows so their
  // model <select> options pick up an edited models list; skipped for
  // toggle/select-only saves where the row markup can't have gone stale.
  async function persist(refreshRows: boolean): Promise<void> {
    const liveModels = readModelsField();
    const fresh = readRows();
    const err = validate(fresh, liveModels);
    if (err) {
      showError(err);
      return;
    }
    showError(null);
    models = liveModels;
    presets = fresh;
    const autoAllow = root.querySelector<HTMLInputElement>("#chatDefaultsAutoAllow")?.checked ?? flags.autoAccept;
    const remote = root.querySelector<HTMLInputElement>("#chatDefaultsRemote")?.checked ?? flags.remote;
    flags = { autoAccept: autoAllow, remote };
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
      if (refreshRows) renderPresetRows();
    } catch (e) {
      showError(`Save failed: ${e}`);
    }
  }

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  function persistDebounced(refreshRows: boolean): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { void persist(refreshRows); }, 400);
  }

  const autoAllowEl = root.querySelector<HTMLInputElement>("#chatDefaultsAutoAllow");
  if (autoAllowEl) autoAllowEl.addEventListener("change", () => void persist(false));
  const remoteEl = root.querySelector<HTMLInputElement>("#chatDefaultsRemote");
  if (remoteEl) remoteEl.addEventListener("change", () => void persist(false));

  const modelsInput = root.querySelector<HTMLInputElement>("#chatDefaultsModels");
  if (modelsInput) modelsInput.addEventListener("input", () => persistDebounced(true));

  if (listEl) {
    listEl.addEventListener("input", (e) => {
      if ((e.target as HTMLElement)?.classList.contains("preset-name")) persistDebounced(false);
    });
    listEl.addEventListener("change", (e) => {
      const t = e.target as HTMLElement;
      if (t?.classList.contains("preset-model") || t?.classList.contains("preset-effort")) void persist(false);
    });
  }

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}
