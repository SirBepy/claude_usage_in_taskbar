import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";

export interface SessionConfig {
  model: string;
  effort: string;
}

export interface EffortPreset {
  name: string;
  model: string;
  effort: string;
}

const MODELS = ["haiku", "sonnet", "opus"] as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const DEFAULT_PRESETS: EffortPreset[] = [
  { name: "Light", model: "sonnet", effort: "low" },
  { name: "Normal", model: "opus", effort: "high" },
  { name: "Heavy", model: "opus", effort: "max" },
];

function readPresets(settings: Record<string, unknown>): EffortPreset[] {
  const raw = settings["effortPresets"];
  if (!Array.isArray(raw)) return DEFAULT_PRESETS;
  const out: EffortPreset[] = [];
  for (const p of raw) {
    if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name : "";
      const model = typeof o.model === "string" ? o.model : "";
      const effort = typeof o.effort === "string" ? o.effort : "";
      if (name && MODELS.includes(model as typeof MODELS[number]) && EFFORTS.includes(effort as typeof EFFORTS[number])) {
        out.push({ name, model, effort });
      }
    }
  }
  return out.length === 3 ? out : DEFAULT_PRESETS;
}

function readLastChoice(settings: Record<string, unknown>, projectPath: string): SessionConfig | null {
  const map = settings["projectLastChoice"];
  if (!map || typeof map !== "object") return null;
  const entry = (map as Record<string, unknown>)[projectPath];
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const model = typeof e.model === "string" ? e.model : "";
  const effort = typeof e.effort === "string" ? e.effort : "";
  if (MODELS.includes(model as typeof MODELS[number]) && EFFORTS.includes(effort as typeof EFFORTS[number])) {
    return { model, effort };
  }
  return null;
}

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
  const normalPreset: EffortPreset =
    presets.find((p) => p.name === "Normal") ?? presets[1] ?? DEFAULT_PRESETS[1]!;
  const initial = readLastChoice(settings, projectPath) ?? { model: normalPreset.model, effort: normalPreset.effort };

  return new Promise<SessionConfig | null>((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "model-effort-modal-overlay";

    let model = initial.model;
    let effort = initial.effort;
    let activePresetIndex = -1;

    function syncActivePreset() {
      activePresetIndex = presets.findIndex((p) => p.model === model && p.effort === effort);
    }
    syncActivePreset();

    function modelIdx(): number { return Math.max(0, MODELS.indexOf(model as typeof MODELS[number])); }
    function effortIdx(): number { return Math.max(0, EFFORTS.indexOf(effort as typeof EFFORTS[number])); }

    function renderBody() {
      const presetButtons = presets.map((p, i) => `
        <button type="button" class="preset-btn${i === activePresetIndex ? " active" : ""}" data-idx="${i}">
          ${escapeHtml(p.name)}
        </button>
      `).join("");

      const modelLabels = MODELS.map((m, i) => `
        <span class="slider-stop-label${i === modelIdx() ? " active" : ""}" data-stop="${i}">${escapeHtml(m)}</span>
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
            <input type="range" class="me-slider me-model-slider" min="0" max="${MODELS.length - 1}" step="1" value="${modelIdx()}">
            <div class="me-stop-labels">${modelLabels}</div>
          </div>

          <div class="me-field">
            <label class="me-label">Effort</label>
            <input type="range" class="me-slider me-effort-slider" min="0" max="${EFFORTS.length - 1}" step="1" value="${effortIdx()}">
            <div class="me-stop-labels">${effortLabels}</div>
          </div>

          <div class="me-actions">
            <button type="button" class="me-cancel">Cancel</button>
            <button type="button" class="me-confirm">Start session</button>
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
        model = MODELS[i] ?? model;
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

      overlay.querySelector<HTMLButtonElement>(".me-cancel")?.addEventListener("click", () => close(null));
      overlay.querySelector<HTMLButtonElement>(".me-confirm")?.addEventListener("click", () => {
        void persistChoice().then(() => close({ model, effort }));
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
        void persistChoice().then(() => close({ model, effort }));
      }
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener("keydown", onKey);

    document.body.appendChild(overlay);
    renderBody();
  });
}
