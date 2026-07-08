// Settings > Accounts edit modal: rename/recolour/re-icon plus the
// projects-bound-to-this-account list, both in one place (replaces the old
// inline edit panel + chevron-expand row, 2026-07-08 UI pass). Icon/colour
// picker mirrors add-account-wizard.ts's finalize step; the projects tab
// mirrors accounts.ts's old refreshAccountProjects bind/unbind flow.

import { escapeHtml } from "../../../../shared/escape-html";
import { api } from "../../../../shared/api";
import type { Account } from "../../../../shared/api";
import type { ProjectConfig } from "../../../../types/ipc.generated";
import { pickProject } from "../../../sessions/project-picker";
import { ICON_POOL, COLOUR_POOL } from "./wizard-logic";
import "./edit-account-modal.css";

type Tab = "details" | "projects";

/** Opens the edit modal for an existing account; resolves with the updated
 * `Account` on Save, or `null` on Cancel/close (project bindings changed via
 * the Projects tab persist immediately regardless - only label/icon/colour
 * are staged until Save, matching the old inline panel's behaviour). */
export function openEditAccountModal(account: Account): Promise<Account | null> {
  return new Promise<Account | null>((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "aem-overlay";

    let tab: Tab = "details";
    let label = account.label;
    let icon = account.icon;
    let colour = account.colour;
    let busy = false;
    let error: string | null = null;
    let projects: ProjectConfig[] = [];
    let projectsLoaded = false;

    function close(result: Account | null): void {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
    }
    document.addEventListener("keydown", onKey);

    async function loadProjects(): Promise<void> {
      try {
        const all = (await api.listProjects()) as unknown as ProjectConfig[];
        projects = all.filter((p) => p.preferred_account_id === account.id);
      } catch (e) {
        console.error("[edit-account-modal] listProjects failed", e);
      }
      projectsLoaded = true;
      render();
    }

    async function unbindProject(projectId: string): Promise<void> {
      try {
        await api.updateProject(projectId, { preferred_account_id: null });
        await loadProjects();
      } catch (e) { console.error("[edit-account-modal] unbind failed", e); }
    }

    async function bindAnotherProject(): Promise<void> {
      const picked = await pickProject();
      if (!picked) return;
      try {
        const proj = await api.ensureProject(picked.path);
        await api.updateProject(proj.id, { preferred_account_id: account.id });
        await loadProjects();
      } catch (e) { console.error("[edit-account-modal] bind failed", e); }
    }

    async function doSave(): Promise<void> {
      const trimmed = label.trim();
      if (!trimmed) return;
      busy = true;
      error = null;
      render();
      try {
        const updated = await api.updateAccount(account.id, { label: trimmed, icon, colour });
        close(updated);
      } catch (e) {
        busy = false;
        error = e instanceof Error ? e.message : String(e);
        render();
      }
    }

    function detailsTabHtml(): string {
      const customColour = !COLOUR_POOL.includes(colour as (typeof COLOUR_POOL)[number]);
      return `
        <div class="field">
          <label>Label</label>
          <input class="fake-input" id="aem-label" type="text" value="${escapeHtml(label)}">
        </div>
        <div class="field">
          <label>Icon</label>
          <div class="icon-grid">
            ${ICON_POOL.map((i) => `<button type="button" class="icon-tile${i === icon ? " sel" : ""}" data-icon="${escapeHtml(i)}"><i class="ph ph-${escapeHtml(i)}"></i></button>`).join("")}
          </div>
        </div>
        <div class="field">
          <label>Colour</label>
          <div class="swatches">
            ${COLOUR_POOL.map((c) => `<span class="swatch${c === colour ? " sel" : ""}" data-colour="${escapeHtml(c)}" style="background:${escapeHtml(c)}"></span>`).join("")}
            <label class="swatch custom${customColour ? " sel" : ""}" title="Custom colour" ${customColour ? `style="background:${escapeHtml(colour)}"` : ""}>
              <i class="ph ph-eyedropper"></i>
              <input type="color" id="aem-custom-colour" value="${escapeHtml(customColour ? colour : "#8888ff")}">
            </label>
          </div>
        </div>
        ${error ? `<div class="aem-error"><i class="ph ph-warning-circle"></i> ${escapeHtml(error)}</div>` : ""}
      `;
    }

    function projectRowHtml(p: ProjectConfig): string {
      return `
        <div class="rev-item" data-id="${escapeHtml(p.id)}">
          <i class="ph ph-folder f"></i>
          <span class="p">${escapeHtml(p.path)}</span>
          <i class="ph ph-x x" data-id="${escapeHtml(p.id)}" title="Stop using this account for this project"></i>
        </div>
      `;
    }

    function projectsTabHtml(): string {
      if (!projectsLoaded) return `<p class="rev-empty">Loading...</p>`;
      return `
        ${projects.length === 0 ? `<p class="rev-empty">No projects bound to this account yet.</p>` : projects.map(projectRowHtml).join("")}
        <button class="rev-add-btn" id="aem-add-project"><i class="ph ph-plus"></i> Add a project</button>
      `;
    }

    function render(): void {
      overlay.innerHTML = `
        <div class="aem-modal" style="--acc:${escapeHtml(colour)}" role="dialog" aria-modal="true" aria-label="Edit ${escapeHtml(account.label)}">
          <div class="aem-head">
            <span class="t">Edit ${escapeHtml(account.label)}</span>
            <button class="aem-close" id="aem-close-btn" title="Close" aria-label="Close"><i class="ph ph-x"></i></button>
          </div>
          <div class="aem-tabs">
            <button class="aem-tab${tab === "details" ? " active" : ""}" data-tab="details">Details</button>
            <button class="aem-tab${tab === "projects" ? " active" : ""}" data-tab="projects">Projects${projectsLoaded ? ` (${projects.length})` : ""}</button>
          </div>
          <div class="aem-body">
            ${tab === "details" ? detailsTabHtml() : projectsTabHtml()}
          </div>
          <div class="aem-actions">
            <button class="btn-secondary" id="aem-cancel-btn">Cancel</button>
            <button class="btn-primary" id="aem-save-btn" ${busy || !label.trim() ? "disabled" : ""}>
              ${busy ? `<i class="ph ph-spinner aem-spin"></i> Saving...` : "Save"}
            </button>
          </div>
        </div>
      `;
      attach();
    }

    function attach(): void {
      overlay.querySelector<HTMLButtonElement>("#aem-close-btn")?.addEventListener("click", () => close(null));
      overlay.querySelector<HTMLButtonElement>("#aem-cancel-btn")?.addEventListener("click", () => close(null));
      overlay.querySelector<HTMLButtonElement>("#aem-save-btn")?.addEventListener("click", () => void doSave());

      overlay.querySelectorAll<HTMLButtonElement>(".aem-tab").forEach((tabBtn) => {
        tabBtn.addEventListener("click", () => {
          tab = tabBtn.dataset.tab === "projects" ? "projects" : "details";
          if (tab === "projects" && !projectsLoaded) void loadProjects();
          render();
        });
      });

      if (tab === "details") {
        const labelEl = overlay.querySelector<HTMLInputElement>("#aem-label");
        labelEl?.addEventListener("input", () => {
          label = labelEl.value;
          const saveBtn = overlay.querySelector<HTMLButtonElement>("#aem-save-btn");
          if (saveBtn) saveBtn.disabled = busy || !label.trim();
        });
        overlay.querySelectorAll<HTMLButtonElement>(".icon-tile").forEach((t) => {
          t.addEventListener("click", () => { icon = t.dataset.icon ?? icon; render(); });
        });
        overlay.querySelectorAll<HTMLElement>(".swatch[data-colour]").forEach((sw) => {
          sw.addEventListener("click", () => { colour = sw.dataset.colour ?? colour; render(); });
        });
        const customEl = overlay.querySelector<HTMLInputElement>("#aem-custom-colour");
        customEl?.addEventListener("input", () => {
          colour = customEl.value;
          overlay.querySelector<HTMLElement>(".aem-modal")?.style.setProperty("--acc", colour);
          overlay.querySelectorAll<HTMLElement>(".swatch").forEach((sw) => sw.classList.remove("sel"));
          const custom = customEl.closest<HTMLElement>(".swatch.custom");
          if (custom) { custom.classList.add("sel"); custom.style.background = colour; }
        });
        customEl?.addEventListener("change", () => { colour = customEl.value; render(); });
      } else {
        overlay.querySelectorAll<HTMLElement>(".rev-item .x").forEach((x) => {
          x.addEventListener("click", () => {
            const id = x.dataset.id;
            if (id) void unbindProject(id);
          });
        });
        overlay.querySelector<HTMLButtonElement>("#aem-add-project")?.addEventListener("click", () => void bindAnotherProject());
      }
    }

    document.body.appendChild(overlay);
    render();
  });
}
