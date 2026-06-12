import { invoke } from "../../shared/ipc";

const LAST_PARENT_KEY = "newProjectLastParent";

async function readLastParent(): Promise<string> {
  try {
    const s = await invoke<Record<string, unknown>>("get_settings");
    const v = s?.[LAST_PARENT_KEY];
    if (typeof v === "string" && v.length > 0) return v;
  } catch { /* ignore */ }
  return "";
}

async function saveLastParent(path: string): Promise<void> {
  try {
    const cur = await invoke<Record<string, unknown>>("get_settings");
    await invoke("save_settings", { updated: { ...cur, [LAST_PARENT_KEY]: path } });
  } catch { /* ignore */ }
}

export function openNewProjectModal(): Promise<{ path: string; name: string } | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "new-project-overlay";
    document.body.appendChild(overlay);

    let parentFolder = "";
    let projectName = "";
    let resolved = false;

    const finish = (val: { path: string; name: string } | null) => {
      if (resolved) return;
      resolved = true;
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(val);
    };

    const render = () => {
      const nameTrimmed = projectName.trim();
      const canCreate = nameTrimmed.length > 0 && parentFolder.length > 0;
      const sep = parentFolder.includes("\\") ? "\\" : "/";
      const preview = parentFolder && nameTrimmed
        ? `${parentFolder}${sep}${nameTrimmed}`
        : "";

      overlay.innerHTML = `
        <div class="new-project-backdrop"></div>
        <div class="new-project-card" role="dialog" aria-modal="true" aria-label="New project">
          <h3 class="new-project-title">New project</h3>
          <div class="new-project-field">
            <label class="new-project-label">Project name</label>
            <input
              id="new-project-name"
              class="new-project-input"
              type="text"
              autocomplete="off"
              placeholder="my-project"
              value="${escapeAttr(projectName)}"
            />
          </div>
          <div class="new-project-field">
            <label class="new-project-label">Location</label>
            <div class="new-project-location-row">
              <span class="new-project-location-text ${parentFolder ? "" : "placeholder"}">${parentFolder || "No folder selected"}</span>
              <button class="btn btn-secondary new-project-browse-btn" id="new-project-browse">
                <i class="ph ph-folder-open"></i> Browse
              </button>
            </div>
          </div>
          ${preview ? `<div class="new-project-preview">${escapeHtml(preview)}</div>` : ""}
          <div class="new-project-actions">
            <button class="btn btn-secondary" id="new-project-cancel">Cancel</button>
            <button class="btn btn-primary" id="new-project-create" ${canCreate ? "" : "disabled"}>
              <i class="ph ph-folder-plus"></i> Create
            </button>
          </div>
        </div>
      `;

      const nameInput = overlay.querySelector<HTMLInputElement>("#new-project-name");
      if (nameInput) {
        nameInput.addEventListener("input", (e) => {
          projectName = (e.target as HTMLInputElement).value;
          render();
        });
        nameInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && canCreate) void submit();
        });
        // Focus on first render only (when active element isn't already inside overlay).
        const active = document.activeElement;
        if (!active || !overlay.contains(active)) {
          setTimeout(() => nameInput.focus(), 0);
        }
      }

      overlay.querySelector("#new-project-browse")?.addEventListener("click", async () => {
        const picked = await invoke<string | null>("pick_folder");
        if (picked) {
          parentFolder = picked;
          render();
        }
      });

      overlay.querySelector("#new-project-cancel")?.addEventListener("click", () => finish(null));
      overlay.querySelector("#new-project-create")?.addEventListener("click", () => { void submit(); });
      overlay.querySelector(".new-project-backdrop")?.addEventListener("click", () => finish(null));
    };

    async function submit() {
      const name = projectName.trim();
      if (!name || !parentFolder) return;
      const sep = parentFolder.includes("\\") ? "\\" : "/";
      const fullPath = `${parentFolder}${sep}${name}`;
      try {
        await invoke("create_folder", { path: fullPath });
      } catch (e) {
        alert(`Could not create folder: ${e}`);
        return;
      }
      await saveLastParent(parentFolder);
      finish({ path: fullPath, name });
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") finish(null);
    }
    document.addEventListener("keydown", onKey);

    // Pre-fill last parent, then render.
    readLastParent().then((last) => {
      parentFolder = last;
      render();
    });
  });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
