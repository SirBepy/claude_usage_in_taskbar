import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import "./projects.css";
import { setTokenHistory } from "../../shared/state";
import { openProjectDetail } from "../../shared/navigation";
import { renderAvatar, escapeProjHtml, type Avatar } from "../../shared/projects";
import { formatTokens } from "../../shared/tokens";
import { timeAgo } from "../../shared/time";
import { api, type ProjectGroup } from "../../shared/api";

export function projectCardHtml(g: ProjectGroup): string {
  const displayName = g.parent_segment ? `${g.name} · ${g.parent_segment}` : g.name;
  const avatar = renderAvatar(g.avatar as Avatar);
  const tokens = formatTokens(Number(g.tokens_7d) || 0);
  const lastSeen = g.last_active_at ? timeAgo(g.last_active_at) : "";
  const tags = [
    g.live ? `<span class="card-tag live">● ${g.live}</span>` : "",
    g.any_remote ? `<span class="card-tag remote">📱</span>` : "",
    g.any_automated ? `<span class="card-tag automated">⚙</span>` : "",
  ].filter(Boolean).join(" ");
  return `
    <div class="project-card" data-cwd="${escapeProjHtml(g.path)}" data-project-id="${g.id || ""}">
      <div class="avatar">${avatar}</div>
      <div class="body">
        <div class="name">${escapeProjHtml(displayName)}${tags ? ` <span class="card-tags">${tags}</span>` : ""}</div>
        <div class="tokens">${tokens} tokens${lastSeen ? ` · ${lastSeen}` : ""}</div>
      </div>
    </div>
  `;
}

function setupBackfillBtn(): void {
  const btn = document.getElementById("backfillBtn") as (HTMLButtonElement & { _hooked?: boolean }) | null;
  const status = document.getElementById("backfill-status");
  if (!btn || btn._hooked) return;
  btn._hooked = true;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Scanning...";
    if (status) { status.style.display = "block"; status.textContent = "This may take a while…"; }
    try {
      const result = await api.backfillTranscripts();
      const msg = result ? `Done - ${result.processed} new, ${result.skipped} skipped` : "Done";
      if (status) status.textContent = msg;
      const fresh = await api.getTokenHistory();
      setTokenHistory(fresh ?? null);
      await renderProjectsList();
    } catch (e) {
      if (status) status.textContent = "Error: " + (e as Error).message;
    } finally {
      btn.disabled = false;
      btn.textContent = "↺ Rebuild History";
    }
  };
}

// Re-exported from shared/navigation — imported at top of file.

export async function renderProjectsList(): Promise<void> {
  let groups: ProjectGroup[] = [];
  try {
    groups = (await api.listProjectGroups()) as ProjectGroup[];
  } catch (e) {
    console.error("listProjectGroups failed", e);
  }

  const settingsForSort = (await api.getSettings()) || {};
  const sortBy = (settingsForSort as { projects_sort_by?: string }).projects_sort_by || "recent";
  const lastMs = (g: ProjectGroup): number => g.last_active_at ? Date.parse(g.last_active_at) || 0 : 0;
  const nameOf = (g: ProjectGroup): string => (g.name || "").toLowerCase();
  const entries = [...groups].sort((a, b) => {
    switch (sortBy) {
      case "name": return nameOf(a).localeCompare(nameOf(b));
      case "live":
        if ((b.live || 0) !== (a.live || 0)) return (b.live || 0) - (a.live || 0);
        return lastMs(b) - lastMs(a);
      case "tokens": return Number(b.tokens_7d || 0) - Number(a.tokens_7d || 0);
      case "recent":
      default: return lastMs(b) - lastMs(a);
    }
  });

  const container = document.getElementById("projects-list");
  const empty = document.getElementById("projects-empty");
  if (!container || !empty) return;
  if (entries.length === 0) {
    container.innerHTML = "";
    empty.style.display = "block";
    setupBackfillBtn();
    return;
  }
  empty.style.display = "none";

  container.innerHTML = entries.map((g) => projectCardHtml(g)).join("");
  container.querySelectorAll<HTMLElement>(".project-card").forEach((el) => {
    el.onclick = () => {
      const cwd = el.dataset.cwd;
      if (cwd) openProjectDetail(cwd);
    };
  });

  setupBackfillBtn();
}

export function refreshProjectsUI(): void {
  void renderProjectsList();
}

// Back-compat window bindings for any remaining legacy callers.
(window as unknown as { renderProjectsList?: () => Promise<void> }).renderProjectsList = renderProjectsList;
(window as unknown as { refreshProjectsUI?: () => void }).refreshProjectsUI = refreshProjectsUI;

export async function renderProjectsView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  const select = root.querySelector<HTMLSelectElement>("#projectsSortSelect");
  if (select) {
    try {
      const s = (await api.getSettings()) || {};
      select.value = (s as { projects_sort_by?: string }).projects_sort_by || "recent";
    } catch { /* ignore */ }
    select.addEventListener("change", async () => {
      await api.setProjectsSortBy(select.value);
      await renderProjectsList();
    });
  }

  await renderProjectsList();

  const unsubHistory = api.onHistoryUpdated(() => { void renderProjectsList(); });
  const unsubTokens = api.onTokenHistoryUpdated(() => { void renderProjectsList(); });
  const unsubInstances = api.onInstancesChanged(() => { void renderProjectsList(); });

  return () => {
    try { unsubHistory(); } catch { /* ignore */ }
    try { unsubTokens(); } catch { /* ignore */ }
    try { unsubInstances(); } catch { /* ignore */ }
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
