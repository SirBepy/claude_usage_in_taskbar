import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import "./projects.css";

interface LegacyGlobals {
  electronAPI?: {
    getSettings(): Promise<{ projects_sort_by?: string } | null>;
    setProjectsSortBy(sortBy: string): Promise<unknown>;
    onHistoryUpdated(cb: () => void): () => void;
    onTokenHistoryUpdated(cb: () => void): () => void;
    onInstancesChanged(cb: () => void): () => void;
  };
  renderProjectsList(): Promise<void> | void;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

export async function renderProjectsView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  const select = root.querySelector<HTMLSelectElement>("#projectsSortSelect");
  if (select) {
    try {
      const s = (await g().electronAPI?.getSettings()) || {};
      select.value = s.projects_sort_by || "recent";
    } catch { /* ignore */ }
    select.addEventListener("change", async () => {
      await g().electronAPI?.setProjectsSortBy(select.value);
      await g().renderProjectsList();
    });
  }

  await g().renderProjectsList();

  const api = g().electronAPI;
  const unsubHistory = api?.onHistoryUpdated(() => {
    void g().renderProjectsList();
  });
  const unsubTokens = api?.onTokenHistoryUpdated(() => {
    void g().renderProjectsList();
  });
  const unsubInstances = api?.onInstancesChanged(() => {
    void g().renderProjectsList();
  });

  return () => {
    try { unsubHistory?.(); } catch { /* ignore */ }
    try { unsubTokens?.(); } catch { /* ignore */ }
    try { unsubInstances?.(); } catch { /* ignore */ }
  };
}

function template() {
  return html`
    <div class="view view-projects">
      <div class="view-header">
        <button
          class="icon-btn burger"
          title="Menu"
          data-burger="true"
          @click=${openSidemenu}
        >
          <i class="ph ph-list"></i>
        </button>
        <h2>Projects</h2>
        <div class="projects-sort">
          <label for="projectsSortSelect" class="projects-sort-label">Sort by</label>
          <select id="projectsSortSelect" class="projects-sort-select">
            <option value="recent">Recently used</option>
            <option value="live">Running instances</option>
            <option value="name">Name</option>
            <option value="tokens">Tokens used</option>
          </select>
        </div>
      </div>
      <div class="view-body">
        <div id="projects-empty" class="no-data" style="display:none">
          No projects yet.
        </div>
        <div id="projects-list" class="projects-list"></div>
        <div style="margin-top:14px">
          <button
            class="btn-secondary"
            id="backfillBtn"
            style="width:100%;font-size:0.8rem"
          >
            ↺ Rebuild History
          </button>
          <div
            id="backfill-status"
            style="text-align:center;font-size:0.72rem;color:var(--text-dim);margin-top:6px;display:none"
          ></div>
        </div>
      </div>
    </div>
  `;
}
