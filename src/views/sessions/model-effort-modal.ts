import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { api } from "../../shared/api";
import { modelLabel } from "../../shared/model-name";
import {
  EFFORTS,
  DEFAULT_PRESETS,
  type Preset as EffortPreset,
  type SessionConfig,
  readPresets,
  readLastChoice,
  readModels,
  readDefaultFlags,
} from "../../shared/effort-presets";

export type { SessionConfig };
export type { EffortPreset };

export async function openModelEffortModal(
  projectPath: string,
  projectName: string,
): Promise<SessionConfig | null> {
  let settings: Record<string, unknown> = {};
  try {
    settings = await invoke<Record<string, unknown>>("get_settings");
  } catch {
    // ignore — fall back to defaults
  }

  const presets = readPresets(settings);
  const models = readModels(settings);
  const defaultFlags = readDefaultFlags(settings);
  const normalPreset: EffortPreset =
    presets.find((p) => p.name === "Normal") ?? presets[1] ?? DEFAULT_PRESETS[1]!;
  const initial = readLastChoice(settings, projectPath) ?? { model: normalPreset.model, effort: normalPreset.effort };

  return new Promise<SessionConfig | null>((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "model-effort-modal-overlay";

    let model = initial.model;
    let effort = initial.effort;
    // Default flags come from settings (defaultAutoAllow / defaultRemoteControl),
    // NOT lastChoice, which doesn't store them. Both default on.
    let autoAccept = defaultFlags.autoAccept;
    let remote = defaultFlags.remote;
    let activePresetIndex = -1;
    // Per-model availability from the count_tokens probe. Empty until the probe
    // resolves; absent/true => model is selectable. A disabled model (e.g. Fable
    // 5 when Anthropic has it off) stays clickable but blocks "Start session".
    const availability: Record<string, boolean> = {};

    function syncActivePreset() {
      activePresetIndex = presets.findIndex((p) => p.model === model && p.effort === effort);
    }
    syncActivePreset();

    function modelIdx(): number { return Math.max(0, models.indexOf(model)); }
    function effortIdx(): number { return Math.max(0, EFFORTS.indexOf(effort as typeof EFFORTS[number])); }
    function modelDisabled(): boolean { return availability[model] === false; }

    function renderBody() {
      const presetButtons = presets.map((p, i) => `
        <button type="button" class="preset-btn${i === activePresetIndex ? " active" : ""}" data-idx="${i}">
          ${escapeHtml(p.name)}
        </button>
      `).join("");

      const modelLabels = models.map((m, i) => `
        <span class="slider-stop-label${i === modelIdx() ? " active" : ""}" data-stop="${i}">${escapeHtml(modelLabel(m))}</span>
      `).join("");
      const effortLabels = EFFORTS.map((e, i) => `
        <span class="slider-stop-label${i === effortIdx() ? " active" : ""}" data-stop="${i}">${escapeHtml(e)}</span>
      `).join("");

      overlay.innerHTML = `
        <div class="model-effort-modal-card" role="dialog" aria-modal="true" aria-label="Pick model and effort">
          <h3 class="me-title">New session in ${escapeHtml(projectName)}</h3>
          <div class="me-presets">${presetButtons}</div>

          <div class="me-field">
            <label class="me-label">Model</label>
            <input type="range" class="me-slider me-model-slider" min="0" max="${models.length - 1}" step="1" value="${modelIdx()}">
            <div class="me-stop-labels">${modelLabels}</div>
          </div>

          <div class="me-field">
            <label class="me-label">Effort</label>
            <input type="range" class="me-slider me-effort-slider" min="0" max="${EFFORTS.length - 1}" step="1" value="${effortIdx()}">
            <div class="me-stop-labels">${effortLabels}</div>
          </div>

          <details class="me-more">
            <summary class="me-more-summary"><i class="ph ph-caret-right"></i>More options</summary>
            <label class="me-check">
              <input type="checkbox" class="me-auto-accept-input"${autoAccept ? " checked" : ""}>
              Auto allow permissions
            </label>
            <label class="me-check">
              <input type="checkbox" class="me-remote-input"${remote ? " checked" : ""}>
              Remote chat
            </label>
          </details>

          ${modelDisabled() ? `<div class="me-model-warning" role="alert">${escapeHtml(modelLabel(model))} is disabled, please choose another model</div>` : ""}

          <div class="me-actions">
            <button type="button" class="me-cancel">Cancel</button>
            <button type="button" class="me-confirm"${modelDisabled() ? " disabled" : ""}>Start session</button>
          </div>
        </div>
      `;
      attachHandlers();
    }

    function attachHandlers() {
      overlay.querySelectorAll<HTMLButtonElement>(".preset-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.dataset.idx);
          const p = presets[idx];
          if (!p) return;
          model = p.model;
          effort = p.effort;
          activePresetIndex = idx;
          renderBody();
        });
      });

      const modelSlider = overlay.querySelector<HTMLInputElement>(".me-model-slider");
      modelSlider?.addEventListener("input", () => {
        const i = Number(modelSlider.value);
        model = models[i] ?? model;
        syncActivePreset();
        renderBody();
      });

      const effortSlider = overlay.querySelector<HTMLInputElement>(".me-effort-slider");
      effortSlider?.addEventListener("input", () => {
        const i = Number(effortSlider.value);
        effort = EFFORTS[i] ?? effort;
        syncActivePreset();
        renderBody();
      });

      overlay.querySelector<HTMLInputElement>(".me-auto-accept-input")?.addEventListener("change", (e) => {
        autoAccept = (e.target as HTMLInputElement).checked;
      });

      overlay.querySelector<HTMLInputElement>(".me-remote-input")?.addEventListener("change", (e) => {
        remote = (e.target as HTMLInputElement).checked;
      });

      overlay.querySelector<HTMLButtonElement>(".me-cancel")?.addEventListener("click", () => close(null));
      overlay.querySelector<HTMLButtonElement>(".me-confirm")?.addEventListener("click", () => {
        if (modelDisabled()) return;
        void persistChoice().then(() => close({ model, effort, autoAccept, remote }));
      });
    }

    async function persistChoice(): Promise<void> {
      try {
        const cur = await invoke<Record<string, unknown>>("get_settings");
        const lc = (cur["projectLastChoice"] && typeof cur["projectLastChoice"] === "object")
          ? { ...(cur["projectLastChoice"] as Record<string, unknown>) }
          : {};
        lc[projectPath] = { model, effort };
        await invoke("save_settings", { updated: { ...cur, projectLastChoice: lc } });
      } catch (e) {
        console.error("[model-effort-modal] save_settings failed", e);
      }
    }

    function close(result: SessionConfig | null) {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (modelDisabled()) return;
        void persistChoice().then(() => close({ model, effort, autoAccept, remote }));
      }
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener("keydown", onKey);

    document.body.appendChild(overlay);
    renderBody();

    // Probe model availability in the background (free count_tokens calls). When
    // it resolves, re-render so a disabled model (e.g. Fable 5) blocks Start.
    // Fails open: any probe error leaves every model selectable.
    void api.probeModelsAvailability(models)
      .then((results) => {
        for (const r of results) availability[r.id] = r.available;
        renderBody();
      })
      .catch(() => { /* fail open — leave all models enabled */ });
  });
}
