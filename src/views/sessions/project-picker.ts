import { html, render } from "lit-html";
import { invoke } from "../../shared/ipc";
import { ensureModalHost, closeModal } from "../../shared/modal";
import type { ProjectGroup } from "../../types/ipc.generated";
import { openNewProjectModal, isNewProjectModalOpen } from "./new-project-modal";

export type SortChoice = "name" | "recent";
export const SORT_STORAGE_KEY = "claude_companion_sessions_modal_sort";

export function readStoredSort(): SortChoice {
  try {
    const v = localStorage.getItem(SORT_STORAGE_KEY);
    if (v === "name" || v === "recent") return v;
  } catch { /* localStorage may throw in private mode; ignore */ }
  return "name";
}

export function writeStoredSort(choice: SortChoice): void {
  try { localStorage.setItem(SORT_STORAGE_KEY, choice); }
  catch { /* ignore */ }
}

export async function pickProject(): Promise<{ path: string; name: string } | null> {
  let projects: ProjectGroup[] = [];
  try {
    projects = (await invoke<ProjectGroup[]>("list_project_groups")) || [];
  } catch (err) {
    console.error("[sessions] list_project_groups failed", err);
  }
  if (!projects.length) {
    alert("No projects detected yet. Run claude in a folder first or add a project.");
    return null;
  }

  // Fetch latest .jsonl mtime per project for the "Most recent" sort.
  // Best-effort: failures fall back to 0 (sorts to bottom).
  const mtimes = await Promise.all(
    projects.map((p) =>
      invoke<number>("project_last_activity_at", { cwd: p.path })
        .catch(() => 0),
    ),
  );

  return openProjectPickerModal(projects, mtimes);
}

