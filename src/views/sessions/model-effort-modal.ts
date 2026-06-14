import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { api } from "../../shared/api";
import type { Character } from "../../shared/api";
import { openChangeCharacterModal } from "../../shared/change-character-modal";
import {
  EFFORTS,
  DEFAULT_PRESETS,
  type Preset as EffortPreset,
  type SessionConfig,
  readPresets,
  readLastChoice,
  readModels,
  readDefaultFlags,
  modelDisplayLabel,
  latestIdForFamily,
} from "../../shared/effort-presets";
import { state } from "./state";
import { characterForSession } from "./session-characters";

export type { SessionConfig };
export type { EffortPreset };

// ── Sound debounce ────────────────────────────────────────────────────────────
// Module-level so multiple rapid picks don't stack timers.
let _selectTimer: ReturnType<typeof setTimeout> | null = null;
function playSelect(id: string): void {
  if (_selectTimer !== null) clearTimeout(_selectTimer);
  _selectTimer = setTimeout(() => {
    _selectTimer = null;
    api.playCharacterSlot(id, "select").catch(() => {});
  }, 250);
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
  const models = readModels(settings);
  const defaultFlags = readDefaultFlags(settings);
  const normalPreset: EffortPreset =
    presets.find((p) => p.name === "Normal") ?? presets[1] ?? DEFAULT_PRESETS[1]!;
  const initial = readLastChoice(settings, projectPath) ?? { model: normalPreset.model, effort: normalPreset.effort };

  // Resolve projectId for whitelist + live-taken dedup
  let projectId: string | null = null;
  try {
    const projects = await api.listProjects();
    projectId = projects.find((p) => String(p.path) === projectPath)?.id ?? null;
  } catch {
    // stay null
  }

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

    // ── Character pane state ──────────────────────────────────────────────────
    let character: Character | null = null;
    let pool: Character[] | null = null; // null = not loaded yet
    // icon url cache: charId -> url (null = in-flight)
    const iconCache = new Map<string, string | null>();

    /** Pick a random character from the pool, excluding `excludeId` and ids
     * already held by live sessions of this project. Falls back to the whole
     * pool (duplicate allowed) if the filtered set is empty. */
    function pickCharacter(excludeId: string | null): void {
      if (!pool || pool.length === 0) return;

      // Live-taken: ids held by live sessions of THIS project
      const liveTaken = new Set(
        state.sessions
          .filter((s) => s.project_id === projectId && !s.ended_at && !(s as { end_reason?: unknown }).end_reason)
          .map((s) => characterForSession(s))
          .filter((id): id is string => id !== null),
      );

      // Prefer: pool minus liveTaken minus excludeId
      let candidates = pool.filter((c) => !liveTaken.has(c.id) && c.id !== excludeId);
      // Fallback: pool minus excludeId
      if (candidates.length === 0) candidates = pool.filter((c) => c.id !== excludeId);
      // Last resort: whole pool
      if (candidates.length === 0) candidates = pool;

      const pick = candidates[Math.floor(Math.random() * candidates.length)]!;
      character = pick;
      playSelect(pick.id);
    }

    /** Render just the right-side character pane HTML; replaces .me-char-pane in place. */
    function renderCharPane(): void {
      const pane = overlay.querySelector<HTMLElement>(".me-char-pane");
      if (!pane) return;

      if (projectId === null || (pool !== null && pool.length === 0)) {
        pane.innerHTML = `<div class="me-char-empty">No characters available</div>`;
        return;
      }

      if (pool === null) {
        pane.innerHTML = `<div class="me-char-loading">Loading character...</div>`;
        return;
      }

      if (!character) {
        pane.innerHTML = `<div class="me-char-empty">No character selected</div>`;
        return;
      }

      const charId = character.id;
      const cachedUrl = iconCache.get(charId);
      let portraitHtml: string;
      if (cachedUrl) {
        portraitHtml = `<img class="me-char-portrait" src="${escapeHtml(cachedUrl)}" alt="${escapeHtml(character.label)}" data-char-portrait="${escapeHtml(charId)}">`;
      } else {
        portraitHtml = `<div class="me-char-portrait me-char-portrait-ph" data-char-portrait-ph="${escapeHtml(charId)}"><i class="ph ph-question"></i></div>`;
      }

      const gameLine = character.game_label
        ? `<span class="me-char-game">${escapeHtml(character.game_label)}</span>`
        : "";

      pane.innerHTML = `
        ${portraitHtml}
        <span class="me-char-name">${escapeHtml(character.label)}</span>
        ${gameLine}
        <div class="me-char-btns">
          <button type="button" class="me-char-reroll"><i class="ph ph-shuffle"></i> Reroll</button>
          <button type="button" class="me-char-choose"><i class="ph ph-user"></i> Choose</button>
        </div>
      `;

      attachCharHandlers();

      // Lazy-load portrait if not cached yet
      if (!iconCache.has(charId)) {
        iconCache.set(charId, null); // in-flight sentinel
        api.characterAssetUrl(charId, "icon.png").then((url) => {
          iconCache.set(charId, url);
          // Patch DOM directly - avoid full re-render
          const ph = overlay.querySelector<HTMLElement>(`[data-char-portrait-ph="${CSS.escape(charId)}"]`);
          if (ph && url) {
            const img = document.createElement("img");
            img.className = "me-char-portrait";
            img.src = url;
            img.alt = character?.label ?? "";
            img.dataset.charPortrait = charId;
            ph.replaceWith(img);
          }
        }).catch(() => { /* leave placeholder */ });
      }
    }

    function attachCharHandlers(): void {
      overlay.querySelector<HTMLButtonElement>(".me-char-reroll")?.addEventListener("click", () => {
        pickCharacter(character?.id ?? null);
        renderCharPane();
      });

      overlay.querySelector<HTMLButtonElement>(".me-char-choose")?.addEventListener("click", () => {
        if (!projectId) return;
        void openChangeCharacterModal({
          projectId,
          currentId: character?.id ?? null,
        }).then(async (picked) => {
          if (!picked) return;
          // Look up in pool first; if not there (e.g. pool is "whitelisted" but user
          // picked from "all"), fetch the full list and find it there.
          let found = pool?.find((c) => c.id === picked) ?? null;
          if (!found) {
            try {
              const all = await api.listCharacters();
              found = all.find((c) => c.id === picked) ?? null;
            } catch {
              // best-effort; fall back to a stub
            }
          }
          if (found) {
            character = found;
          } else {
            // Stub: only id is known; label/game unavailable but pane still works
            character = { id: picked, label: picked, version: 0, icon: "", slots: {} };
          }
          playSelect(picked);
          renderCharPane();
        });
      });
    }

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
        <span class="slider-stop-label${i === modelIdx() ? " active" : ""}" data-stop="${i}">${escapeHtml(modelDisplayLabel(m))}</span>
      `).join("");
      const effortLabels = EFFORTS.map((e, i) => `
        <span class="slider-stop-label${i === effortIdx() ? " active" : ""}" data-stop="${i}">${escapeHtml(e)}</span>
      `).join("");

      overlay.innerHTML = `
        <div class="model-effort-modal-card" role="dialog" aria-modal="true" aria-label="Pick model and effort">
          <div class="me-columns">
            <div class="me-left-col">
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

              ${modelDisabled() ? `<div class="me-model-warning" role="alert">${escapeHtml(modelDisplayLabel(model))} is disabled, please choose another model</div>` : ""}

              <div class="me-actions">
                <button type="button" class="me-cancel">Cancel</button>
                <button type="button" class="me-confirm"${modelDisabled() ? " disabled" : ""}>Start session</button>
              </div>
            </div>
            <div class="me-char-pane"></div>
          </div>
        </div>
      `;
      attachHandlers();
      renderCharPane();
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
        void persistChoice().then(() => close({ model, effort, autoAccept, remote, characterId: character?.id ?? null }));
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
      if (_selectTimer !== null) { clearTimeout(_selectTimer); _selectTimer = null; }
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
        void persistChoice().then(() => close({ model, effort, autoAccept, remote, characterId: character?.id ?? null }));
      }
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener("keydown", onKey);

    document.body.appendChild(overlay);
    renderBody();

    // ── Load character pool in background ────────────────────────────────────
    if (projectId !== null) {
      api.resolveWhitelistCharacters(projectId)
        .then((chars) => {
          pool = chars;
          if (pool.length > 0) {
            pickCharacter(null); // initial pick (plays sound)
          }
          renderCharPane();
        })
        .catch(() => {
          pool = []; // treat as unavailable
          renderCharPane();
        });
    } else {
      pool = [];
      // no need to re-render; renderBody already emitted "No characters available" state
    }

    // ── Probe model availability in background ────────────────────────────────
    // Probe needs full ids (count_tokens rejects bare family aliases), so map
    // each family -> its latest id, probe those, then key results back by
    // family. Families with no API id (exotic user models) are left selectable.
    // When it resolves, re-render so a disabled model (e.g. Fable 5) blocks
    // Start. Fails open: any probe error leaves every model selectable.
    const idByFamily = new Map<string, string>();
    for (const fam of models) {
      const id = latestIdForFamily(fam);
      if (id) idByFamily.set(fam, id);
    }
    if (idByFamily.size > 0) {
      void api.probeModelsAvailability([...idByFamily.values()])
        .then((results) => {
          const byId = new Map(results.map((r) => [r.id, r.available]));
          for (const [fam, id] of idByFamily) availability[fam] = byId.get(id) ?? true;
          renderBody();
        })
        .catch(() => { /* fail open — leave all models enabled */ });
    }
  });
}