export function openProjectPickerModal(
  projects: ProjectGroup[],
  mtimes: number[],
): Promise<{ path: string; name: string } | null> {
  return new Promise((resolve) => {
    const host = ensureModalHost();
    let resolved = false;
    const finish = (val: { path: string; name: string } | null) => {
      if (resolved) return;
      resolved = true;
      closeModal();
      resolve(val);
    };

    let sort: SortChoice = readStoredSort();
    let filter = "";
    // Keyboard-navigable highlight. Always points at a row in the current
    // filtered/sorted `computeRows()` output. Reset to 0 whenever filter or
    // sort changes (top of the new list).
    let selectedIdx = 0;

    const computeRows = (): ProjectGroup[] => {
      const f = filter.trim().toLowerCase();
      let rows = projects.filter((p) =>
        !f
        || p.name.toLowerCase().includes(f)
        || p.path.toLowerCase().includes(f)
      );
      if (sort === "name") {
        rows = rows.slice().sort((a, b) => a.name.localeCompare(b.name));
      } else {
        // "recent": use mtimes index lookup. Items with mtime=0 sort last.
        rows = rows.slice().sort((a, b) => {
          const ai = projects.indexOf(a);
          const bi = projects.indexOf(b);
          const am = mtimes[ai] ?? 0;
          const bm = mtimes[bi] ?? 0;
          return bm - am;
        });
      }
      return rows;
    };

    const renderModal = () => {
      const rows = computeRows();
      const tpl = html`
        <div class="modal-backdrop" @click=${() => finish(null)}></div>
        <div
          class="modal-card project-picker-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Pick project"
        >
          <header class="modal-header">
            <h3>Pick project</h3>
            <select
              class="project-picker-sort"
              .value=${sort}
              @change=${(e: Event) => {
                const v = (e.target as HTMLSelectElement).value;
                if (v === "name" || v === "recent") {
                  sort = v;
                  writeStoredSort(sort);
                  selectedIdx = 0;
                  renderModal();
                }
              }}
            >
              <option value="name">Name (A-Z)</option>
              <option value="recent">Most recent</option>
            </select>
          </header>
          <div class="modal-body project-picker-body">
            <input
              id="project-picker-search"
              class="project-picker-search"
              type="text"
              autocomplete="off"
              placeholder="Search projects..."
              .value=${filter}
              @input=${(e: Event) => {
                filter = (e.target as HTMLInputElement).value;
                selectedIdx = 0;
                renderModal();
              }}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Escape") {
                  if (filter !== "") {
                    e.preventDefault();
                    e.stopPropagation();
                    filter = "";
                    selectedIdx = 0;
                    renderModal();
                  } else {
                    finish(null);
                  }
                } else if (e.key === "Enter") {
                  const matches = computeRows();
                  if (matches.length > 0) {
                    e.preventDefault();
                    const idx = Math.min(selectedIdx, matches.length - 1);
                    const m = matches[idx]!;
                    finish({ path: m.path, name: m.name });
                  }
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  const matches = computeRows();
                  if (matches.length > 0) {
                    selectedIdx = Math.min(selectedIdx + 1, matches.length - 1);
                    renderModal();
                  }
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  const matches = computeRows();
                  if (matches.length > 0) {
                    selectedIdx = Math.max(selectedIdx - 1, 0);
                    renderModal();
                  }
                } else if (e.key === "Home") {
                  e.preventDefault();
                  selectedIdx = 0;
                  renderModal();
                } else if (e.key === "End") {
                  e.preventDefault();
                  const matches = computeRows();
                  if (matches.length > 0) {
                    selectedIdx = matches.length - 1;
                    renderModal();
                  }
                }
              }}
            />
            <ul class="project-picker-list">
              ${rows.length === 0
                ? html`<li class="project-picker-empty">No matches</li>`
                : rows.map(
                    (p, i) => html`
                      <li
                        class="project-picker-row ${i === Math.min(selectedIdx, rows.length - 1) ? "selected" : ""}"
                        data-row-idx=${i}
                        @mouseenter=${() => {
                          if (selectedIdx !== i) {
                            selectedIdx = i;
                            renderModal();
                          }
                        }}
                        @click=${() => finish({ path: p.path, name: p.name })}
                      >
                        <span class="project-picker-name">${p.name}</span>
                        <span class="project-picker-path">${p.path}</span>
                      </li>
                    `,
                  )}
            </ul>
          </div>
          <footer class="modal-footer">
            <button
              class="btn btn-secondary btn-new-folder"
              @click=${async () => {
                if (isNewProjectModalOpen()) return;
                host.classList.remove("open");
                const result = await openNewProjectModal();
                if (!result) {
                  host.classList.add("open");
                  renderModal();
                  return;
                }
                finish(result);
              }}
            >
              <i class="ph ph-folder-plus"></i> New project&hellip;
            </button>
            <button
              class="btn btn-secondary btn-new-folder"
              @click=${async () => {
                const picked = await invoke<string | null>("pick_folder");
                if (!picked) return;
                const name = picked.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? picked;
                finish({ path: picked, name });
              }}
            >
              <i class="ph ph-folder-open"></i> Open in new folder&hellip;
            </button>
            <button class="btn btn-secondary" @click=${() => finish(null)}>Cancel</button>
          </footer>
        </div>
      `;
      render(tpl, host);
      // Autofocus the search input on first render. Re-focus on subsequent
      // renders only if focus was already inside the modal (avoid stealing
      // focus from the dropdown).
      const input = host.querySelector<HTMLInputElement>("#project-picker-search");
      const active = document.activeElement;
      const focusIsInsideModal = active instanceof HTMLElement && host.contains(active);
      if (input && !focusIsInsideModal) {
        // Defer to next tick so lit-html finishes attaching DOM.
        setTimeout(() => input.focus(), 0);
      }
      // Keep the selected row visible when keyboard nav scrolls past the
      // viewport edge. block: "nearest" avoids unnecessary jumps when the
      // row is already fully visible.
      const selectedEl = host.querySelector<HTMLElement>(".project-picker-row.selected");
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: "nearest" });
      }
    };

    host.classList.add("open");
    renderModal();
  });
}
